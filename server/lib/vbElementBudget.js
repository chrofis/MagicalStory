/**
 * VB ELEMENT BUDGET — never more than three Visual Bible elements on a page.
 *
 * Owner ruling, 2026-09-06: "Never more than 3 VB elements per scene. Drop the
 * least important ones if more are requested. Do a mechanical check of it and
 * feed it into the feedback loop."
 *
 * A Visual Bible ELEMENT is a bible entry that becomes a reference image packed
 * into the page's Grok slot — the same set `getElementReferenceImagesForPage`
 * (visualBible.js) selects: secondary characters, animals, artifacts and
 * vehicles. LOCATIONS DO NOT COUNT — none of them (owner ruling, 2026-09-08,
 * superseding the 2026-09-06 wording: "Do not count it as it is the empty scene
 * not an artifact"). A real landmark ships as a photograph, and an invented
 * location is what the empty-scene plate is built from — the backdrop the
 * characters are composited into, not a prop competing for a slot. Counting it
 * spent it twice. The selection still hands the page its location cell, LAST
 * and at most one, so the slot holds at most VB_ELEMENT_BUDGET + 1 = 4 cells,
 * which is exactly Grok's VB_SLOT_MAX_ELEMENTS.
 *
 * Two sources put an element on a page, and both are counted, because both feed
 * the selection: the brief's own `objects[]` (an id the Art Director asked for)
 * and the bible entry's `appearsInPages` (the bible's own answer).
 *
 * RANKING (the "least important" the ruling drops). Data, never prose:
 *   0. a recurring creature — pinned first, exactly as visualBible.js pins it.
 *   1. type: character < animal < artifact < vehicle. This is the priority
 *      order the selection already sorts by (visualBible.js
 *      getElementReferenceImagesForPage, mirrored in grok.js VB_TYPE_PRIORITY)
 *      — using any other order here would make the code-side truncation and
 *      the downstream cap keep different elements.
 *   2. focal on this page: the element is an actor or the object of a row in
 *      the brief's `interactions[]`. The page is about what is being handled.
 *   3. asked for: named in `objects[]` beats present only via `appearsInPages`.
 *   4. story weight: a longer `appearsInPages` first — an element the book keeps
 *      coming back to outranks a one-page prop.
 *   5. id, ascending — determinism, never insertion order.
 *
 * The check REPORTS into the scene review's fault block (sceneBriefCheck) and
 * the review's targeted second round carries it verbatim. A brief that still
 * overflows after that round SHIPS, with the lowest-ranked ids truncated out of
 * `objects[]` in code and a stored `vbElementOverflow` flag — a gate is a
 * guideline, it never kills a paid run.
 *
 * TWO HALVES, TWO ENFORCERS. Truncation can only take back what the BRIEF
 * asked for; an element the bible placed on the page through `appearsInPages`
 * is not the brief's to withdraw, so re-running the truncation on an already
 * truncated brief still counts it. That half is bounded where it actually
 * matters — the page-gen reference selection, which is called with this same
 * VB_ELEMENT_BUDGET and this same priority order (referenceSheets.js,
 * storyJobPipeline.js), so it keeps exactly the three this module ranks first.
 * Grok's own VB_SLOT_MAX_ELEMENTS stays at 4: it is the net under the paths
 * this budget does not author (covers, repair, iterate), and a page that
 * reaches it with four is a violation worth seeing rather than hiding.
 */

const { extractSceneMetadata, parseProseMetadataFormat } = require('./sceneMetadata');
const { getRecurringCreatureIds, entryNamedByRow } = require('./visualBible');

/** The owner's number. One source of truth for prompt, check and truncation. */
const VB_ELEMENT_BUDGET = 3;

/** Selection's priority order, by collection. Locations are not elements (header). */
const ELEMENT_COLLECTIONS = [
  { key: 'secondaryCharacters', type: 'character', priority: 1, viaObjects: true },
  { key: 'animals', type: 'animal', priority: 2, viaObjects: true },
  { key: 'artifacts', type: 'artifact', priority: 3, viaObjects: true },
  { key: 'vehicles', type: 'vehicle', priority: 4, viaObjects: true },
];

/**
 * `ART002.2` → `ART002`; anything that is not an id shape → null.
 * Delegates to the ONE grammar in vbIdGuard so the budget and the sanitiser
 * can never disagree about what a dotted handle's parent is.
 */
