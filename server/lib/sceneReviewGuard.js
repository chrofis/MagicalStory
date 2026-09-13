/**
 * Scene-review truncation guard (Test Lab).
 *
 * A review that came back empty, or that stopped exactly at the output-token
 * ceiling, is NOT a review — yet until 2026-09-11 the Lab harness kept every
 * untouched page's `fromBeats` as its "reviewed" brief and the hazard judge
 * measured it as reviewed. Experiments 1109/1121 (0 chars, out=16000) and
 * 1122/1124 (cut mid-output at out=16000) went unnoticed; #920 returned 0 chars
 * with no cap hit at all. These helpers make both failure kinds loud and
 * stop the downstream stage from consuming them.
 */
const { assessTextReply, describeTruncation } = require('./textReplyGuard');

/**
 * Decide whether a scene review response is usable.
 *
 * Thin wrapper over the shared `assessTextReply` (server/lib/textReplyGuard.js)
 * — the same detection every callTextModel reply now carries — with the
 * scene-review parse verdict folded in: a review that produced substantial
 * prose but no parseable SCENES block is a format failure, not "found
 * nothing", unless its tail reads as a "no changes" verdict.
 *
 * @param {object} p
 * @param {string} p.text             raw model output
 * @param {number|null} p.outputTokens usage.output_tokens as reported
 * @param {string|null} p.stopReason  provider finish reason when exposed
 *                                    (Anthropic streams `stop_reason`)
 * @param {number|null} p.capInForce  the max-tokens ceiling the call actually
 *                                    ran under (model max when no numeric cap)
 * @param {number} p.parsedPageCount  pages the SCENES parser extracted
 * @returns {{ ok: boolean, error: string|null }}
 */
function assessSceneReview({ text, outputTokens = null, stopReason = null, capInForce = null, parsedPageCount = 0 }) {
  const trimmed = String(text || '').trim();
  const saysNoChanges = /no (changes|rewrites?|faults?)/i.test(trimmed.slice(-400));
  const t = assessTextReply(
    { text, usage: { output_tokens: outputTokens }, stop_reason: stopReason },
    { capInForce, minMeaningfulChars: 2000, parsedOk: parsedPageCount > 0 || saysNoChanges }
  );
  if (!t.suspected) return { ok: true, error: null };
  if (t.reason === 'unparsed') {
    return { ok: false, error: `scene review returned ${trimmed.length} chars but the SCENES parser found 0 pages — format failure or cut-off` };
  }
  return { ok: false, error: `scene review ${describeTruncation(t)}` };
}

/**
 * Refuse to treat a beats_scenes result's `reviewedBrief`s as reviewed when
 * its scene review failed. Throws with the stored reason.
 */
function assertReviewedArtifactUsable(out, expId) {
  const sr = out && out.sceneReview;
  if (sr && sr.ok === false) {
    throw new Error(
      `fromExperiment ${expId}: artifact 'reviewed' refused — its scene review FAILED (${sr.error || 'no reason recorded'}); ` +
      `measure artifact=raw or rerun the review`
    );
  }
}

/**
 * Pick the brief the hazard judge should measure for one page of a
 * beats_scenes result.
 *
 * No `reviewer`: the primary reviewer's brief (`reviewedBrief`, else the raw
 * expansion) — the historical behaviour, guarded by assertReviewedArtifactUsable.
 * With `reviewer` (a TEXT_MODELS key): that reviewer's rewrite. The primary's
 * rewrites live in `reviewedBrief`; every other successful reviewer's live in
 * `reviewedBriefs[modelKey]` (stored once, never duplicated for the primary).
 * A reviewer that is absent from the experiment or whose review failed is
 * REFUSED — never silently swapped for the primary or the raw brief.
 */
function pickReviewedBrief(page, out, reviewer, expId) {
  if (!reviewer) return page.reviewedBrief || page.fromBeats;
  const reviews = Array.isArray(out && out.sceneReviews) ? out.sceneReviews : [];
  const review = reviews.find(r => r && r.modelKey === reviewer);
  if (!review) {
    throw new Error(`fromExperiment ${expId}: reviewer "${reviewer}" did not run on this experiment (reviewers: ${reviews.map(r => r && r.modelKey).filter(Boolean).join(', ') || 'none'})`);
  }
  if (review.ok === false) {
    throw new Error(`fromExperiment ${expId}: reviewer "${reviewer}" FAILED on this experiment (${review.error || 'no reason recorded'}) — nothing to measure as reviewed`);
  }
  const isPrimary = reviews[0] === review;
  const fixed = (page.reviewedBriefs && page.reviewedBriefs[reviewer]) || (isPrimary ? page.reviewedBrief : null);
  return fixed || page.fromBeats;
}


