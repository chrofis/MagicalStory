/**
 * The prose of a single evaluator finding, whatever schema produced it.
 *
 * Mirror of `findingText()` in server/lib/scoring.js. The semantic evaluator
 * emits `description`; the pre-2026-08 semantic schema and older stored rows
 * carry `problem`, and older visual rows carry `issue`. Panels used to render
 * `issue.problem` alone, which showed an empty line for every fresh semantic
 * finding. Keep the two implementations in step.
 */
export function findingText(issue: any): string {
  if (!issue || typeof issue !== 'object') return '';
  const text = issue.description || issue.problem || issue.issue || '';
  if (text) return String(text).trim();
  const type = issue.type || issue.category || '';
  const item = issue.item || issue.character || '';
  return [type, item].filter(Boolean).join(': ');
}
