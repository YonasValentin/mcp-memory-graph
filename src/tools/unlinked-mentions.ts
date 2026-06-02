import type Database from 'better-sqlite3';
import type { EmbeddingProvider } from '../types.js';
import { findUnlinkedMentions } from '../graph/unlinked-mentions.js';

interface MentionSummary {
  id: string;
  title: string | null;
  snippet: string;
  similarity: number;
  shared_entities: string[];
}

/**
 * memory_unlinked_mentions (P2.1): surface memories semantically near the given
 * one that the agent has NOT explicitly linked — automated, vectorized
 * "unlinked mentions". Returns lightweight summaries ranked by similarity.
 */
export async function handleUnlinkedMentions(
  db: Database.Database,
  embedder: EmbeddingProvider,
  input: { id: string; limit: number; min_similarity: number },
): Promise<{ mentions: MentionSummary[]; count: number }> {
  const found = await findUnlinkedMentions(db, embedder, input.id, {
    limit: input.limit,
    minSimilarity: input.min_similarity,
  });

  const mentions = found.map((m) => ({
    id: m.memory.id,
    title: m.memory.title,
    snippet: m.memory.content.slice(0, 200),
    similarity: Number(m.similarity.toFixed(4)),
    shared_entities: m.shared_entities,
  }));

  return { mentions, count: mentions.length };
}
