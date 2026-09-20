/**
 * OBJECT SCALE — ONE call per qualifying prop, over only the pages that prop
 * appears on.
 *
 * A recurring prop (an egg, a vehicle) is drawn at a different size from page
 * to page, and nothing in the pipeline sees it: every per-page judge reads ONE
 * image against ONE brief, so a prop that is football-sized on one page and
 * fist-sized on another scores clean on both. Size is only visible when the
 * pages that carry the prop are read TOGETHER.
 *
 * WHAT IT COSTS, SAID PLAINLY: one vision call PER QUALIFYING PROP. It is not
 * free and it is not one call per story. A prop qualifies when it is cited by a
 * brief on >= 4 audited pages, carries a declared size in the bible, and is not
 * an animal (below). On job_1789759147125_p08djwhbl that is exactly ONE call
 * (the dragon egg); a story with three declared-size artifacts or vehicles on
 * >= 4 pages each makes three, at ~3.7k input / ~36 output tokens each
 * (≈ CHF 0.005 per call on gemini-2.5-flash).
 *
 * WHY ONE PROP PER CALL AND NOT ALL PROPS IN ONE (measured 2026-09-19, two runs
 * per arm, same model, temperature 0, same wording — only the prop count and
 * the page set changed, on job_1789759147125_p08djwhbl):
 *  - truth by eye: the egg is clearly larger on p3 (1.69x) and p5 (1.83x) and
 *    clearly smaller on p9 (0.65x), p8 (0.88) borderline, the rest 0.94-1.32.
 *  - ONE PROP PER CALL (what ships): the measuring arm returned
 *    "SCALE[LARGER]: dragon egg — p4, p5" in both runs, byte-identical. It
 *    catches p5 — the boulder, the book's most visible size defect — with one
 *    mild false positive (p4 at 1.22, essentially the book's own mean ~1.19).
 *  - THE SHIPPED BUILDER, validated after the rewrite to a singular one-prop
 *    question (2 runs, byte-identical, 2.6k in / 28 out / 2.3k thinking,
 *    ≈ CHF 0.005 per run): "SCALE[LARGER]: dragon egg — p4, p5" AND
 *    "SCALE[SMALLER]: dragon egg — p8, p16". The singular phrasing recovered a
 *    SMALLER line the measuring arm did not produce: p8 (0.88) is the real
 *    borderline small page, p16 (0.94) is not. Net on the shipped wording:
 *    p5 caught, p8 caught, p3 and p9 missed, p4 and p16 named in error — and
 *    it is stable run to run. The finding text carries exactly this.
 *  - ALL PROPS IN ONE CALL (the previous shape): "SCALE[SMALLER]: dragon egg —
 *    p8, p9, p14, p16" in both runs — it names the egg SMALLER on the pages
 *    where it is genuinely smallest, i.e. the WRONG direction for a book whose
 *    visible defect is a giant egg, plus three innocent pages, plus a raven.
 * So the prop count moves the answer, and one-prop-per-call is strictly better:
 * right direction, the worst offender named stably, one mild FP instead of
 * three. That is the bar, because THIS CHECK FLAGS A HUMAN AND FIRES NO REPAIR
 * — perfect recall was never the requirement (owner, 2026-09-19).
 *
 * WHY ANIMALS ARE EXCLUDED BY CONSTRUCTION. Measured on the same story: the dog
 * correctly returned "SCALE: none", and the raven returned a finding that is
 * MEANINGLESS BY NATURE — a bird's apparent size changes with its wing spread,
 * and the same is true of any animal's pose. An animal has no stable drawn size
 * to compare across pages, so the question cannot be asked of one. The raven
 * false positive disappears by construction rather than by judgement.
 *
 * WHY A DECLARED SIZE IS REQUIRED. A prop with no `scaleClass` band and no
 * stored free-text `size` has no authored size at all, so "drawn larger than it
 * should be" has no referent — and asking anyway spends a call per prop. The
 * gate reuses `elementScaleNote()` (visualBible.js), the same one-source-of-
 * truth read the image prompt uses, so this check and the generator agree on
 * what "declared size" means.
 *
 * WHY NOT ARITHMETIC FROM THE STORED BOXES (checked 2026-09-19 before any code
 * was written, because it would have been free): there are no stored object
 * boxes. `bboxDetection.objects` is EMPTY on every page of both candidate
 * stories — object grounding is gated OFF by the owner since 2026-08-10
 * (figureDetection.js, `GDINO_GROUND_OBJECTS`). The ratio route has no input.
 *
 * WHY IT IS ITS OWN CALL AND NOT FOLDED INTO THE BOOK AUDIT. Measured the same
 * day: with the size question appended to the whole-book reading call, the
 * reader's-eye pass returned 5 and 6 faults on two runs where the same call
 * WITHOUT it returned 16 on the same book — and it thought less (7.0-7.7k vs
 * 8.6k thinking tokens). The size question takes attention from the reading.
 *
 * WHY REPEATS BUY NOTHING. An earlier {p3, p5} success was three runs in
 * DIFFERENT PAGE ORDERS, intersected; each single run carried false positives
 * ([5,3,7], [3,5,4,2], [4,5,3]). At temperature 0 a repeat in the SAME order is
 * deterministic, so the signal came from shuffling, not repeating — and three
 * shuffled calls PER PROP is ruled too expensive. One call it is.
 *
 * WHAT WAS MEASURED ABOUT THE WORDING (CHF ~1.9, same day). Read it as the
 * reason the wording is what it is:
 *  - Asking for a per-page RATIO does not work: ceiling ~4/6 on direction
 *    alone, mean error 0.30-0.67, and the verdicts move with the page order.
 *    So the question asks for OUTLIERS, never numbers.
 *  - "significantly LARGER or SMALLER than the rest" is the phrasing that
 *    produced a stable signal. It is kept verbatim.
 *  - One read in four truncated after ignoring a "no per-page numbers"
 *    instruction and enumerating estimates. That ban is therefore explicit, and
 *    a reply with no usable answer is recorded as NOT EVALUATED rather than
 *    read as "no outliers".
 *
 * NOTHING HERE REPAIRS. Shrinking a prop was measured to strand the hands off
 * it and never reached the target size anyway, and the reference-cell area
 * lever is dead (SETTLED.md, 2026-09-19). The finding goes to a human.
 */