const { baseVbId: baseId } = require('./vbIdGuard');

/** Base ids named in a brief's `objects[]` (strings or {id} rows). */
function objectIds(objects = []) {
  const ids = [];
  for (const raw of (Array.isArray(objects) ? objects : [])) {
    const text = typeof raw === 'string' ? raw : (raw && (raw.id || raw.name));
    // Free text may still carry an id in brackets — "Signpost [ART004]".
    const direct = baseId(text);
    const bracketed = direct ? null : (String(text || '').toUpperCase().match(/\b[A-Z]{3}\d{3}(?:\.\d+)?\b/) || [])[0];
    const id = direct || baseId(bracketed);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** The `character` / `object` strings of the brief's interactions[], for the focal test. */
function interactionFields(metadata) {
  const rows = (metadata && Array.isArray(metadata.interactions)) ? metadata.interactions : [];
  const out = [];
  for (const row of rows) {
    for (const field of ['character', 'object']) {
      const v = String((row && row[field]) || '').trim();
      if (v) out.push(v);
    }
  }
  return out;
}

/**
 * The packable Visual Bible elements this page references, ranked most to least
 * important. Never throws: a missing bible yields an empty list.
 *
 * @param {number} pageNumber
 * @param {Object} metadata  the brief's parsed METADATA block
 * @param {Object} visualBible
 * @returns {Array<{id,name,type,priority,recurring,focal,fromObjects,appearsCount}>}
 */
function rankPageElements(pageNumber, metadata, visualBible) {
  if (!visualBible) return [];
  const asked = new Set(objectIds(metadata && metadata.objects));
  const fields = interactionFields(metadata);
  const recurring = new Set(getRecurringCreatureIds(visualBible).map(id => String(id).toUpperCase()));
  const rows = [];
  for (const col of ELEMENT_COLLECTIONS) {
    const entries = visualBible[col.key];
    for (const entry of (Array.isArray(entries) ? entries : [])) {
      if (!entry || !entry.id) continue;
      const id = baseId(entry.id) || String(entry.id).trim().toUpperCase();
      const onPage = Array.isArray(entry.appearsInPages) && entry.appearsInPages.includes(pageNumber);
      const named = col.viaObjects && asked.has(id);
      if (!onPage && !named) continue;
      const name = String(entry.name || '').trim();
      rows.push({
        id,
        name,
        type: col.type,
        recurring: recurring.has(id),
        priority: recurring.has(id) ? 0 : col.priority,
        focal: false,
        entry,
        fromObjects: !!named,
        appearsCount: Array.isArray(entry.appearsInPages) ? entry.appearsInPages.length : 0,
      });
    }
  }
  // Focal = an interactions[] row names the element — the ONE row→entry
  // matcher (visualBible.entryNamedByRow), disambiguated against every other
  // element on this page, so a paraphrased name still counts.
  const candidates = rows.map(r => r.entry);
  for (const r of rows) {
    r.focal = fields.some(f => entryNamedByRow(f, candidates) === r.entry);
    delete r.entry;
  }
  return rows.sort((a, b) => (
    (a.priority - b.priority)
    || (Number(b.focal) - Number(a.focal))
    || (Number(b.fromObjects) - Number(a.fromObjects))
    || (b.appearsCount - a.appearsCount)
    || a.id.localeCompare(b.id)
  ));
}

/** `Name (ID, type)` — how an element is named to the reviewer. */
function label(e) {
  return `${e.name || e.id} (${e.id}, ${e.type})`;
}

/**
 * One page against the budget.
 * @returns {Object|null} a sceneBriefCheck-shaped finding, or null when it fits
 */
function checkVbElementBudget(pageNumber, metadata, visualBible) {
  const ranked = rankPageElements(pageNumber, metadata, visualBible);
  if (ranked.length <= VB_ELEMENT_BUDGET) return null;
  const kept = ranked.slice(0, VB_ELEMENT_BUDGET);
  const dropped = ranked.slice(VB_ELEMENT_BUDGET);
  return {
    pageNumber,
    type: 'vb_element_overflow',
    requested: ranked.map(e => e.id),
    kept: kept.map(e => e.id),
    dropped: dropped.map(e => e.id),
    detail: `Page ${pageNumber} references ${ranked.length} Visual Bible elements: ${ranked.map(label).join(', ')} — `
      + `keep at most ${VB_ELEMENT_BUDGET}: drop ${dropped.map(label).join(', ')}. `
      + `Take the dropped ids out of objects[] and out of the prose; whatever the page is about stays.`,
  };
}

/**
 * The counter over a whole story's briefs.
 *
 * @param {Array} sceneDescriptions  [{pageNumber, brief|sceneDescription|metadata|objects}]
 * @param {Object} visualBible
 * @returns {Array} findings, one per overflowing page, page order
 */
function buildVbElementFindings(sceneDescriptions = [], visualBible = null) {
  const findings = [];
  for (const sd of (Array.isArray(sceneDescriptions) ? sceneDescriptions : [])) {
    if (!sd) continue;
    const pageNumber = Number(sd.pageNumber ?? sd.page);
    if (!Number.isFinite(pageNumber)) continue;
    const metadata = sd.metadata
      || (sd.objects ? { objects: sd.objects, interactions: sd.interactions } : null)
      || extractSceneMetadata(String(sd.brief || sd.sceneDescription || ''))
      || {};
    const f = checkVbElementBudget(pageNumber, metadata, visualBible);
    if (f) findings.push(f);
  }
  return findings.sort((a, b) => a.pageNumber - b.pageNumber);
}

/**
 * STRIKE TWO. Apply the budget in code: drop the lowest-ranked element ids from
 * `objects[]` so the packer never sees more than three. Returns null when the
 * page already fits, so the caller only flags what it actually changed.
 *
 * Only ids the brief itself asked for can be removed — an element present via
 * `appearsInPages` is the bible's claim, not the brief's, and stays for the
 * page-gen selection cap (VB_ELEMENT_BUDGET, visualBible.js) to bound with the
 * same ranking.
 *
 * @returns {{objects: Array, requested: string[], kept: string[], dropped: string[]}|null}
 */
function truncateSceneObjects(metadata, visualBible, pageNumber) {
  const finding = checkVbElementBudget(pageNumber, metadata, visualBible);
  if (!finding) return null;
  const drop = new Set(finding.dropped);
  const objects = (Array.isArray(metadata && metadata.objects) ? metadata.objects : [])
    .filter((raw) => {
      const ids = objectIds([raw]);
      return !(ids.length === 1 && drop.has(ids[0]));
    });
  return { objects, requested: finding.requested, kept: finding.kept, dropped: finding.dropped };
}

/**
 * STRIKE TWO, applied to the brief TEXT — the form every downstream stage reads.
 * Re-serialises the `---METADATA---` block with the over-budget ids removed from
 * `objects[]`. Returns null when the page fits or when the brief has no
 * parseable metadata block (nothing to truncate, and never a throw).
 *
 * @returns {{brief: string, requested: string[], kept: string[], dropped: string[]}|null}
 */
function truncateBriefToBudget(brief, visualBible, pageNumber) {
  const parsed = parseProseMetadataFormat(String(brief || ''));
  if (!parsed) return null;
  const result = truncateSceneObjects(parsed.metadata, visualBible, pageNumber);
  if (!result) return null;
  const metadata = { ...parsed.metadata, objects: result.objects };
  return {
    brief: `${parsed.prose}

---METADATA---
${JSON.stringify(metadata, null, 2)}`,
    requested: result.requested,
    kept: result.kept,
    dropped: result.dropped,
  };
}

/**
 * ASSIGNMENT TRIM — the budget enforced where the pages are ASSIGNED.
 *
 * `story-bible-from-beats.txt` says `pages` is earned by the plan line, and
 * the model does not obey it: measured on staging job_1788816451791_25b31uqlp
 * a worn backpack claimed 11 pages (a re-derivation: 15, named in 0 plan
 * lines) and 10-12 of 18 pages were over the budget at birth. Nothing checked
 * it. Downstream the scene review found `vb_element_overflow` on 11 pages and
 * could fix none of them, because a brief cannot withdraw what the bible
 * placed (`briefFixable:false`). This is the deterministic post-check the
 * prompt rule never had, run once on the freshly parsed bible, before the Art
 * Director sees it.
 *
 * Per page, counting EXACTLY what `rankPageElements` counts (no brief exists
 * yet, so it is `appearsInPages` alone; locations are not counted there, so a
 * location — real or invented — is never stripped here): when more than
 * VB_ELEMENT_BUDGET entries claim the page, keep
 *   (a) entries whose name/properName tokens occur in that page's PLAN LINE,
 *   (b) then the rest in `rankPageElements` order,
 * and strip the page from every loser's `appearsInPages` (and its `pages`
 * twin — the parser keeps both and several readers prefer `pages`).
 *
 * Token matching is mechanical and lexical, on the plan line only — never
 * prose classification, never the story text: a name is split into words of
 * four letters or more, a trailing parenthetical is ignored ("(face to
 * camera)"), a short function-word list is dropped, and for anything that is
 * not itself a person or creature the cast's own names are dropped too, so
 * "<owner>'s satchel" is named by "satchel", never by the owner riding along
 * on every page. A token matches as a word prefix ("scale" matches "scales").
 *
 * STATE CONTRACT: `objectStateForPage` assumes every page of an entry lies in
 * exactly one state's `pages[]`. A page stripped from an entry is stripped
 * from its states too; a state left with no page is dropped and the remaining
 * states are re-minted through `normaliseObjectStates` so the dotted ids stay
 * dense (nothing has cited a handle yet — this runs before the briefs exist).
 *
 * Never throws, never fails the run: a bible with no plan lines is returned
 * untouched with an empty report.
 *
 * @param {Object} visualBible  parsed bible (MUTATED in place)
 * @param {Array<{pageNumber:number, planLine:string}>} planPages
 * @param {{castNames?: string[], budget?: number}} [opts]
 * @returns {{pagesOverBudgetBefore:number, pagesOverBudgetAfter:number,
 *   stripped:Array<{id:string,page:number,reason:string}>,
 *   droppedStates:Array<{id:string,parent:string}>}}
 */
const TRIM_STOPWORDS = new Set([
  'with', 'from', 'that', 'this', 'into', 'onto', 'over', 'under', 'seen', 'them',
  'their', 'there', 'where', 'when', 'what', 'which', 'small', 'large', 'little',
  'turned', 'away', 'face', 'camera', 'side', 'view',
]);

/** Lower-cased word tokens (>= 4 letters) of a name, parentheticals removed. */
function nameTokens(text) {
  return String(text || '')
    .replace(/\([^)]*\)/g, ' ')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(t => t.length >= 4 && !TRIM_STOPWORDS.has(t));
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Does the plan line contain any of the tokens as a word prefix? */
function planLineNames(planLine, tokens) {
  const line = String(planLine || '').toLowerCase();
  if (!line || tokens.length === 0) return false;
  return tokens.some(t => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(t)}`, 'u').test(line));
}

/** Remove one page from an entry's page lists and from each state's pages. */
function stripPage(entry, page, hadPages) {
  const drop = (arr) => (Array.isArray(arr) ? arr.filter(p => Number(p) !== page) : arr);
  entry.appearsInPages = drop(entry.appearsInPages);
  if (Array.isArray(entry.pages)) entry.pages = drop(entry.pages);
  for (const st of (Array.isArray(entry.states) ? entry.states : [])) {
    if (!st || !Array.isArray(st.pages)) continue;
    if (!hadPages.has(st)) hadPages.set(st, st.pages.length > 0);
    st.pages = drop(st.pages);
  }
}

function trimVbAssignments(visualBible, planPages = [], { castNames = [], budget = VB_ELEMENT_BUDGET } = {}) {
  const report = { pagesOverBudgetBefore: 0, pagesOverBudgetAfter: 0, stripped: [], droppedStates: [] };
  if (!visualBible || typeof visualBible !== 'object') return report;
  const { log } = require('../utils/logger');
  const { normaliseObjectStates } = require('./visualBible');

  const planByPage = new Map();
  for (const p of (Array.isArray(planPages) ? planPages : [])) {
    const n = Number(p && p.pageNumber);
    if (Number.isFinite(n)) planByPage.set(n, String(p.planLine || ''));
  }

  // Every counted entry by base id, with the collection it lives in.
  const byId = new Map();
  for (const col of ELEMENT_COLLECTIONS) {
    for (const entry of (Array.isArray(visualBible[col.key]) ? visualBible[col.key] : [])) {
      if (!entry || !entry.id) continue;
      byId.set(baseId(entry.id) || String(entry.id).trim().toUpperCase(), { entry, col });
    }
  }

  // Cast tokens: commissioned names plus the bible's own people and creatures.
  const castTokens = new Set();
  for (const n of (Array.isArray(castNames) ? castNames : [])) for (const t of nameTokens(n)) castTokens.add(t);
  for (const key of ['secondaryCharacters', 'animals']) {
    for (const e of (Array.isArray(visualBible[key]) ? visualBible[key] : [])) {
      for (const t of nameTokens(e && e.name)) castTokens.add(t);
    }
  }
  const tokensOf = ({ entry, col }) => {
    const toks = [...new Set([...nameTokens(entry.name), ...nameTokens(entry.properName)])];
    return (col.type === 'character' || col.type === 'animal') ? toks : toks.filter(t => !castTokens.has(t));
  };

  // Pages to check: every page any counted entry claims.
  const pages = new Set();
  for (const { entry } of byId.values()) {
    for (const p of (Array.isArray(entry.appearsInPages) ? entry.appearsInPages : [])) {
      const n = Number(p);
      if (Number.isFinite(n)) pages.add(n);
    }
  }

  const touched = new Set();
  const hadPages = new Map(); // state row -> had at least one page before any strip
  for (const page of [...pages].sort((a, b) => a - b)) {
    const ranked = rankPageElements(page, {}, visualBible);
    if (ranked.length <= budget) continue;
    report.pagesOverBudgetBefore++;
    const planLine = planByPage.get(page) || '';
    const named = [];
    const rest = [];
    for (const e of ranked) {
      const rec = byId.get(e.id);
      (rec && planLineNames(planLine, tokensOf(rec)) ? named : rest).push(e);
    }
    const keep = new Set([...named, ...rest].slice(0, budget).map(e => e.id));
    for (const e of ranked) {
      if (keep.has(e.id)) continue;
      const rec = byId.get(e.id);
      if (!rec) continue;
      const reason = named.includes(e)
        ? `named in the plan line but outranked: ${ranked.length} elements claim page ${page}, budget ${budget}`
        : (planLine
          ? `not named in page ${page}'s plan line; ${ranked.length} elements claim the page, budget ${budget}`
          : `page ${page} has no plan line; ${ranked.length} elements claim it, budget ${budget}`);
      stripPage(rec.entry, page, hadPages);
      touched.add(e.id);
      report.stripped.push({ id: e.id, page, reason });
      log.warn(`[VB-TRIM] ${e.id} "${rec.entry.name || ''}" loses page ${page} — ${reason}`);
    }
  }

  // State contract: a state with no page left is meaningless; drop and re-mint.
  for (const id of touched) {
    const { entry } = byId.get(id);
    if (!Array.isArray(entry.states) || entry.states.length === 0) continue;
    const emptied = entry.states.filter(st => st && hadPages.get(st) === true && Array.isArray(st.pages) && st.pages.length === 0);
    if (emptied.length === 0) continue;
    for (const st of emptied) {
      report.droppedStates.push({ id: st.id, parent: id });
      log.warn(`[VB-TRIM] ${st.id} "${st.name || ''}" dropped — every page of this state was stripped from ${id}`);
    }
    entry.states = normaliseObjectStates(entry.states.filter(st => !emptied.includes(st)), entry.id);
  }

  for (const page of pages) {
    if (rankPageElements(page, {}, visualBible).length > budget) report.pagesOverBudgetAfter++;
  }
  return report;
}

