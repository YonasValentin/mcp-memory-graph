// ── Claude Tool-Use Integration Client ────────────────────────────────────
//
// A client that connects Claude to your PureGate Knowledge base.
// Claude can search, read, and navigate your organization's documents
// using tool_use (function calling).
//
// Usage:
//   import { createKnowledgeAssistant } from './claude-client/index.js';
//   const assistant = createKnowledgeAssistant({ apiKey, knowledgeBaseUrl, authToken });
//   const answer = await assistant.ask("What is our refund policy?");

export interface KnowledgeAssistantConfig {
  /** Anthropic API key */
  claudeApiKey: string;
  /** PureGate Knowledge API base URL */
  knowledgeBaseUrl: string;
  /** JWT or API key for the knowledge base */
  knowledgeAuthToken: string;
  /** Claude model to use */
  model?: string;
  /** System prompt prepended to all conversations */
  systemPrompt?: string;
  /** Max tokens for Claude response */
  maxTokens?: number;
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

// ── Tool Definitions for Claude ──────────────────────────────────────────

const KNOWLEDGE_TOOLS = [
  {
    name: 'search_knowledge',
    description: 'Search the organization knowledge base using semantic and keyword search. Use this to find relevant documents, policies, decisions, and information.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Search query - can be natural language or specific keywords',
        },
        department: {
          type: 'string',
          description: 'Filter by department (e.g., legal, engineering, hr, sales, finance)',
        },
        document_type: {
          type: 'string',
          description: 'Filter by document type (e.g., contract, policy, code, report, decision)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default: 5)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_document',
    description: 'Retrieve a specific document or memory by its ID. Use this when you have a specific document ID from search results and need to see the full content.',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: {
          type: 'string',
          description: 'The document/memory ID to retrieve',
        },
        include_chunks: {
          type: 'boolean',
          description: 'Whether to include all chunks of the document (default: true)',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'list_documents',
    description: 'Browse and list documents in the knowledge base with optional filters. Use this to see what documents are available.',
    input_schema: {
      type: 'object' as const,
      properties: {
        department: {
          type: 'string',
          description: 'Filter by department',
        },
        document_type: {
          type: 'string',
          description: 'Filter by document type',
        },
        scope: {
          type: 'string',
          enum: ['global', 'project', 'user', 'team', 'department'],
          description: 'Filter by scope',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default: 10)',
        },
        sort_by: {
          type: 'string',
          enum: ['created_at', 'updated_at', 'title'],
          description: 'Sort field',
        },
      },
    },
  },
  {
    name: 'find_related',
    description: 'Find documents related to a specific document. Use this to discover connections between documents and explore related knowledge.',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: {
          type: 'string',
          description: 'The document ID to find related documents for',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of related documents (default: 5)',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'get_stats',
    description: 'Get statistics about the knowledge base - total documents, breakdowns by department and type.',
    input_schema: {
      type: 'object' as const,
      properties: {
        department: {
          type: 'string',
          description: 'Optional department to get stats for',
        },
      },
    },
  },
];

// ── Knowledge Base API Client ────────────────────────────────────────────

class KnowledgeBaseClient {
  private baseUrl: string;
  private authToken: string;

  constructor(baseUrl: string, authToken: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.authToken = authToken;
  }

  private async request(method: string, path: string, body?: unknown): Promise<any> {
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      method,
      headers: {
        'Authorization': `Bearer ${this.authToken}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Knowledge API error ${response.status}: ${error}`);
    }

    return response.json();
  }

  async search(query: string, options?: { department?: string; document_type?: string; limit?: number }): Promise<any> {
    return this.request('POST', '/api/v1/memories/search', {
      query,
      department: options?.department,
      document_type: options?.document_type,
      limit: options?.limit ?? 5,
      search_mode: 'hybrid',
    });
  }

  async getDocument(id: string, includeChunks: boolean = true): Promise<any> {
    return this.request('GET', `/api/v1/memories/${id}?include_chunks=${includeChunks}`);
  }

  async listDocuments(options?: { department?: string; document_type?: string; scope?: string; limit?: number; sort_by?: string }): Promise<any> {
    const params = new URLSearchParams();
    if (options?.department) params.set('department', options.department);
    if (options?.document_type) params.set('document_type', options.document_type);
    if (options?.scope) params.set('scope', options.scope);
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.sort_by) params.set('sort_by', options.sort_by);
    return this.request('GET', `/api/v1/memories?${params.toString()}`);
  }

  async findRelated(id: string, limit: number = 5): Promise<any> {
    return this.request('GET', `/api/v1/memories/${id}/related?limit=${limit}`);
  }

  async getStats(department?: string): Promise<any> {
    const params = department ? `?department=${department}` : '';
    return this.request('GET', `/api/v1/stats${params}`);
  }
}

// ── Tool Execution ───────────────────────────────────────────────────────

