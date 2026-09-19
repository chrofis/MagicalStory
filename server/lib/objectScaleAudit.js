/**
 * OBJECT SCALE — ONE call per story, over every page the prop appears on.
 *
 * A recurring prop (an egg, a vehicle, a creature) is drawn at a different
 * size from page to page, and nothing in the pipeline sees it: every per-page
 * judge reads ONE image against ONE brief, so a prop that is football-sized on
 * one page and fist-sized on another scores clean on both. Size is only
 * visible when the pages that carry the prop are read TOGETHER.
 *
 * WHY IT IS ONE WHOLE-BOOK ASK AND NOT A PER-CHUNK ONE (measured 2026-09-19):
 * the audit used to split the book into 6-page chunks, so a question rebuilt
 * per chunk asked "larger than on the OTHER pages" of a fragment. On
 * job_1789759147125_p08djwhbl the egg's 9 pages were split across three calls
 * and the whole-book question was never asked once: the run returned
 * "SCALE: none" twice and named an unrelated animal in the third chunk -
 * 0 of 3 true outliers, 2 false positives, with parsing and scoping working
 * perfectly. The measurement failed, not the plumbing.
 *
 * WHY NOT ARITHMETIC FROM THE STORED BOXES (checked 2026-09-19 before any
 * code was written, because it would have been free): there are no stored
 * object boxes. `bboxDetection.objects` is EMPTY on every page of both
 * candidate stories — object grounding is gated OFF by the owner since
 * 2026-08-10 (figureDetection.js, `GDINO_GROUND_OBJECTS`) because no consumer
 * existed and each object cost a DINO forward pass per page. The ratio route
 * has no input, so it is not built.
 *
 * ONE COMPLETE ASK, IN ITS OWN CALL - and that separation was measured, not
 * assumed. The book audit now reads the WHOLE book in one call
 * (bookAudit.MAX_PAGES_PER_CALL), which removed the only reason this question
 * could not ride along, so folding it in was built and run: on
 * job_1789759147125_p08djwhbl the folded call returned 5 and 6 reader's-eye
 * faults on two runs where the same call WITHOUT the size question returned 16
 * on the same book the same day, and thought less (7.0-7.7k vs 8.6k thinking
 * tokens). The size question takes attention from the reading, so it keeps its
 * own call: an 18-page book makes TWO audit calls, down from four. The ask is
 * cheap (images only, no page text, only the pages a candidate prop is on:
 * 3.7k input / 36 output measured).
 *
 * AND IT STILL BARELY MEASURES THE THING (validated on the real story,
 * 2026-09-19 — this is the honest state of the check, read it before trusting
 * a finding):
 *  - truth on job_1789759147125_p08djwhbl, by eye: the egg is clearly larger on
 *    p3 (1.69) and p5 (1.83) and clearly smaller on p9 (0.65), with p8 (0.88)
 *    borderline and p2/p4/p7/p14/p16 within the pack (0.94-1.32).
 *  - chunked shape (superseded): "SCALE: none" for the egg twice and an
 *    unrelated animal in the third chunk. 0 of 3 hits, 2 false positives.
 *  - whole-book ask, all three qualifying props, 13 pages, one call:
 *    "SCALE[SMALLER]: dragon egg — p8, p9, p14, p16" and
 *    "SCALE[SMALLER]: Raven — p11". It found the real small outlier p9 and the
 *    borderline p8, and MISSED BOTH large outliers (p3, p5) entirely.
 *    1 of 3 hits, 2-3 false positives (p14, p16, the raven).
 *  - an earlier egg-only whole-book read named p16 alone — 0 of 3.
 * So the chunking was a real structural defect and is fixed here, and fixing it
 * moved the result from 0/3 to 1/3: the LARGER direction is still invisible to
 * the judge at this model and this phrasing. The finding text says so, nothing
 * is repaired, and whether the check earns its extra call is an open question
 * for the owner (tasks/BACKLOG.md).
 *
 * WHAT WAS MEASURED ABOUT THE WORDING EARLIER THAT DAY (CHF ~1.9). Read it as
 * the reason the wording is what it is, NOT as evidence the check works — the
 * real-story validation above is the evidence, and it is negative:
 *  - Asking for a per-page RATIO does not work: ceiling ~4/6 on direction
 *    alone, mean error 0.30-0.67, and the verdicts move with the page order.
 *    So the question asks for OUTLIERS, never numbers.
 *  - Asking which pages are significantly LARGER or SMALLER than the rest is
 *    the phrasing that produced a stable signal — the true outliers were named
 *    in every order tried. That phrasing is kept verbatim.
 *  - A single read also carries false positives (pages within +/-11% of the
 *    mean). ACCEPTED: this finding flags for a human and never fires a paid
 *    edit, so a false positive costs a glance. The finding text says so.
 *  - The SMALLER side looked weaker in the wording trials. The real-story
 *    validation inverted that: SMALLER was the only direction that hit, and
 *    LARGER was missed entirely. The finding reports both facts.
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
 * The question, built ONCE for every page the candidate props appear on.
 *
 * `batchPages` is the full set of pages the audit could read — the caller
 * passes the whole book, never a chunk. A prop is named only when at least two
 * of those pages show it ("larger than on the other pages" is unanswerable
 * from a single picture), and with nothing to ask the text is empty and no
 * call is made at all.
 *
 * The three things the measurement says must stay in the wording: outliers
 * only (never a ratio), the ban on per-page numeric estimates (ignoring it
 * truncated a read), and explicit permission to answer "none".
 *
 * @param {Array} candidates   rows from selectScaleObjects
 * @param {number[]} batchPages every page the audit resolved, in reading order
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
    'OBJECT SIZE. Below are pages from one finished picture book, in reading order: a label for each page followed by the picture on it. These recurring objects appear on the pages named:',
    ...lines,
    '',
    'Looking only at how large each object is DRAWN relative to the people and the surroundings in its own picture, is it rendered significantly LARGER on some of those pages than on the rest, or significantly SMALLER? Its colour, its markings, its position and what is happening in the story are outside this question.',
    '',
    'Name only the pages that depart from how the object looks on the others. Say nothing about a page that sits near the rest. For each object write at most one line of each kind, at the left margin:',
    'SCALE[LARGER]: <object> — p<N>, p<N>',
    'SCALE[SMALLER]: <object> — p<N>',
    '',
    'An object drawn consistently gets no line at all; write "SCALE: none" when no object departs. Do not estimate a size, a ratio, a percentage or a measurement for any page, and do not write a page-by-page list — name the departing pages or nothing. Write nothing else.',
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
 * It states what the reader must weigh it by, measured on the one real story
 * it has been validated against: the check named 1 of 3 true outliers (the
 * small one), missed both large ones, and named 2-3 pages that were fine. So a
 * SCALE line is a prompt to go and look, never a verdict — and a silent run is
 * not evidence the book is consistent. It flags a human and fires no paid edit,
 * so the cost of being wrong is a glance.
 */
function buildScaleFinding(label, larger, smaller) {
  const parts = [];
  if ((larger || []).length) parts.push(`drawn larger than on the other pages on ${larger.map(p => `p${p}`).join(', ')}`);
  if ((smaller || []).length) parts.push(`drawn smaller on ${smaller.map(p => `p${p}`).join(', ')} (the direction measured as weaker on earlier reads, though it is the one that hit on the validation story)`);
  if (!parts.length) return null;
  return `SCALE: "${label}" — ${parts.join('; ')}. LOW CONFIDENCE: on the one story this check was validated against it named 1 of 3 true outliers, missed both pages where the object was drawn too LARGE, and named 2-3 pages that were fine, so treat this as "go and look", not as a verdict. Reported for a human — nothing is repainted.`;
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
