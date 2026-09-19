/**
 * OBJECT SCALE — one extra question inside the book audit's existing call.
 *
 * A recurring prop (an egg, a vehicle, a creature) is drawn at a different
 * size from page to page, and nothing in the pipeline sees it: every per-page
 * judge reads ONE image against ONE brief, so a prop that is football-sized on
 * one page and fist-sized on another scores clean on both. Size is only
 * visible when several pages are read together — which is what the final book
 * audit already does.
 *
 * THIS COSTS NOTHING EXTRA. The reviewer already runs; it already answers a
 * set of questions about the pages in front of it; this is one more question
 * in that same reply. No second call, no re-reads, no quorum.
 *
 * WHAT WAS MEASURED (2026-09-19, job_1789759147125_p08djwhbl, CHF ~1.9):
 *  - Asking for a per-page RATIO does not work: ceiling ~4/6 on direction
 *    alone, mean error 0.30-0.67, and the verdicts move with the page order.
 *    So the question asks for OUTLIERS, never numbers.
 *  - Asking which pages are significantly LARGER or SMALLER than the rest is
 *    the phrasing that produced a stable signal — the true outliers were named
 *    in every order tried. That phrasing is kept verbatim.
 *  - A single read also carries **2-3 false positives** (pages within +/-11%
 *    of the mean). ACCEPTED: this finding flags for a human and never fires a
 *    paid edit, so a false positive costs a glance. The finding text says so.
 *  - The SMALLER side is weaker than the larger side — a true small outlier
 *    was dropped by a reordering. The finding text says that too.
 *  - One read in four truncated after ignoring a "no per-page numbers"
 *    instruction and enumerating estimates. That ban is therefore explicit in
 *    the question, and a reply with no usable answer is recorded as NOT
 *    EVALUATED rather than read as "no outliers".
 *
 * NOTHING HERE REPAIRS. Shrinking a prop was measured to strand the hands off
 * it (the whole moment of that story's p5) and never reached the target size
 * anyway, and the reference-cell area lever is dead (SETTLED.md, 2026-09-19).
 * The finding goes to a human.
 */

/**
 * The collections whose entries have a real-world size a reader can misjudge.
 * Characters are excluded (their scale is the cast's own problem and the
 * reference sheets pin it), clothing is worn so it has no independent size,
 * and a location IS the frame rather than an object inside it.
 */
const SCALE_COLLECTIONS = ['artifacts', 'vehicles', 'animals'];

/** Below this many pages there is no meaningful rest-of-the-book to compare to. */
const MIN_PAGES = 4;

/** `ART001.2` and `ART001` are the same bible entry. */
function baseId(id) {
  const s = String(id == null ? '' : id).trim();
  const m = s.match(/^([A-Z]{2,4}\d{1,3})/);
  return m ? m[1] : (s || null);
}

/** The object ids a scene's Art Director brief cites, deduped, base form. */
function citedIds(scene) {
  const raw = (scene && scene.sceneMetadata && scene.sceneMetadata.objects) || (scene && scene.objects) || [];
  const out = new Set();
  for (const o of (Array.isArray(raw) ? raw : [])) {
    const b = baseId(typeof o === 'string' ? o : (o && o.id));
    if (b) out.add(b);
  }
  return out;
}

/**
 * Pick the props worth asking about.
 *
 * GENERIC IS ALREADY HANDLED, and deliberately not re-implemented here: an
 * entry the author marked `generic: true` is DROPPED at parse time into
 * `visualBible.genericObjects[]` with NO id (visualBible.js, isGenericEntry).
 * Everyday clutter therefore has no id for a brief to cite, so requiring a
 * cited id IS the generic gate.
 *
 * @param {Object} storyData        the story blob (visualBible + sceneImages)
 * @param {number[]} auditablePages pages whose shipped image the audit resolved
 * @returns {{candidates: Array, skipped: Array}} rows carry {id, collection, label, pages}
 */
function selectScaleObjects(storyData, auditablePages, opts = {}) {
  const minPages = opts.minPages == null ? MIN_PAGES : opts.minPages;
  const vb = (storyData && storyData.visualBible) || {};
  const readable = new Set((auditablePages || []).map(Number));

  const pagesById = new Map();
  for (const scene of ((storyData && storyData.sceneImages) || [])) {
    const pn = Number(scene && scene.pageNumber);
    if (!readable.has(pn)) continue;
    for (const id of citedIds(scene)) {
      if (!pagesById.has(id)) pagesById.set(id, []);
      pagesById.get(id).push(pn);
    }
  }

  const rows = [];
  for (const collection of SCALE_COLLECTIONS) {
    for (const entry of (Array.isArray(vb[collection]) ? vb[collection] : [])) {
      const id = baseId(entry && entry.id);
      if (!id) continue;                          // a generic entry has none
      const pages = [...new Set(pagesById.get(id) || [])].sort((a, b) => a - b);
      if (pages.length === 0) continue;
      rows.push({
        id,
        collection,
        label: String(entry.label || entry.name || entry.properName || id).trim(),
        pages,
      });
    }
  }

  const skipped = [];
  const candidates = [];
  for (const r of rows) {
    if (r.pages.length < minPages) skipped.push({ ...r, reason: 'too_few_pages' });
    else candidates.push(r);
  }
  // Most-seen first: the prop a reader meets on the most pages is the one whose
  // size drift a reader actually notices.
  candidates.sort((a, b) => b.pages.length - a.pages.length || a.id.localeCompare(b.id));
  return { candidates, skipped };
}

