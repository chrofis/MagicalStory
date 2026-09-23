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
    // The prompt's grammar line says `page = name…`, and the reviewer reads
    // that literally: `page 5 = Levin: …`. Accept the word form as well as the
    // bare number — a prefixed entry used to land in `malformed` and then be
    // re-raised as an undeclared removal (job_1789348171785_9oxos7dwv).
    const m = entry.match(/^(?:(?:page|seite|p\.?)\s*)?(\d+)\s*=\s*([^:]+?)\s*:\s*(.+)$/i);
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
 * Detection feeds `revertUndeclaredRemovals` below (2026-09-15). The
 * 2026-09-13 ruling — detect and report, do not revert — held for two days and
 * was reversed by what an undeclared removal actually costs; see that function.
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


/**
 * Un-ship a page whose review rewrite removed cast without declaring it.
 *
 * Detected since 2026-09-13, reverted since 2026-09-15. What the detection
 * alone cost, measured on staging job_1789420511893_zly5rcdej p16:
 * `beats_scene_review_removal_undeclared` fired at ERROR ("emma, noah, daniel"),
 * alongside `beats_brief_unfixed` and `cast_unlisted` — and the page rendered
 * anyway, on the emptied cast. The corrupt contract then produced a phantom
 * CRITICAL `extra_character` against a child who IS in the prose; that critical
 * funded three repair rounds, and the round-2 inpaint destroyed a CORRECT
 * original (v0 −45 correct → v2 −40 wrong, shipped) because all three versions
 * were scored against the same corrupt cast.
 *
 * The revert is the WHOLE page brief, back to the version that was sent for
 * review — not `characters[]` alone. The reviewer that drops a name usually
 * rewrites the prose around it too ("five soaked pirates" for five named
 * children), so restoring the cast list into the rewritten prose yields a brief
 * whose roster and prose disagree, which is the same corrupt contract in a new
 * shape. The pre-review brief is internally consistent by construction; the
 * cost is that page's other review fixes, which the caller then reports as
 * unfixed through the normal faulted-but-not-rewritten channel.
 *
 * Mutates `expansions` (the brief) and returns what it undid. Pure set/array
 * work otherwise — no prose is read.
 *
 * @param {Array<{pageNumber:number, brief:string, reviewRewrote?:boolean}>} expansions
 * @param {Array<{pageNumber:number, before:string, after:string}>} sceneDiffs - trimmed in place
 * @param {number[]} changed - pages the review rewrote; trimmed in place
 * @param {Array<{pageNumber:number, undeclared:string[]}>} audit - diffCastRemovals rows
 * @returns {Array<{pageNumber:number, undeclared:string[]}>} pages reverted
 */
function revertUndeclaredRemovals(expansions, sceneDiffs, changed, audit) {
  const reverted = [];
  for (const row of (audit || [])) {
    if (!row || !(row.undeclared || []).length) continue;
    const diffAt = (sceneDiffs || []).findIndex(d => d && d.pageNumber === row.pageNumber);
    const x = (expansions || []).find(e => e && e.pageNumber === row.pageNumber);
    // No captured `before` means nothing to restore — the page was not one of
    // the rewrites, so there is no corruption of ours to undo.
    if (diffAt < 0 || !x) continue;
    x.brief = sceneDiffs[diffAt].before;
    x.reviewRewrote = false;
    sceneDiffs.splice(diffAt, 1);
    const ci = (changed || []).indexOf(row.pageNumber);
    if (ci >= 0) changed.splice(ci, 1);
    reverted.push({ pageNumber: row.pageNumber, undeclared: row.undeclared });
  }
  return reverted;
}

/**
 * The span of the `characters[]` ARRAY inside a brief's metadata block.
 *
 * Bracket-matched, string-aware — never a regex over the JSON, which would
 * stop at the first `]` inside a nested value. Returns the indices of the
 * opening `[` and its matching `]`, or null when the key is not there.
 */
function castArraySpan(brief) {
  const text = String(brief || '');
  const marker = require('./sceneMetadata').splitBrief(text).metadataStart;
  const from = marker >= 0 ? marker : 0;
  const key = text.indexOf('"characters"', from);
  if (key < 0) return null;
  const open = text.indexOf('[', key);
  if (open < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return { open, close: i };
    }
  }
  return null;
}

/** The pre-review brief's own `characters[]` rows for the named cast. */
function castEntriesFor(brief, names) {
  const { extractSceneMetadata } = require('./sceneMetadata');
  let meta = null;
  try { meta = extractSceneMetadata(String(brief || '')); } catch { return []; }
  const rows = Array.isArray(meta?.fullData?.characters) ? meta.fullData.characters
    : (Array.isArray(meta?.characters) ? meta.characters : []);
  const want = castNameSet(names);
  return rows
    .map(r => (typeof r === 'string' ? { name: r } : r))
    .filter(r => r && typeof r.name === 'string' && want.has(r.name.trim().toLowerCase()));
}