/**
 * The reviewer's DECLARED-REMOVALS channel (scene-review.txt OUTPUT FORMAT,
 * 2026-09-13).
 *
 * Until this line existed a removal was expressible only as an absence: the
 * reviewer shipped a rewritten brief with a name gone from `characters[]` and
 * nothing said why. On job_1789207854566_l43qgl34w it rewrote five commissioned
 * characters into "five soaked pirates: one in a blue tricorn, one tall in an
 * orange tricorn…" and set `characters: []` (p7) / `["Fiona"]` (p15). Only the
 * `FAULTED PAGES:` line was ever parsed, so nothing downstream could see it.
 *
 * Grammar, one line, anywhere in the analysis block:
 *   REMOVED CAST: NONE
 *   REMOVED CAST: 4 = Alice: off-frame in the plan line; 7 = Bob, Cara: crowd
 *
 * Anything that does not parse is reported rather than dropped, so a malformed
 * line is never read as "no removals".
 *
 * @param {string} analysis raw ---ANALYSIS--- text
 * @returns {{ present: boolean, none: boolean, pages: Array<{pageNumber:number, names:string[], reason:string}>, malformed: string[] }}
 */
function parseCastRemovals(analysis) {
  const empty = { present: false, none: false, pages: [], malformed: [] };
  const line = String(analysis || '').match(/^\s*REMOVED CAST:\s*(.*)\s*$/mi);
  if (!line) return empty;
  const body = String(line[1] || '').trim();
  if (!body || /^none$/i.test(body)) return { present: true, none: true, pages: [], malformed: [] };
  const pages = [];
  const malformed = [];
  for (const rawEntry of body.split(';')) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    const m = entry.match(/^(\d+)\s*=\s*([^:]+?)\s*:\s*(.+)$/);
    if (!m) { malformed.push(entry); continue; }
    const names = m[2].split(',').map(n => n.trim()).filter(Boolean);
    if (!names.length) { malformed.push(entry); continue; }
    pages.push({ pageNumber: Number(m[1]), names, reason: m[3].trim() });
  }
  return { present: true, none: pages.length === 0 && malformed.length === 0, pages, malformed };
}

/** Lower-cased, de-duplicated name set. Mechanical — no prose is ever read. */
function castNameSet(names) {
  return new Set((Array.isArray(names) ? names : [])
    .map(c => (typeof c === 'string' ? c : (c && c.name)))
    .filter(n => typeof n === 'string' && n.trim())
    .map(n => n.trim().toLowerCase()));
}

/**
 * Which characters a rewrite removed from a page WITHOUT declaring it.
 *
 * Pure name-set arithmetic over `characters[]` before vs after — never an
 * inference from description text. A declared name is subtracted case-
 * insensitively; whatever is left vanished silently.
 *
 * Detection and reporting only (owner, 2026-09-13): the caller logs, it does
 * not revert. A deterministic gate is a separate decision.
 *
 * SECONDARY ROUTING IS NOT A REMOVAL. A Visual Bible secondary is commissioned
 * through `objects[]` (its CHR id) rather than `characters[]`, so a rewrite that
 * moves a name from one list to the other has changed how the figure is carried,
 * not whether it is drawn. On job_1789207854566_l43qgl34w that is pages 13 and
 * 16 (`CHR001` out of `characters[]`, still cited in `objects[]`) — and telling
 * those apart from pages 7 and 15, where five commissioned characters simply
 * vanished, is the whole point of the detector. Still a set membership test, on
 * the after-brief's `objects[]`; no description text is read.
 *
 * @param {Array<{pageNumber:number, beforeCast:string[], afterCast:string[], afterObjects?:string[]}>} pages
 * @param {ReturnType<typeof parseCastRemovals>} declared
 * @returns {Array<{pageNumber:number, lost:string[], rerouted:string[], declared:string[], undeclared:string[]}>}
 *          one row per page that lost at least one name to something other than
 *          `objects[]`; `undeclared` may be empty when every loss was declared
 */
function diffCastRemovals(pages, declared) {
  const byPage = new Map();
  for (const p of (declared && declared.pages) || []) byPage.set(p.pageNumber, castNameSet(p.names));
  const out = [];
  for (const p of pages || []) {
    const before = castNameSet(p.beforeCast);
    const after = castNameSet(p.afterCast);
    const objects = castNameSet(p.afterObjects);
    const gone = [...before].filter(n => !after.has(n));
    const rerouted = gone.filter(n => objects.has(n));
    const lost = gone.filter(n => !objects.has(n));
    if (!lost.length) continue;
    const said = byPage.get(p.pageNumber) || new Set();
    out.push({
      pageNumber: p.pageNumber,
      lost,
      rerouted,
      declared: lost.filter(n => said.has(n)),
      undeclared: lost.filter(n => !said.has(n)),
    });
  }
  return out;
}

module.exports = { parseCastRemovals, castNameSet, diffCastRemovals, assessSceneReview, assertReviewedArtifactUsable, pickReviewedBrief };