/**
 * The extra question, built for ONE batch of pages the reviewer is reading.
 *
 * A prop is named only when at least two of this batch's pages show it —
 * "larger than on the other pages" is unanswerable from a single picture.
 * With nothing to ask, the block is empty and the reviewer never hears about
 * scale at all.
 *
 * The three things the measurement says must stay in the wording: outliers
 * only (never a ratio), the ban on per-page numeric estimates (ignoring it
 * truncated a read), and explicit permission to answer "none".
 *
 * @param {Array} candidates   rows from selectScaleObjects
 * @param {number[]} batchPages the pages in this call, in reading order
 * @returns {{text: string, asked: Array}} `text` is '' when nothing qualifies
 */
function buildScaleQuestion(candidates, batchPages) {
  const inBatch = new Set((batchPages || []).map(Number));
  const asked = [];
  for (const c of (candidates || [])) {
    const here = c.pages.filter(p => inBatch.has(Number(p)));
    if (here.length < 2) continue;
    asked.push({ ...c, batchPages: here });
  }
  if (asked.length === 0) return { text: '', asked: [] };

  const lines = asked.map(a => `- ${a.label}: pages ${a.batchPages.map(p => `p${p}`).join(', ')}`);
  const text = [
    'ONE MORE QUESTION — OBJECT SIZE. These recurring objects appear on several of the pages above:',
    ...lines,
    '',
    'Looking only at how large each object is DRAWN relative to the people and the surroundings in its own picture, is it rendered significantly LARGER on some of those pages than on the rest, or significantly SMALLER? Its colour, its markings, its position and what is happening in the story are outside this question.',
    '',
    'Name only the pages that depart from how the object looks on the others. Say nothing about a page that sits near the rest. For each object write at most one line of each kind, at the left margin:',
    'SCALE[LARGER]: <object> — p<N>, p<N>',
    'SCALE[SMALLER]: <object> — p<N>',
    '',
    'An object drawn consistently gets no line at all; write "SCALE: none" when no object departs. Do not estimate a size, a ratio, a percentage or a measurement for any page, and do not write a page-by-page list — name the departing pages or nothing.',
  ].join('\n');
  return { text, asked };
}

/** SCALE[LARGER]: dragon egg — p3, p5 */
const SCALE_LINE_RE = /^[ \t>*-]*SCALE\[(LARGER|SMALLER)\]\s*:\s*([^—–\-\n]*?)\s*[—–-]+\s*(.*)$/gim;

/** An explicit, deliberate "nothing departs". */
const SCALE_NONE_RE = /^[ \t>*-]*SCALE\s*:\s*none\b/im;

/**
 * Read the scale answer out of the reviewer's ordinary reply.
 *
 * Returns null when the reply carries NEITHER a SCALE line NOR an explicit
 * "SCALE: none" — a truncated or skipped answer is a missing measurement, not
 * a clean one, and reading it as clean is the failure this whole file exists
 * to avoid.
 *
 * @returns {{larger: Object<string, number[]>, smaller: Object<string, number[]>}|null}
 */
function parseScaleAnswer(raw) {
  const text = String(raw == null ? '' : raw);
  const out = { larger: {}, smaller: {} };
  let sawLine = false;
  SCALE_LINE_RE.lastIndex = 0;
  for (const m of text.matchAll(SCALE_LINE_RE)) {
    sawLine = true;
    const bucket = m[1].toUpperCase() === 'LARGER' ? out.larger : out.smaller;
    const label = m[2].replace(/^["'“]|["'”]$/g, '').trim();
    const pages = [...new Set(
      [...String(m[3]).matchAll(/\bp?(\d{1,3})\b/gi)].map(x => parseInt(x[1], 10))
    )].sort((a, b) => a - b);
    if (!label || pages.length === 0) continue;
    bucket[label] = [...new Set([...(bucket[label] || []), ...pages])].sort((a, b) => a - b);
  }
  if (!sawLine && !SCALE_NONE_RE.test(text)) return null;
  return out;
}

/**
 * The finding text.
 *
 * It states two things a reader must weigh it by, both measured:
 *   - a SINGLE read carries 2-3 false positives per run (pages within +/-11%
 *     of the mean). Accepted deliberately, because this flags for a human and
 *     fires no paid edit — a false positive costs a glance;
 *   - the SMALLER side is the weaker of the two directions.
 */
function buildScaleFinding(label, larger, smaller) {
  const parts = [];
  if ((larger || []).length) parts.push(`drawn larger than on the other pages on ${larger.map(p => `p${p}`).join(', ')}`);
  if ((smaller || []).length) parts.push(`drawn smaller on ${smaller.map(p => `p${p}`).join(', ')} (the weaker of the two directions)`);
  if (!parts.length) return null;
  return `SCALE: "${label}" — ${parts.join('; ')}. One read, so expect the odd page named that is really within a tenth of the others; check by eye. Reported for a human — nothing is repainted.`;
}

module.exports = {
  SCALE_COLLECTIONS,
  MIN_PAGES,
  baseId,
  citedIds,
  selectScaleObjects,
  buildScaleQuestion,
  parseScaleAnswer,
  buildScaleFinding,
};
