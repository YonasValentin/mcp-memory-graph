import type { VolatilityClass } from '../types.js';

const RULES_RE = /\b(rule|must|never|always|required|mandatory)\b/i;
const DECISIONS_RE = /\b(decision|decided|chose|because)\b/i;
const ERRORS_RE = /\b(bug|fix|error|incident|broke|failed)\b/i;
const CODE_BLOCK_RE = /```/;
const DRAFT_RE = /\b(todo|placeholder|draft|wip)\b/i;

/**
 * Content that asserts a point-in-time/operational state — the kind of claim
 * that goes stale fast ("deployed", "live in PROD", "verified", "currently…").
 * Tuned to the failure that motivated this: a "UAT-verified" memory trusted a
 * day after it was written. Kept beside the other content regexes for one-place
 * tuning.
 */
const VOLATILE_RE =
  /\b(deployed|deploy|live|in prod|production|rolled out|currently|as of|right now|today|this (week|sprint)|verified|passing|green|failing|red|status|up to date|latest|now live|in progress|pending|wip)\b/i;

/** document_type values whose facts are inherently operational/point-in-time. */
const VOLATILE_DOC_TYPES = new Set(['deploy', 'status', 'incident', 'incident-status', 'session', 'task-status']);
/** document_type values whose facts are durable references/agreements. */
const STABLE_DOC_TYPES = new Set(['reference', 'contract', 'policy', 'decision', 'adr', 'spec']);

/**
 * Classify how fast a memory's truth decays, from its content + document_type.
 * Drives tier-specific freshness warnings on recall (see freshnessWarning).
 * Document-type signal wins over content (an explicit type is a stronger intent
 * than incidental wording); within content, volatile wording wins over nothing.
 */
export function classifyVolatility(content: string, documentType?: string | null): VolatilityClass {
  const dt = documentType?.toLowerCase().trim();
  if (dt) {
    if (VOLATILE_DOC_TYPES.has(dt)) return 'volatile';
    if (STABLE_DOC_TYPES.has(dt)) return 'stable';
  }
  if (VOLATILE_RE.test(content)) return 'volatile';
  return 'normal';
}

export function computeContentSignal(content: string): number {
  let score = 0.5;

  // Boosts
  if (RULES_RE.test(content)) score += 0.15;
  if (DECISIONS_RE.test(content)) score += 0.10;
  if (ERRORS_RE.test(content)) score += 0.10;
  if (CODE_BLOCK_RE.test(content)) score += 0.05;

  // Penalties
  if (DRAFT_RE.test(content)) score -= 0.15;
  if (content.length < 100) score -= 0.10;

  return Math.max(0, Math.min(1, score));
}

export function maturityTier(importance: number): 'draft' | 'validated' | 'core' {
  if (importance >= 0.85) return 'core';
  if (importance >= 0.65) return 'validated';
  return 'draft';
}
