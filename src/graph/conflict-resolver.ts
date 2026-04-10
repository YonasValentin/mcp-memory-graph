import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';

export interface ConflictResult {
  type: 'superseded' | 'contradicted' | 'refined' | 'duplicate' | 'none';
  existing_memory_id: string;
  overlap_score: number;
  description: string;
}

const STOP_WORDS = new Set([
  'the', 'this', 'that', 'with', 'from', 'have', 'been', 'will', 'would',
  'could', 'should', 'their', 'there', 'about', 'which', 'when', 'what',
  'were', 'they', 'them', 'then', 'than', 'into', 'each', 'make', 'like',
  'just', 'over', 'such', 'also', 'more', 'some', 'only', 'very', 'after',
  'before', 'other',
]);

export function extractSignificantWords(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  const result = new Set<string>();
  for (const word of words) {
    if (word.length >= 4 && !STOP_WORDS.has(word)) {
      result.add(word);
    }
  }
  return result;
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function checkConflicts(
  db: Database.Database,
  newEmbedding: Float32Array,
  newContent: string,
  newMemoryId: string,
): ConflictResult[] {
  const candidates = db
    .prepare<[Buffer, number], { rowid: number; distance: number }>(
      `SELECT rowid, distance FROM memories_vec
       WHERE embedding MATCH ? AND k = ?
       ORDER BY distance`,
    )
    .all(Buffer.from(newEmbedding.buffer), 10);

  const newWords = extractSignificantWords(newContent);
  const results: ConflictResult[] = [];

  const insertConflict = db.prepare(`
    INSERT INTO memory_conflicts (id, old_memory_id, new_memory_id, conflict_type, description)
    VALUES (?, ?, ?, ?, ?)
  `);

  const supersedeMemory = db.prepare(`
    UPDATE memories SET superseded_at = datetime('now') WHERE id = ?
  `);

  for (const candidate of candidates) {
    if (candidate.distance > 0.4) break;

    const row = db
      .prepare<[number], { id: string; content: string; parent_id: string | null; superseded_at: string | null }>(
        'SELECT id, content, parent_id, superseded_at FROM memories WHERE rowid = ?',
      )
      .get(Number(candidate.rowid));

    if (!row) continue;
    if (row.parent_id !== null) continue;
    if (row.superseded_at !== null) continue;
    if (row.id === newMemoryId) continue;

    const vectorSim = Math.max(0, 1 - candidate.distance / 2);
    const existingWords = extractSignificantWords(row.content);
    const keywordOverlap = jaccardSimilarity(newWords, existingWords);
    const overlapScore = 0.5 * vectorSim + 0.5 * keywordOverlap;

    if (overlapScore > 0.85) {
      insertConflict.run(uuidv4(), row.id, newMemoryId, 'duplicate', `Duplicate detected (overlap: ${overlapScore.toFixed(3)})`);
      results.push({
        type: 'duplicate',
        existing_memory_id: row.id,
        overlap_score: overlapScore,
        description: `Duplicate detected (overlap: ${overlapScore.toFixed(3)})`,
      });
    } else if (overlapScore > 0.75) {
      supersedeMemory.run(row.id);
      insertConflict.run(uuidv4(), row.id, newMemoryId, 'superseded', `Superseded by newer memory (overlap: ${overlapScore.toFixed(3)})`);
      results.push({
        type: 'superseded',
        existing_memory_id: row.id,
        overlap_score: overlapScore,
        description: `Superseded by newer memory (overlap: ${overlapScore.toFixed(3)})`,
      });
    } else if (overlapScore > 0.65) {
      insertConflict.run(uuidv4(), row.id, newMemoryId, 'contradicted', `Potential contradiction (overlap: ${overlapScore.toFixed(3)})`);
      results.push({
        type: 'contradicted',
        existing_memory_id: row.id,
        overlap_score: overlapScore,
        description: `Potential contradiction (overlap: ${overlapScore.toFixed(3)})`,
      });
    }
  }

  return results;
}
