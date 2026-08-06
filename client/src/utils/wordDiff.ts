/**
 * Word-level diff for showing what a review model rewrote.
 *
 * Deliberately dependency-free: the artifact/CSP rules and bundle size both
 * argue against pulling in a diff library for one dev-mode panel. Classic
 * LCS over word tokens — the texts here are single story pages (a few hundred
 * words), so the O(n*m) table is trivially small.
 */

export type DiffOp = { type: 'same' | 'add' | 'del'; text: string };

/**
 * Split into words WITH their trailing whitespace, so re-joining the ops
 * reproduces the original string exactly and punctuation stays attached to
 * its word (a bare /\s+/ split loses the spacing the story text depends on).
 */
function tokenize(s: string): string[] {
  return String(s || '').match(/\S+\s*/g) || [];
}

/**
 * Longest-common-subsequence diff over word tokens.
 * Adjacent ops of the same type are merged so the rendered output is a few
 * spans rather than one per word.
 */
export function wordDiff(before: string, after: string): DiffOp[] {
  const a = tokenize(before);
  const b = tokenize(after);

  // lcs[i][j] = length of the LCS of a[i..] and b[j..]
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i].trim() === b[j].trim()
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const ops: DiffOp[] = [];
  const push = (type: DiffOp['type'], text: string) => {
    const last = ops[ops.length - 1];
    if (last && last.type === type) last.text += text;
    else ops.push({ type, text });
  };

  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i].trim() === b[j].trim()) { push('same', a[i]); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { push('del', a[i]); i++; }
    else { push('add', b[j]); j++; }
  }
  while (i < a.length) { push('del', a[i]); i++; }
  while (j < b.length) { push('add', b[j]); j++; }

  return ops;
}

/** Words added / removed — the headline numbers for a page's diff. */
export function diffStats(ops: DiffOp[]): { added: number; removed: number } {
  const count = (t: DiffOp['type']) =>
    ops.filter(o => o.type === t).reduce((n, o) => n + (o.text.trim() ? o.text.trim().split(/\s+/).length : 0), 0);
  return { added: count('add'), removed: count('del') };
}
