const RULES_RE = /\b(rule|must|never|always|required|mandatory)\b/i;
const DECISIONS_RE = /\b(decision|decided|chose|because)\b/i;
const ERRORS_RE = /\b(bug|fix|error|incident|broke|failed)\b/i;
const CODE_BLOCK_RE = /```/;
const DRAFT_RE = /\b(todo|placeholder|draft|wip)\b/i;

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
