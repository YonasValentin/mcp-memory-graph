import type { EmbeddingProvider } from './provider.js';

/**
 * M6.4 (R8) — an {@link EmbeddingProvider} backed by a local Ollama HTTP
 * endpoint (`POST /api/embed`). `fetch` is INJECTABLE so the unit tests never
 * touch the network.
 *
 * Ollama's `/api/embed` accepts `input: string | string[]` and returns
 * `{ embeddings: number[][] }` (one row per input). It also accepts a native
 * `dimensions` parameter for Matryoshka models (e.g. embeddinggemma), which we
 * forward so the endpoint can truncate server-side to the DB dimension; we
 * still validate the returned dimension defensively because `memories_vec`
 * hard-throws on a mismatch (see registry.ts and db/schema.ts).
 *
 * PRIVACY: this provider may point at a REMOTE host, so the router
 * ({@link import('./registry.js').selectEmbedder}) must never select it for
 * confidential/restricted memories.
 */
export interface OllamaProviderOptions {
  /** Ollama model name, e.g. `all-minilm` or `embeddinggemma`. */
  model: string;
  /** The DB embedding dimension this provider must produce. */
  dimensions: number;
  /** Ollama base URL. Defaults to the local daemon. */
  baseUrl?: string;
  /** Injected fetch (tests pass a mock; production passes global `fetch`). */
  fetchImpl?: typeof fetch;
}

interface OllamaEmbedResponse {
  model?: string;
  embeddings?: number[][];
}

const DEFAULT_BASE_URL = 'http://localhost:11434';

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly modelName: string;
  readonly dimensions: number;

  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private ready = false;

  constructor(opts: OllamaProviderOptions) {
    this.modelName = opts.model;
    this.dimensions = opts.dimensions;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async initialize(): Promise<void> {
    // No model to load locally — the daemon owns the model. Marking ready lets
    // callers treat this uniformly with the in-process providers.
    this.ready = true;
  }

  isReady(): boolean {
    return this.ready;
  }

  async embed(text: string): Promise<Float32Array> {
    const [vec] = await this.request(text);
    // An empty `embeddings: []` array passes request()'s per-row dimension check
    // (it never iterates), so guard here — never return undefined as a vector.
    if (!vec) throw new Error('Ollama returned no embedding for the input.');
    return vec;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    return this.request(texts);
  }

  /** Single POST to /api/embed; returns one Float32Array per input. */
  private async request(input: string | string[]): Promise<Float32Array[]> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.modelName,
        input,
        // Matryoshka: ask the daemon to emit exactly our DB dimension.
        dimensions: this.dimensions,
      }),
    });

    if (!res.ok) {
      const detail = await this.safeText(res);
      throw new Error(
        `Ollama embed request failed (HTTP ${res.status})${detail ? `: ${detail}` : ''}`,
      );
    }

    const body = (await res.json()) as OllamaEmbedResponse;
    if (!Array.isArray(body.embeddings)) {
      throw new Error(
        'Ollama embed response is missing the "embeddings" array.',
      );
    }

    return body.embeddings.map((row) => {
      if (!Array.isArray(row) || row.length !== this.dimensions) {
        throw new Error(
          `Ollama returned an embedding of dimension ${Array.isArray(row) ? row.length : 'n/a'}, ` +
            `expected ${this.dimensions}.`,
        );
      }
      return Float32Array.from(row);
    });
  }

  private async safeText(res: { text?: () => Promise<string> }): Promise<string> {
    try {
      return (await res.text?.())?.slice(0, 200) ?? '';
    } catch {
      return '';
    }
  }
}
