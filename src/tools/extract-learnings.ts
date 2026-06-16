import type Database from 'better-sqlite3';
import type { EmbeddingProvider, ExtractedLearning, ExtractLearningsResult, MemoryScope } from '../types.js';
import { findNearDuplicates, getMemoryById, updateMemory } from '../db/repository.js';
import { contextualizeForEmbedding } from '../search/contextual.js';
import { DEDUP_L2_DISTANCE } from '../constants/thresholds.js';
import { handleStore } from './store.js';
import { extractSignalText } from '../cli/turn-signal.js';

type LearningType = ExtractedLearning['type'];

interface ExtractionPattern {
  type: LearningType;
  regex: RegExp;
  confidence: number;
  combineGroups?: boolean;
}

const EXTRACTION_PATTERNS: ExtractionPattern[] = [
  {
    type: 'decision',
    regex: /(?:decided|decision|agreed|chose|chosen|will use|going with|settled on|the approach is|we(?:'ll| will| should))\s*(?:to |that |on )?(.+?)(?:\.|$)/gim,
    confidence: 0.5,
  },
  {
    type: 'error_fix',
    regex: /(?:fixed by|the fix (?:was|is)|solution (?:was|is)|resolved by|the issue (?:was|is)|the problem (?:was|is))\s*[:;]?\s*(.+?)(?:\.|$)/gim,
    confidence: 0.6,
  },
  {
    type: 'error_fix',
    regex: /(?:error|bug|issue)\s*[:;]?\s*(.+?)\s*(?:—|--|->|=>|:)\s*(?:fix(?:ed)?|resolv(?:ed|e)|solution)\s*[:;]?\s*(.+?)(?:\.|$)/gim,
    confidence: 0.6,
    combineGroups: true,
  },
  {
    type: 'pattern',
    regex: /(?:pattern|noticed that|turns out|learned that|discovered that|TIL|insight)\s*[:;]?\s*(.+?)(?:\.|$)/gim,
    confidence: 0.4,
  },
  {
    type: 'convention',
    regex: /(?:convention|standard|rule|policy|guideline|naming convention|must always|should always|never)\s*[:;]?\s*(.+?)(?:\.|$)/gim,
    confidence: 0.4,
  },
  {
    type: 'incident',
    regex: /(?:root cause|postmortem|the outage|the incident|went down|brought down|regression|broke production|service degradation)\s*(?:was|were|is)?\s*[:;,]?\s*(.+?)(?:\.|$)/gim,
    confidence: 0.5,
  },
  {
    type: 'lesson',
    regex: /(?:lesson learned|in hindsight|next time|going forward|the takeaway|key takeaway)\s*[:;,]?\s*(.+?)(?:\.|$)/gim,
    confidence: 0.4,
  },
];

const MAX_EXTRACTIONS = 20;

/**
 * Strips structured noise from a Claude Code transcript before regex matching.
 * Removes code blocks, inline code, tool markers, tables, diffs, JSON, and paths.
 */
export function preprocessTranscript(transcript: string): string {
  let text = transcript;

  // Remove fenced code blocks (```...```)
  text = text.replace(/```[\s\S]*?```/g, '');

  // Remove inline code (`...`)
  text = text.replace(/`[^`\n]+`/g, '');

  // Remove XML-style tool markers (<tool_call>, </result>, etc.)
  text = text.replace(/^<\/?[a-z_-]+>.*$/gim, '');

  // Remove markdown table rows (2+ pipe chars)
  text = text.replace(/^.*\|.*\|.*$/gm, '');

  // Remove diff headers
  text = text.replace(/^(?:[+-]{3}\s|@@\s|diff --git\s).+$/gm, '');

  // Remove lines that are only a file path
  text = text.replace(/^\s*(?:[\w.-]+\/)+[\w.-]+\s*$/gm, '');

  // Remove JSON-like lines
  text = text.replace(/^\s*[{}]\s*$/gm, '');
  text = text.replace(/^\s*"[\w-]+":\s*.+$/gm, '');

  // Collapse excessive whitespace
  text = text.replace(/\n{3,}/g, '\n\n');

  return text;
}

/**
 * Validates that extracted content is natural language, not code/JSON/path fragments.
 */
export function isQualityContent(content: string): boolean {
  if (content.length < 30) return false;
  if (content.length > 500) return false;

  // Must contain at least 3 real words (>2 alpha chars each)
  const words = content.split(/\s+/);
  const realWords = words.filter(w => (w.match(/[a-zA-Z]/g) ?? []).length > 2);
  if (realWords.length < 3) return false;

  // At least 60% alphabetic characters (reject code/JSON/paths)
  const alphaSpaceCount = (content.match(/[a-zA-Z\s]/g) ?? []).length;
  if (alphaSpaceCount / content.length < 0.6) return false;

  // Reject if starts with syntax/code indicators
  const firstChar = content.trimStart()[0];
  if (firstChar && '`|{}[]/<>#-+*='.includes(firstChar)) return false;

  // Reject if looks like a file path
  if (/^[\w/\\.-]+\.\w{1,5}$/.test(content.trim())) return false;

  // Reject if contains code patterns
  if (/(?:import\s+|require\(|function\s*\(|=>\s*\{|const\s+\w+\s*=|export\s+)/.test(content)) return false;

  return true;
}

// Shared cosine-0.85 cutoff (see src/constants/thresholds.ts) — kept identical
// to consolidate so paraphrases dedup at the same target on every path.
const DEDUP_DISTANCE_THRESHOLD = DEDUP_L2_DISTANCE;

function generateTitle(content: string): string {
  const trimmed = content.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= 80) return trimmed;
  return trimmed.slice(0, 77) + '...';
}

export function extractFromTranscript(
  transcript: string,
  categories?: LearningType[],
): ExtractedLearning[] {
  // M4.4 turn-signal gate: when the transcript is real Claude Code JSONL, mine
  // only the substantive turns (drop tool blocks / acks / coordination). A
  // plain-text transcript passes through unchanged (fall-safe).
  const cleaned = preprocessTranscript(extractSignalText(transcript));
  const allowedTypes = categories && categories.length > 0 ? new Set(categories) : null;
  const learnings: ExtractedLearning[] = [];
  const seenContent = new Set<string>();

  for (const pattern of EXTRACTION_PATTERNS) {
    if (learnings.length >= MAX_EXTRACTIONS) break;
    if (allowedTypes && !allowedTypes.has(pattern.type)) continue;

    pattern.regex.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = pattern.regex.exec(cleaned)) !== null) {
      if (learnings.length >= MAX_EXTRACTIONS) break;

      let content: string;
      if (pattern.combineGroups && match[2]) {
        /* c8 ignore next */
        content = `Problem: ${match[1].trim()} / Fix: ${match[2].trim()}`;
      } else {
        content = match[1]?.trim() ?? '';
      }

      if (!isQualityContent(content)) continue;

      const normalized = content.toLowerCase();
      if (seenContent.has(normalized)) continue;
      seenContent.add(normalized);

      learnings.push({
        type: pattern.type,
        title: generateTitle(content),
        content,
        tags: ['auto-extracted', pattern.type],
        confidence: pattern.confidence,
      });
    }
  }

  return learnings;
}

export async function handleExtractLearnings(
  db: Database.Database,
  embedder: EmbeddingProvider,
  input: {
    transcript: string;
    scope?: string;
    namespace?: string;
    department?: string;
    tags?: string[];
    source?: string;
    categories?: ExtractedLearning['type'][];
    auto_store?: boolean;
    // RBAC §6 (re-battle-4): a sub-ceiling principal must not corroborate (bump
    // metadata + version of) an over-ceiling near-duplicate. The allow-list of
    // levels the caller may touch; undefined → legacy/local/full-clearance.
    access_level_ceiling?: string[];
  },
): Promise<ExtractLearningsResult> {
  const learnings = extractFromTranscript(input.transcript, input.categories);
  const result: ExtractLearningsResult = {
    learnings,
    stored_count: 0,
    memory_ids: [],
  };

  for (const learning of learnings) {
    // Probe with the SAME contextualized text handleStore embeds, so the dedup
    // lookup lives in the same vector space as the stored embedding. Otherwise
    // a titled learning's bare-content probe would never match its own
    // context-prefixed stored vector and corroboration would never fire.
    const embedding = await embedder.embed(
      contextualizeForEmbedding(learning.content, {
        title: learning.title,
        namespace: input.namespace,
      }),
    );
    // battle-v9 CLASS 1: confine the dedup/corroboration probe to the caller's
    // own (scope, namespace). Unpartitioned, a foreign-tenant near-match could be
    // returned AND — under auto_store — get its corroboration_count MUTATED below
    // (a cross-tenant write). Mirrors store.ts's partition.
    let duplicates = findNearDuplicates(db, embedding, DEDUP_DISTANCE_THRESHOLD, 3, {
      scope: input.scope ?? 'global',
      namespace: input.namespace ?? null,
    });

    // §6 (re-battle-4): an over-ceiling near-dup is invisible to this caller. It
    // must NOT be corroborated (a cross-clearance metadata+version MUTATE of a row
    // the caller can't read). It also must not fall through to the store-anew
    // path, because handleStore's own dedup is partition-only (not ceiling-aware)
    // and would NOOP against the same over-ceiling row and echo its id — an
    // existence oracle. So: keep only ceiling-visible dups for corroboration, and
    // if the ONLY matches were over-ceiling, SUPPRESS this learning entirely
    // (the caller learns nothing about the unseen row). No-op when undefined.
    if (input.access_level_ceiling) {
      const ceiling = input.access_level_ceiling;
      const visible: typeof duplicates = [];
      let hadOverCeiling = false;
      for (const d of duplicates) {
        const row = getMemoryById(db, d.id);
        if (row && ceiling.includes(row.access_level)) visible.push(d);
        else if (row) hadOverCeiling = true;
      }
      duplicates = visible;
      if (duplicates.length === 0 && hadOverCeiling) continue;
    }

    if (duplicates.length > 0) {
      if (input.auto_store) {
        const existingRow = getMemoryById(db, duplicates[0].id);
        if (existingRow) {
          const existingMeta: Record<string, unknown> = existingRow.metadata
            ? JSON.parse(existingRow.metadata) as Record<string, unknown>
            /* c8 ignore next */
            : {};
          const currentCount =
            typeof existingMeta.corroboration_count === 'number'
              ? existingMeta.corroboration_count
              /* c8 ignore next */
              : 0;
          existingMeta.corroboration_count = currentCount + 1;

          updateMemory(db, duplicates[0].id, {
            metadata: JSON.stringify(existingMeta),
          });
        }
      }
      continue;
    }

    if (input.auto_store) {
      const combinedTags = [
        ...learning.tags,
        ...(input.tags ?? []),
      ];

      const stored = await handleStore(db, embedder, {
        content: learning.content,
        title: learning.title,
        scope: input.scope as MemoryScope | undefined,
        namespace: input.namespace,
        department: input.department,
        source: input.source,
        tags: combinedTags,
        confidence_score: learning.confidence,
        metadata: {
          learning_type: learning.type,
          extraction_confidence: learning.confidence,
          corroboration_count: 0,
        },
      });

      result.memory_ids.push(stored.memory.id);
      result.stored_count++;
    }
  }

  return result;
}
