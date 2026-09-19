/**
 * CROSS-PAGE OBJECT SCALE CONSISTENCY — a reported finding, never a repair.
 *
 * A recurring prop (an egg, a vehicle, a creature) is drawn at a different
 * size from page to page, and nothing in the pipeline sees it: every per-page
 * judge reads ONE image against ONE brief, so a prop that is football-sized on
 * one page and fist-sized on another scores 100 on both. Scale is only visible
 * ACROSS the book — which is where the book audit already stands, reading
 * every page's words and picture together.
 *
 * WHAT WAS MEASURED (2026-09-19, job_1789759147125_p08djwhbl, CHF ~1.9):
 *
 *  - Asking a vision judge for a PER-PAGE ratio does not work. Three separate
 *    tests, ceiling ~4/6 on direction alone, mean error 0.30-0.67. Worse, the
 *    batched per-page verdicts are ORDER-DEPENDENT: shuffling the page order
 *    flipped 5 of 9 verdicts on byte-identical images, and the judge's chosen
 *    reference page moved with position. Reproduced on a second story.
 *  - Asking only for OUTLIERS does work, on the LARGER side, at the
 *    INTERSECTION. Four orders run; the intersection across the three that
 *    answered was exactly the true outliers (p3, p5) with zero false
 *    positives, regardless of position. Each single run's list carried false
 *    positives (p7, p2, p4 — all within +/-11% of the mean), so the
 *    intersection is the result and no single call ever is.
 *  - The SMALLER side is weaker: p9 (a true small outlier) was named twice with
 *    a false positive attached, then dropped entirely in the fourth order.
 *  - 1 run in 4 returned nothing, truncating on its own reasoning after
 *    ignoring the "no per-page numbers" instruction and enumerating estimates.
 *    Hence that instruction is explicit in the prompt, and hence a run that
 *    does not answer is a MISSING measurement, never a partial one.
 *
 * So: three shuffled calls, act on the intersection, and below three usable
 * answers the check reports itself NOT EVALUATED rather than acting on a
 * partial set. This is the same confirm-and-intersect discipline the style
 * audit's CONFIRMATION_FLAG_RATIO enforces (memory `grid_judge_collapse`,
 * Lab 985-987): a batched VLM verdict that an independent sample does not
 * reproduce is not evidence.
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

/** Below this many pages there is no meaningful average to depart from. */
const MIN_PAGES = 4;

/** Shuffled calls per object, and the answers needed to intersect them. */
const SCALE_CALLS = 3;
const MIN_ANSWERS = 3;

/**
 * Objects audited per book. Three vision calls each, so this is a cost cap,
 * not a judgement about which props matter; the ones left out are recorded as
 * not evaluated rather than dropped in silence.
 */
const MAX_OBJECTS = 2;

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
 * Pick the props worth a scale pass.
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
  const maxObjects = opts.maxObjects == null ? MAX_OBJECTS : opts.maxObjects;
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
  const eligible = [];
  for (const r of rows) {
    if (r.pages.length < minPages) skipped.push({ ...r, reason: 'too_few_pages' });
    else eligible.push(r);
  }
  // Most-seen first: the prop a reader meets on the most pages is the one whose
  // size drift a reader actually notices.
  eligible.sort((a, b) => b.pages.length - a.pages.length || a.id.localeCompare(b.id));
  const candidates = eligible.slice(0, maxObjects);
  for (const r of eligible.slice(maxObjects)) skipped.push({ ...r, reason: 'object_budget_exhausted' });

  return { candidates, skipped };
}

/** Deterministic PRNG so a shuffle order is reproducible from a run's seed. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fisher-Yates with a seeded PRNG. The ORDER is the variable this check exists
 * to cancel: the same pages in a different order produced different verdicts,
 * so every call gets its own order and only what survives all of them is
 * reported.
 */
function shuffleWithSeed(items, seed) {
  const out = [...items];
  const rand = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

/**
 * Read one reply's two lists.
 *
 * Returns null when the reply carries NEITHER line — a truncated or refused run
 * is not an empty result, and treating it as one would let a silent failure
 * shrink an intersection to nothing (or, worse, agree with it).
 */
function parseScaleReply(raw) {
  const text = String(raw == null ? '' : raw);
  const read = (word) => {
    const m = text.match(new RegExp('^[ \\t>*-]*' + word + '\\s*:(.*)$', 'im'));
    if (!m) return null;
    const body = m[1].trim();
    if (!body || /^(none|n\/a|-|–|—|\(none\))$/i.test(body)) return [];
    return [...new Set(
      [...body.matchAll(/\bp?(\d{1,3})\b/gi)].map(x => parseInt(x[1], 10))
    )].sort((a, b) => a - b);
  };
  const larger = read('LARGER');
  const smaller = read('SMALLER');
  if (larger === null && smaller === null) return null;
  return { larger: larger || [], smaller: smaller || [] };
}

/**
 * The pages named by EVERY list. Not a majority, not a union: a page named by
 * two runs of three was measured to be a false positive as often as a real
 * outlier, and the union was wrong on every order tried.
 */
function intersectOutliers(lists) {
  if (!Array.isArray(lists) || lists.length === 0) return [];
  const sets = lists.map(l => new Set((l || []).map(Number)));
  const [first, ...rest] = sets;
  return [...first]
    .filter(p => rest.every(s => s.has(p)))
    .sort((a, b) => a - b);
}

/**
 * The finding text. It states the two directions' DIFFERENT strength on
 * purpose: the larger side is measured reliable at the intersection, the
 * smaller side is not, and a reader who weighs them equally is over-trusting
 * the half that was measured to drop a true outlier.
 */
function buildScaleFinding(label, larger, smaller) {
  const parts = [];
  if ((larger || []).length) {
    parts.push(`drawn larger than its typical size on ${larger.map(p => `p${p}`).join(', ')} `
      + '(all three shuffled reads agreed — the measured-reliable direction)');
  }
  if ((smaller || []).length) {
    parts.push(`drawn smaller on ${smaller.map(p => `p${p}`).join(', ')} `
      + '(the weaker direction — a reordering was measured to drop a true small outlier, so read this as a pointer, not a verdict)');
  }
  if (!parts.length) return null;
  return `SCALE: "${label}" — ${parts.join('; ')}. Reported for a human; nothing is repainted.`;
}

module.exports = {
  SCALE_COLLECTIONS,
  MIN_PAGES,
  SCALE_CALLS,
  MIN_ANSWERS,
  MAX_OBJECTS,
  baseId,
  citedIds,
  selectScaleObjects,
  shuffleWithSeed,
  parseScaleReply,
  intersectOutliers,
  buildScaleFinding,
};