/**
 * Put back ONLY the cast the review dropped without declaring it.
 *
 * Supersedes the whole-brief revert of 2026-09-15 (owner, 2026-09-17: "Reverting
 * the whole brief to punish one undeclared removal is too blunt"). What the
 * blunt version cost, measured on staging job_1789584708605_rts4wqupm p18: the
 * reviewer dropped four of the page's cast from `characters[]` with no REMOVED
 * CAST line, the page was reverted whole to its PRE-REVIEW brief
 * (`namedButNotRewritten: [18]`), and it shipped at 45 where the previous run's
 * reviewed p18 scored 95. Every other fix that review made to that page went
 * with it.
 *
 * The reason the 2026-09-15 revert was whole-brief still stands and is handled:
 * a reviewer that drops a name often rewrites the prose around it, so a roster
 * restored into that prose can read thin. It cannot read WRONG — the image
 * prompt's REQUIRED CAST rule draws every named character whether or not the
 * prose gives them an action — and an under-described figure costs far less
 * than a phantom `extra_character` CRITICAL funding repair rounds, which is
 * what an emptied roster costs.
 *
 * Structural throughout: the dropped rows are copied VERBATIM out of the
 * pre-review brief's own metadata and spliced into the reviewed brief's
 * `characters[]` array. No prose is read or written. When the array cannot be
 * located structurally the page falls back to the whole-brief revert rather
 * than rendering on an emptied cast.
 *
 * Mutates `expansions` / `sceneDiffs` / `changed` like its predecessor.
 *
 * @returns {{restored: Array<{pageNumber:number, names:string[]}>, reverted: Array<{pageNumber:number, undeclared:string[]}>}}
 */
function restoreUndeclaredRemovals(expansions, sceneDiffs, changed, audit) {
  const restored = [];
  const revertRows = [];
  for (const row of (audit || [])) {
    if (!row || !(row.undeclared || []).length) continue;
    const diffAt = (sceneDiffs || []).findIndex(d => d && d.pageNumber === row.pageNumber);
    const x = (expansions || []).find(e => e && e.pageNumber === row.pageNumber);
    if (diffAt < 0 || !x) continue;
    const before = sceneDiffs[diffAt].before;
    // IDEMPOTENT (2026-09-19). The splice used to append blind, so a name the
    // reviewed brief already lists was added a SECOND time: staging
    // job_1789759147125_p08djwhbl p17 shipped `characters: ["Julian","Julian"]`
    // — the fingerprint being a pretty-printed first row (model output) and a
    // compact `JSON.stringify` second (this function's). The root trigger there
    // was a parse failure feeding a false "cast emptied" diff, and that parser
    // is fixed (b5443396a) — but this guard must not depend on a parser
    // succeeding upstream. Comparison is canonical, through `castNameSet`,
    // never raw string equality.
    const alreadyThere = castNameSet(castEntriesFor(x.brief, row.undeclared).map(r => r.name));
    const stillMissing = row.undeclared.filter(n => !alreadyThere.has(String(n).trim().toLowerCase()));
    // Every "dropped" name is in fact present: nothing was removed, so nothing
    // is restored and — crucially — the page is NOT reverted either.
    if (stillMissing.length === 0) continue;
    const rows = castEntriesFor(before, stillMissing);
    const span = rows.length > 0 ? castArraySpan(x.brief) : null;
    if (span) {
      const inner = String(x.brief).slice(span.open + 1, span.close);
      const addition = rows.map(r => JSON.stringify(r)).join(', ');
      const merged = inner.trim() ? `${inner.replace(/\s+$/, '')}, ${addition}` : addition;
      x.brief = String(x.brief).slice(0, span.open + 1) + merged + String(x.brief).slice(span.close);
      sceneDiffs[diffAt].after = x.brief;
      restored.push({ pageNumber: row.pageNumber, names: rows.map(r => r.name) });
      continue;
    }
    // No locatable `characters[]` (or no rows to copy): the page must not
    // render on the emptied cast, so the pre-2026-09-17 whole-brief revert
    // stands for it alone.
    x.brief = before;
    x.reviewRewrote = false;
    sceneDiffs.splice(diffAt, 1);
    const ci = (changed || []).indexOf(row.pageNumber);
    if (ci >= 0) changed.splice(ci, 1);
    revertRows.push({ pageNumber: row.pageNumber, undeclared: stillMissing });
  }
  return { restored, reverted: revertRows };
}

module.exports = { parseCastRemovals, castNameSet, diffCastRemovals, revertUndeclaredRemovals, restoreUndeclaredRemovals, castArraySpan, castEntriesFor, assessSceneReview, assertReviewedArtifactUsable, pickReviewedBrief };