/**
 * Did the assignment trim SURVIVE to the bible that is about to be persisted?
 *
 * `trimVbAssignments` mutates one in-memory copy; every later reader re-parses
 * the transcript (see beatsPipeline.syncVisualBibleSection). This is the cheap
 * assertion the caller runs right before the story's first save: when the trim
 * reported `pagesOverBudgetAfter === 0`, no page of the bible being saved may
 * exceed the budget. Returns the offending pages (empty = consistent, or
 * nothing to check). Pure — the caller logs `vb_trim_lost`; never a kill.
 *
 * @param {Object} visualBible the bible about to be persisted
 * @param {{pagesOverBudgetAfter:number}|null} trimReport beatsReviewReport.vbAssignmentTrim
 * @returns {number[]} pages over budget that the trim said were clean
 */
function vbTrimLostPages(visualBible, trimReport, budget = VB_ELEMENT_BUDGET) {
  if (!visualBible || !trimReport || trimReport.pagesOverBudgetAfter !== 0) return [];
  const pages = new Set();
  for (const col of ELEMENT_COLLECTIONS) {
    for (const entry of (Array.isArray(visualBible[col.key]) ? visualBible[col.key] : [])) {
      for (const p of (Array.isArray(entry && entry.appearsInPages) ? entry.appearsInPages : [])) {
        const n = Number(p);
        if (Number.isFinite(n)) pages.add(n);
      }
    }
  }
  return [...pages].sort((a, b) => a - b).filter(p => rankPageElements(p, {}, visualBible).length > budget);
}