/**
 * The collections whose entries have a stable real-world size a reader can
 * misjudge. Characters are excluded (their scale is the cast's own problem and
 * the reference sheets pin it), clothing is worn so it has no independent size,
 * and a location IS the frame rather than an object inside it.
 *
 * ANIMALS ARE EXCLUDED DELIBERATELY (measured 2026-09-19, see the file header):
 * an animal's apparent size changes with its pose — a raven with its wings
 * spread is not a raven that grew — so a size outlier named for one is
 * meaningless by nature, not merely unreliable.
 */
const SCALE_COLLECTIONS = ['artifacts', 'vehicles'];

/** Below this many pages there is no meaningful rest-of-the-book to compare to. */
const MIN_PAGES = 4;

/** `ART001.2` and `ART001` are the same bible entry. */
function baseId(id) {
  const s = String(id == null ? '' : id).trim();
  const m = s.match(/^([A-Z]{2,4}\d{1,3})/);
  return m ? m[1] : (s || null);
}

/**
 * The object ids a scene's Art Director brief cites, deduped, base form.
 *
 * Three shapes, one answer: the full page object (`sceneMetadata.objects`), a
 * page carrying `objects` directly, or an already-projected audit page carrying
 * a flat `citedIds` array (bookAudit.buildAuditPages). The third exists because
 * the audit is handed a PROJECTION of the book, not the book — and when the
 * projection dropped the citations this check went silently blind.
 */
function citedIds(scene) {
  const raw = (scene && scene.citedIds)
    || (scene && scene.sceneMetadata && scene.sceneMetadata.objects)
    || (scene && scene.objects) || [];
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
 * Three gates, and each one removes a measured failure rather than a guess:
 * the entry is in a NON-ANIMAL scale collection (an animal's drawn size moves
 * with its pose), it carries a DECLARED size (`scaleClass` band, or a stored
 * pre-enum free-text `size` — read through the shared `elementScaleNote()` so
 * this check and the image prompt agree on what "declared" means), and a brief
 * CITES it on at least `minPages` audited pages.
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
  // The one source of scale truth, shared with the image prompt: the authored
  // `scaleClass` band's phrase, or a pre-enum bible's stored free-text `size`.
  const { elementScaleNote } = require('./visualBible');
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
        declaredSize: elementScaleNote(entry),
      });
    }
  }

  const skipped = [];
  const candidates = [];
  for (const r of rows) {
    if (!r.declaredSize) skipped.push({ ...r, reason: 'no_declared_size' });
    else if (r.pages.length < minPages) skipped.push({ ...r, reason: 'too_few_pages' });
    else candidates.push(r);
  }
  // Most-seen first: the prop a reader meets on the most pages is the one whose
  // size drift a reader actually notices.
  candidates.sort((a, b) => b.pages.length - a.pages.length || a.id.localeCompare(b.id));
  return { candidates, skipped };
}

