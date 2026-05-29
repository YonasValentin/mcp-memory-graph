import type Database from 'better-sqlite3';
import {
  summarizeCommunities,
  type CommunitySummary,
} from '../graph/communities.js';

interface CommunitiesInput {
  /** Max communities to return (largest first). */
  limit?: number;
  /** Drop communities with fewer than this many entities. */
  min_size?: number;
}

interface CommunitiesResult {
  communities: CommunitySummary[];
  total_communities: number;
  instruction: string;
}

/**
 * GraphRAG "global sensemaking" tool (Pillar 5, T15) — agent-driven, no LLM in
 * the server.
 *
 * Detects communities (densely-connected entity clusters) over the entity
 * graph on demand and returns each community's local summary: its top entities
 * and the memories that mention them. This is the corpus-level view that
 * chunk-level retrieval can't give — the raw material for answering "what are
 * the main themes?". The instruction tells the agent to synthesize named
 * themes from these communities; the summarization stays LLM-side.
 *
 * Read-only; computes nothing persistent.
 */
export function handleCommunities(
  db: Database.Database,
  input: CommunitiesInput = {},
): CommunitiesResult {
  const communities = summarizeCommunities(db, {
    limit: input.limit,
    minSize: input.min_size,
  });

  return {
    communities,
    total_communities: communities.length,
    instruction:
      'Each community is a densely-connected cluster of entities — a candidate ' +
      'corpus-level theme. For global sensemaking ("what are the main themes?"), ' +
      'synthesize a short named theme for each community from its top_entities, ' +
      'optionally reading the member_memory_ids for detail, then summarize how the ' +
      'themes relate. This is the corpus-wide view that chunk-level search cannot give.',
  };
}