/**
 * USAGE FROM THE BRIEFS — the bible's `appearsInPages` rebuilt from what the
 * FINAL scene briefs actually cite.
 *
 * The bible is written before the briefs exist, so every page assignment in it
 * is the bible model's own guess. Anything that decided at bible time which
 * element belongs on which page was deciding without the evidence: measured on
 * staging job_1789147573901_m3uam0nxi, the plan-line trim stripped 19
 * (element, page) claims and left six entries — the story's central prop and the
 * signpost carrying its plot-critical text among them — with `appearsInPages:
 * []`, so `getElementsNeedingReferenceImages` rendered no cell for them, while
 * the final briefs asked for exactly those ids (p10 objects: ["LOC004",
 * "ART006"]).
 *
 * The briefs are the single source of truth for usage. Run this once the briefs
 * are final and before any reference cell is selected: every entry's pages
 * become the pages whose brief cites it, and an entry no brief cites gets `[]` —
 * a truthful "nothing uses this", which correctly renders no cell.
 *
 * A brief cites an element in `objects[]`, as a bare id (`ART006`) or a dotted
 * state/vantage handle (`ART015.1`). A dotted handle credits the PARENT entry
 * AND the matching `states[]` row (`vantages[]` for a location). A page's
 * `characters[]` and `interactions[]` may name a secondary character or an
 * animal by NAME rather than by id; those count too, resolved through the one
 * row→entry matcher (`entryNamedByRow`).
 *
 * `clothing` is never rebuilt: no brief cites a CLO id, so deriving its pages
 * from the briefs would only empty it.
 *
 * Pure apart from the in-place mutation, idempotent, and never throws: with no
 * briefs (the legacy unified path and the trial path both reach reference-sheet
 * generation before any brief exists) it is a no-op and reports nothing.
 *
 * @param {Object} visualBible  parsed bible (MUTATED in place)
 * @param {Array} pagesWithMetadata  [{pageNumber, metadata|objects|brief|sceneDescription}]
 * @returns {{applied:boolean, pages:number[], entries:Array<{id,collection,name,
 *   oldPages:number[], newPages:number[], gained:number[], lost:number[]}>,
 *   changed:number, emptied:string[], revived:string[]}}
 */