/**
 * The question, built for ONE prop, over every page that ONE prop is on.
 *
 * ONE PROP PER CALL is the measured shape (file header): asking about all the
 * story's props together flipped the judge onto the wrong side of the book's
 * real defect and carried three false positives; asking about the egg alone
 * named the boulder page in both runs, byte-identical, with one mild FP.
 *
 * `batchPages` is the set of pages the audit could read — the caller passes the
 * whole book, never a chunk. The prop is asked about only when at least two of
 * those pages show it ("larger than on the other pages" is unanswerable from a
 * single picture), and with nothing to ask the text is empty and no call is
 * made at all.
 *
 * The three things the measurement says must stay in the wording: outliers
 * only (never a ratio), the ban on per-page numeric estimates (ignoring it
 * truncated a read), and explicit permission to answer "none".
 *
 * @param {Object} candidate   ONE row from selectScaleObjects
 * @param {number[]} batchPages every page the audit resolved, in reading order
 * @returns {{text: string, asked: Object|null}} `text` is '' when nothing qualifies
 */
function buildScaleQuestion(candidate, batchPages) {
  if (!candidate) return { text: '', asked: null };
  const inBatch = new Set((batchPages || []).map(Number));
  const here = (candidate.pages || []).filter(p => inBatch.has(Number(p)));
  if (here.length < 2) return { text: '', asked: null };
  const asked = { ...candidate, batchPages: here };

  const text = [
    'OBJECT SIZE. Below are pages from one finished picture book, in reading order: a label for each page followed by the picture on it. One recurring object appears on the pages named:',
    `- ${asked.label}: pages ${here.map(p => `p${p}`).join(', ')}`,
    '',
    'Looking only at how large that object is DRAWN relative to the people and the surroundings in its own picture, is it rendered significantly LARGER on some of those pages than on the rest, or significantly SMALLER? Its colour, its markings, its position and what is happening in the story are outside this question.',
    '',
    'Name only the pages that depart from how the object looks on the others. Say nothing about a page that sits near the rest. Write at most one line of each kind, at the left margin:',
    'SCALE[LARGER]: <object> — p<N>, p<N>',
    'SCALE[SMALLER]: <object> — p<N>',
    '',
    'An object drawn consistently gets no line at all; write "SCALE: none" when it does not depart on any page. Do not estimate a size, a ratio, a percentage or a measurement for any page, and do not write a page-by-page list — name the departing pages or nothing. Write nothing else.',
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
 * It states what the reader must weigh it by, measured on the one real story it
 * has been validated against in the shipped one-prop-per-call shape: it names
 * the book's most visible size outlier, stably across repeat runs, and it also
 * names the occasional page that merely sits at the book's own average, and it
 * misses the milder outliers. So a SCALE line is a prompt to go and look, never
 * a verdict — and a silent run is not evidence the book is consistent. It flags
 * a human and fires no paid edit, so the cost of being wrong is a glance.
 */
function buildScaleFinding(label, larger, smaller) {
  const parts = [];
  if ((larger || []).length) parts.push(`drawn larger than on the other pages on ${larger.map(p => `p${p}`).join(', ')}`);
  if ((smaller || []).length) parts.push(`drawn smaller on ${smaller.map(p => `p${p}`).join(', ')}`);
  if (!parts.length) return null;
  return `SCALE: "${label}" — ${parts.join('; ')}. LOW CONFIDENCE: on the one story this check was validated against it named the worst size outlier in the book and repeated that answer exactly, byte-identical, across two runs; it also named two pages that merely sit near the book's own average size, and it missed two milder outliers — so treat this as "go and look", not as a verdict, and do not read a quiet run as proof the object is consistent. Reported for a human — nothing is repainted.`;
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
