/**
 * VB ELEMENT BUDGET — never more than three Visual Bible elements on a page.
 *
 * Owner ruling, 2026-09-06: "Never more than 3 VB elements per scene. Drop the
 * least important ones if more are requested. Do a mechanical check of it and
 * feed it into the feedback loop."
 *
 * A Visual Bible ELEMENT is a bible entry that becomes a reference image packed
 * into the page's Grok slot — the same set `getElementReferenceImagesForPage`
 * (visualBible.js) selects: secondary characters, animals, artifacts, vehicles,
 * and INVENTED locations. Real landmarks are excluded there (they ship as real
 * photographs, not generated references) and are excluded here, so a page may
 * cite its landmark LOC and still hold three elements.
 *
 * Two sources put an element on a page, and both are counted, because both feed
 * the selection: the brief's own `objects[]` (an id the Art Director asked for)
 * and the bible entry's `appearsInPages` (the bible's own answer). Locations are
 * the one exception — selection admits them by `appearsInPages` only, so the
 * count does too.
 *
 * RANKING (the "least important" the ruling drops). Data, never prose:
 *   0. a recurring creature — pinned first, exactly as visualBible.js pins it.
 *   1. type: character < animal < artifact < vehicle < location. This is the
 *      priority order the selection already sorts by (visualBible.js:2202-2224,
 *      mirrored in grok.js VB_TYPE_PRIORITY) — using any other order here would
 *      make the code-side truncation and the downstream cap keep different
 *      elements.
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
const { getRecurringCreatureIds } = require('./visualBible');

/** The owner's number. One source of truth for prompt, check and truncation. */
const VB_ELEMENT_BUDGET = 3;

/** Selection's priority order, by collection. Locations are `appearsInPages` only. */
const ELEMENT_COLLECTIONS = [
  { key: 'secondaryCharacters', type: 'character', priority: 1, viaObjects: true },
  { key: 'animals', type: 'animal', priority: 2, viaObjects: true },
  { key: 'artifacts', type: 'artifact', priority: 3, viaObjects: true },
  { key: 'vehicles', type: 'vehicle', priority: 4, viaObjects: true },
  { key: 'locations', type: 'location', priority: 5, viaObjects: false },
];

/** `ART002.2` → `ART002`; anything that is not an id shape → null. */
function baseId(value) {
  const m = /^([A-Z]{3})(\d{3})(?:\.\d+)?$/.exec(String(value || '').trim().toUpperCase());
  return m ? m[1] + m[2] : null;
}

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

/** Every name/id the brief's interactions[] touch, upper-cased, for the focal test. */
function interactionTokens(metadata) {
  const rows = (metadata && Array.isArray(metadata.interactions)) ? metadata.interactions : [];
  const out = new Set();
  for (const row of rows) {
    for (const field of ['character', 'object']) {
      const v = String((row && row[field]) || '').trim().toUpperCase();
      if (v) out.add(v);
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
  const tokens = interactionTokens(metadata);
  const recurring = new Set(getRecurringCreatureIds(visualBible).map(id => String(id).toUpperCase()));
  const rows = [];
  for (const col of ELEMENT_COLLECTIONS) {
    const entries = visualBible[col.key];
    for (const entry of (Array.isArray(entries) ? entries : [])) {
      if (!entry || !entry.id) continue;
      if (col.key === 'locations' && entry.isRealLandmark) continue;
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
        focal: tokens.has(id) || (!!name && tokens.has(name.toUpperCase())),
        fromObjects: !!named,
        appearsCount: Array.isArray(entry.appearsInPages) ? entry.appearsInPages.length : 0,
      });
    }
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

module.exports = {
  VB_ELEMENT_BUDGET,
  rankPageElements,
  checkVbElementBudget,
  buildVbElementFindings,
  truncateSceneObjects,
  truncateBriefToBudget,
  objectIds,
};