const USAGE_COLLECTIONS = [
  ...ELEMENT_COLLECTIONS.map(c => c.key),
  'locations',
];

/** Every id token a brief's metadata cites, bare or dotted, uppercased. */
function citedHandles(metadata) {
  const out = [];
  const push = (t) => {
    const s = String(t || '').trim().toUpperCase();
    const m = s.match(/\b([A-Z]{3}\d{3})(?:\.(\d+))?\b/);
    if (m) out.push({ id: m[1], index: m[2] ? Number(m[2]) : null });
  };
  for (const raw of (Array.isArray(metadata && metadata.objects) ? metadata.objects : [])) {
    push(typeof raw === 'string' ? raw : (raw && (raw.id || raw.name)));
  }
  return out;
}

/** The free-text names a page's cast/interactions carry, for the by-name credit. */
function castFields(metadata) {
  const out = [];
  for (const raw of (Array.isArray(metadata && metadata.characters) ? metadata.characters : [])) {
    const v = String((typeof raw === 'string' ? raw : (raw && (raw.name || raw.id))) || '').trim();
    if (v) out.push(v);
  }
  return out.concat(interactionFields(metadata));
}

function applyBriefUsage(visualBible, pagesWithMetadata = []) {
  const report = { applied: false, pages: [], entries: [], changed: 0, emptied: [], revived: [] };
  if (!visualBible || typeof visualBible !== 'object') return report;

  // Normalise the briefs to {pageNumber, metadata}; a page with no parseable
  // metadata block contributes nothing but does not invalidate the rest.
  const briefs = [];
  for (const sd of (Array.isArray(pagesWithMetadata) ? pagesWithMetadata : [])) {
    if (!sd) continue;
    const pageNumber = Number(sd.pageNumber ?? sd.page);
    if (!Number.isFinite(pageNumber)) continue;
    const metadata = sd.metadata
      || (sd.objects ? { objects: sd.objects, characters: sd.characters, interactions: sd.interactions } : null)
      || extractSceneMetadata(String(sd.brief || sd.sceneDescription || ''))
      || null;
    if (!metadata) continue;
    briefs.push({ pageNumber, metadata });
  }
  if (briefs.length === 0) return report; // no briefs yet — the guess stands

  report.applied = true;
  report.pages = briefs.map(b => b.pageNumber).sort((a, b) => a - b);

  // id -> {entry, collection}; the by-name pass needs the CHR/ANI entries too.
  const byId = new Map();
  const namedCandidates = [];
  for (const key of USAGE_COLLECTIONS) {
    for (const entry of (Array.isArray(visualBible[key]) ? visualBible[key] : [])) {
      if (!entry || !entry.id) continue;
      byId.set(baseId(entry.id) || String(entry.id).trim().toUpperCase(), { entry, key });
      if (key === 'secondaryCharacters' || key === 'animals') namedCandidates.push(entry);
    }
  }

  const pagesFor = new Map();      // base id -> Set(pages)
  const subPagesFor = new Map();   // `ID.N` -> Set(pages)
  const credit = (map, key, page) => {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(page);
  };

  for (const { pageNumber, metadata } of briefs) {
    for (const { id, index } of citedHandles(metadata)) {
      if (!byId.has(id)) continue;
      credit(pagesFor, id, pageNumber);
      if (index !== null) credit(subPagesFor, `${id}.${index}`, pageNumber);
    }
    // A secondary character or animal a page's cast names without an id.
    for (const field of castFields(metadata)) {
      const hit = entryNamedByRow(field, namedCandidates);
      if (!hit || !hit.id) continue;
      credit(pagesFor, baseId(hit.id) || String(hit.id).trim().toUpperCase(), pageNumber);
    }
  }

  const sorted = (set) => [...(set || [])].map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  for (const [id, { entry, key }] of byId) {
    const oldPages = sorted(new Set(Array.isArray(entry.appearsInPages) ? entry.appearsInPages : []));
    const newPages = sorted(pagesFor.get(id));
    entry.appearsInPages = newPages;
    if (Array.isArray(entry.pages) || oldPages.length > 0) entry.pages = [...newPages];

    // Sub-rows: a state (or a location's vantage) keeps the pages whose brief
    // cited that exact handle; a handle nobody cited for a page it used to
    // claim loses it. A sub-row is matched by its own id, then by position.
    const subKey = key === 'locations' ? 'vantages' : 'states';
    const subs = Array.isArray(entry[subKey]) ? entry[subKey] : null;
    if (subs) {
      subs.forEach((st, i) => {
        if (!st || typeof st !== 'object') return;
        const handle = String(st.id || '').trim().toUpperCase() || `${id}.${i + 1}`;
        const own = sorted(subPagesFor.get(handle));
        // A page that cited the BARE parent id belongs to the parent's default
        // sub-row (the first) — the same rule `defaultObjectState` applies.
        const bare = i === 0
          ? newPages.filter(p => ![...subPagesFor.keys()]
            .filter(k => k.startsWith(`${id}.`))
            .some(k => (subPagesFor.get(k) || new Set()).has(p)))
          : [];
        st.pages = sorted(new Set([...own, ...bare]));
      });
    }

    const gained = newPages.filter(p => !oldPages.includes(p));
    const lost = oldPages.filter(p => !newPages.includes(p));
    report.entries.push({ id, collection: key, name: String(entry.name || ''), oldPages, newPages, gained, lost });
    if (gained.length || lost.length) report.changed++;
    if (oldPages.length > 0 && newPages.length === 0) report.emptied.push(id);
    if (oldPages.length === 0 && newPages.length > 0) report.revived.push(id);
  }
  return report;
}

module.exports = {
  VB_ELEMENT_BUDGET,
  applyBriefUsage,
  trimVbAssignments,
  vbTrimLostPages,
  rankPageElements,
  checkVbElementBudget,
  buildVbElementFindings,
  truncateSceneObjects,
  truncateBriefToBudget,
  objectIds,
};