async function executeTool(
  kb: KnowledgeBaseClient,
  toolName: string,
  toolInput: Record<string, any>,
): Promise<string> {
  try {
    let result: any;

    switch (toolName) {
      case 'search_knowledge':
        result = await kb.search(toolInput.query, {
          department: toolInput.department,
          document_type: toolInput.document_type,
          limit: toolInput.limit,
        });
        break;

      case 'get_document':
        result = await kb.getDocument(toolInput.id, toolInput.include_chunks ?? true);
        break;

      case 'list_documents':
        result = await kb.listDocuments({
          department: toolInput.department,
          document_type: toolInput.document_type,
          scope: toolInput.scope,
          limit: toolInput.limit,
          sort_by: toolInput.sort_by,
        });
        break;

      case 'find_related':
        result = await kb.findRelated(toolInput.id, toolInput.limit);
        break;

      case 'get_stats':
        result = await kb.getStats(toolInput.department);
        break;

      default:
        return JSON.stringify({ error: `Unknown tool: ${toolName}` });
    }

    return JSON.stringify(result, null, 2);
  } catch (err) {
    return JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Knowledge Assistant ──────────────────────────────────────────────────

export class KnowledgeAssistant {
  private config: KnowledgeAssistantConfig;
  private kb: KnowledgeBaseClient;
  private conversationHistory: any[] = [];

  constructor(config: KnowledgeAssistantConfig) {
    this.config = config;
    this.kb = new KnowledgeBaseClient(config.knowledgeBaseUrl, config.knowledgeAuthToken);
  }

  /**
   * Ask a question and get an answer grounded in your organization's knowledge.
   * Claude will automatically search, read documents, and synthesize an answer.
   */
  async ask(question: string): Promise<string> {
    this.conversationHistory.push({
      role: 'user',
      content: question,
    });

    return this.runConversation();
  }

  /**
   * Continue the conversation with follow-up questions.
   */
  async followUp(message: string): Promise<string> {
    return this.ask(message);
  }

  /**
   * Reset conversation history.
   */
  reset(): void {
    this.conversationHistory = [];
  }

  private async runConversation(): Promise<string> {
    const maxIterations = 10; // Prevent infinite tool-use loops

    for (let i = 0; i < maxIterations; i++) {
      const response = await this.callClaude();

      // Check if Claude wants to use tools
      const toolUseBlocks = response.content.filter((b: any) => b.type === 'tool_use');

      if (toolUseBlocks.length === 0) {
        // Claude is done - extract text response
        const textBlocks = response.content.filter((b: any) => b.type === 'text');
        const answer = textBlocks.map((b: any) => b.text).join('\n');

        this.conversationHistory.push({
          role: 'assistant',
          content: response.content,
        });

        return answer;
      }

      // Add assistant message with tool_use to history
      this.conversationHistory.push({
        role: 'assistant',
        content: response.content,
      });

      // Execute all tool calls and add results
      const toolResults: any[] = [];
      for (const toolUse of toolUseBlocks) {
        const result = await executeTool(this.kb, toolUse.name, toolUse.input);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: result,
        });
      }

      this.conversationHistory.push({
        role: 'user',
        content: toolResults,
      });
    }

    return 'I was unable to complete the search within the iteration limit. Please try a more specific question.';
  }

  private async callClaude(): Promise<any> {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': this.config.claudeApiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.config.model ?? 'claude-sonnet-4-20250514',
        max_tokens: this.config.maxTokens ?? 4096,
        system: this.config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
        tools: KNOWLEDGE_TOOLS,
        messages: this.conversationHistory,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Claude API error ${response.status}: ${error}`);
    }

    return response.json();
  }
}

const DEFAULT_SYSTEM_PROMPT = `You are a knowledgeable AI assistant for this organization. You have access to the organization's internal knowledge base containing documents, policies, decisions, and other important information.

When answering questions:
1. ALWAYS search the knowledge base first before answering questions about the organization
2. Cite specific documents when possible (mention the document title and ID)
3. If you find relevant information, synthesize it into a clear answer
4. If you cannot find relevant information, say so honestly
5. Use find_related to discover connected documents when exploring a topic
6. You can list_documents to browse what's available

Be helpful, accurate, and always ground your answers in the actual documents from the knowledge base.`;

// ── Factory Function ─────────────────────────────────────────────────────

export function createKnowledgeAssistant(config: KnowledgeAssistantConfig): KnowledgeAssistant {
  return new KnowledgeAssistant(config);
}

// ── Quick Chat Function ──────────────────────────────────────────────────

/**
 * One-shot question answering against the knowledge base.
 * Creates a fresh assistant, asks the question, and returns the answer.
 */
export async function askKnowledge(
  question: string,
  config: KnowledgeAssistantConfig,
): Promise<string> {
  const assistant = createKnowledgeAssistant(config);
  return assistant.ask(question);
}
