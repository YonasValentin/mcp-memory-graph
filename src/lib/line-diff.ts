/**
 * Minimal dependency-free line diff (LCS) for memory version history (P2.3).
 * Produces a line-by-line classification so an agent/human can audit exactly
 * what changed between two revisions of a memory.
 */
export type DiffOp = 'ctx' | 'del' | 'add';
export interface DiffLine {
  type: DiffOp;
  line: string;
}

/**
 * Diff two texts line-by-line via a longest-common-subsequence backtrace.
 * `del` = present in `oldText` only, `add` = present in `newText` only, `ctx` =
 * unchanged. O(m·n) time/space — fine for memory-sized content.
 */
export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const m = a.length;
  const n = b.length;

  // dp[i][j] = LCS length of a[i:] and b[j:].
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ type: 'ctx', line: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: 'del', line: a[i] });
      i++;
    } else {
      out.push({ type: 'add', line: b[j] });
      j++;
    }
  }
  while (i < m) out.push({ type: 'del', line: a[i++] });
  while (j < n) out.push({ type: 'add', line: b[j++] });
  return out;
}

/** Count added/removed/unchanged lines in a diff. */
export function summarizeDiff(diff: DiffLine[]): { added: number; removed: number; unchanged: number } {
  let added = 0;
  let removed = 0;
  let unchanged = 0;
  for (const d of diff) {
    if (d.type === 'add') added++;
    else if (d.type === 'del') removed++;
    else unchanged++;
  }
  return { added, removed, unchanged };
}
