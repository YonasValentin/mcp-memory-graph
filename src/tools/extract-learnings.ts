import type Database from 'better-sqlite3';
import type { EmbeddingProvider, ExtractedLearning, ExtractLearningsResult } from '../types.js';
import { findNearDuplicates, getMemoryById, updateMemory } from '../db/repository.js';
import { handleStore } from './store.js';

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
    confidence: 0.7,
  },
  {
    type: 'error_fix',
    regex: /(?:fixed by|the fix (?:was|is)|solution (?:was|is)|resolved by|the issue (?:was|is)|the problem (?:was|is))\s*[:;]?\s*(.+?)(?:\.|$)/gim,
    confidence: 0.8,
  },
  {
    type: 'error_fix',
    regex: /(?:error|bug|issue)\s*[:;]?\s*(.+?)\s*(?:—|--|->|=>|:)\s*(?:fix(?:ed)?|resolv(?:ed|e)|solution)\s*[:;]?\s*(.+?)(?:\.|$)/gim,
    confidence: 0.8,
    combineGroups: true,
  },
  {
    type: 'pattern',
    regex: /(?:pattern|noticed that|turns out|learned that|discovered that|TIL|insight)\s*[:;]?\s*(.+?)(?:\.|$)/gim,
    confidence: 0.6,
  },
  {
    type: 'convention',
    regex: /(?:convention|standard|rule|policy|guideline|naming convention|must always|should always|never)\s*[:;]?\s*(.+?)(?:\.|$)/gim,
    confidence: 0.6,
  },
];

const DEDUP_DISTANCE_THRESHOLD = (1 - 0.85) * 2; // 0.85 similarity

function generateTitle(content: string): string {
  const trimmed = content.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= 80) return trimmed;
  return trimmed.slice(0, 77) + '...';
}

function extractFromTranscript(
  transcript: string,
  categories?: LearningType[],
): ExtractedLearning[] {
  const allowedTypes = categories && categories.length > 0 ? new Set(categories) : null;
  const learnings: ExtractedLearning[] = [];
  const seenContent = new Set<string>();

  for (const pattern of EXTRACTION_PATTERNS) {
    if (allowedTypes && !allowedTypes.has(pattern.type)) continue;

    // Reset the regex state for each pass
    pattern.regex.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = pattern.regex.exec(transcript)) !== null) {
      let content: string;
      if (pattern.combineGroups && match[2]) {
        content = `Problem: ${match[1].trim()} / Fix: ${match[2].trim()}`;
      } else {
        content = match[1]?.trim() ?? '';
      }

      if (content.length < 10) continue;

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
    categories?: Array<'decision' | 'pattern' | 'error_fix' | 'convention'>;
    auto_store?: boolean;
  },
): Promise<ExtractLearningsResult> {
  const learnings = extractFromTranscript(input.transcript, input.categories);
  const result: ExtractLearningsResult = {
    learnings,
    stored_count: 0,
    memory_ids: [],
  };

  for (const learning of learnings) {
    const embedding = await embedder.embed(learning.content);
    const duplicates = findNearDuplicates(db, embedding, DEDUP_DISTANCE_THRESHOLD, 3);

    if (duplicates.length > 0) {
      if (input.auto_store) {
        const existingRow = getMemoryById(db, duplicates[0].id);
        if (existingRow) {
          const existingMeta: Record<string, unknown> = existingRow.metadata
            ? JSON.parse(existingRow.metadata) as Record<string, unknown>
            : {};
          const currentCount =
            typeof existingMeta.corroboration_count === 'number'
              ? existingMeta.corroboration_count
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
        scope: input.scope as 'global' | 'project' | 'user' | 'team' | 'department' | undefined,
        namespace: input.namespace,
        department: input.department,
        source: input.source,
        tags: combinedTags,
        metadata: {
          learning_type: learning.type,
          extraction_confidence: learning.confidence,
          corroboration_count: 0,
        },
      });

      result.memory_ids.push(stored.id);
      result.stored_count++;
    }
  }

  return result;
}
