/**
 * VB ELEMENT BUDGET — how many Visual Bible elements a page may claim.
 *
 * Owner ruling, 2026-09-06: "Never more than 3 VB elements per scene. Drop the
 * least important ones if more are requested. Do a mechanical check of it and
 * feed it into the feedback loop." Raised to FOUR on 2026-09-11, and the
 * "drop the least important" half was withdrawn the same day — see below.
 *
 * A Visual Bible ELEMENT is a bible entry that becomes a reference image packed
 * into the page's Grok slot — the same set `getElementReferenceImagesForPage`
 * (visualBible.js) selects: secondary characters, animals, artifacts and
 * vehicles. LOCATIONS DO NOT COUNT — none of them (owner ruling, 2026-09-08,
 * superseding the 2026-09-06 wording: "Do not count it as it is the empty scene
 * not an artifact"). A real landmark ships as a photograph, and an invented
 * location is what the empty-scene plate is built from — the backdrop the
 * characters are composited into, not a prop competing for a slot. Counting it
 * spent it twice. Since 2026-09-24 a location has no cell at all: an invented
 * location lives in the bible as TEXT and its plate is built from that text, so
 * the budget (4) and Grok's VB_SLOT_MAX_ELEMENTS (4) now meet exactly.
 *
 * Two sources put an element on a page, and both are counted, because both feed
 * the selection: the brief's own `objects[]` (an id the Art Director asked for)
 * and the bible entry's `appearsInPages` (the bible's own answer).
 *
 * A GARMENT WORN BY ITS OWN AVATAR IS NOT AN ELEMENT (2026-09-23). The picker
 * drops an item an attached avatar reference already carries — a `wornAs` item
 * worn by its owner on the page — because the avatar wears it
 * (wornItems.carriedByReference). The counter asks the same predicate, so it
 * never charges a cell the packer never spends. Before this, every worn outer
 * layer counted: on staging job_1790100385959_1nitlympp all four overflow
 * findings were garments, the scene review "dropped" them by deleting their
 * `wornItems` rows, and a deleted `off` row painted a sweatshirt back on Max.
 * A garment that is OFF (lying, held, handed over) still counts: then its plate
 * IS packed, as the only picture of it.
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
 * NOTHING IN CODE ENFORCES IT (owner, 2026-09-11: "we have AI calls for this").
 * The budget is a rule the Art Director is given in its prompt and a fault the
 * scene review is handed with the ids named. All three code-side enforcers were
 * removed that day — the bible-time assignment trim, the brief truncation, and
 * the budget-shaped selection cap — because code cannot know which objects a
 * page is about, and withdrawing one removes it from the page prompt's REQUIRED
 * OBJECTS line while its reference cell still exists.
 *
 * The check still REPORTS: an overflow lands in the scene review's fault block
 * (sceneBriefCheck) and is stored per page as `vbElementOverflow`, where
 * `dropped` now means "over budget and shipped anyway", not "removed".
 *
 * What remains is PHYSICAL, not a budget: the page-gen reference selection is
 * bounded by Grok's VB_SLOT_MAX_ELEMENTS (4) because the grid shares one
 * reference slot and cell size scales as 1/n. `rankPageElements` decides which
 * cells win that space, in the priority order above.
 */

const { extractSceneMetadata, parseProseMetadataFormat } = require('./sceneMetadata');
const { getRecurringCreatureIds, entryNamedByRow } = require('./visualBible');
const { idsCarriedByReferences } = require('./wornItems');

/**
 * The owner's number. One source of truth for the prompts and the checks.
 *
 * FOUR since 2026-09-11 (owner), up from three. The raise is free at the book's
 * page aspect: the slot renders 768x1024 (`pageAspect: '3:4'`), the VB column is
 * capped at a third of the width, so a cell's effective size is
 * min(256, floor(1024/n)) — 256px at THREE cells and 256px at FOUR. The column
 * width binds, not the height, so the fourth element costs no resolution at all.
 *
 * The FIFTH cell is what would cost: 204px, four pixels above
 * `VB_CELL_FLOOR_PX`, and below ~200px a secondary character's face is a smear
 * the model replaces with a prior. So Grok's `VB_SLOT_MAX_ELEMENTS` stays at 4,
 * equal to the budget. (Until 2026-09-24 a page also carried its invented
 * location's cell as a fifth, and that was the cell that gave way; locations
 * no longer have cells.)
 */
const VB_ELEMENT_BUDGET = 4;

/** Selection's priority order, by collection. Locations are not elements (header).
 *  Keyed on the COLLECTION arrays, which is what keeps `visualBible.genericObjects[]`
 *  invisible to the budget: a generic entry was dropped at parse time and has no id,
 *  so it can never be ranked, cited or counted (owner, 2026-09-15). */
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
  // Worn on its owner's avatar: the picker packs no cell for it (header).
  const carried = idsCarriedByReferences(visualBible, metadata, { pageNumber });
  const rows = [];
  for (const col of ELEMENT_COLLECTIONS) {
    const entries = visualBible[col.key];
    for (const entry of (Array.isArray(entries) ? entries : [])) {
      if (!entry || !entry.id) continue;
      const id = baseId(entry.id) || String(entry.id).trim().toUpperCase();
      if (carried.has(id)) continue;
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

/** `Label (ID, type)` — how an element is named to the reviewer. The label is
 * the element's ONE authored English label (vbLabel.labelOf); the id rides
 * along because the reviewer is a text judge, not an image model. */
function label(e) {
  return `${require('./vbIdGuard').elementDisplayLabel(e)} (${e.id}, ${e.type})`;
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
      || (sd.objects ? { objects: sd.objects, interactions: sd.interactions, characters: sd.characters, wornItems: sd.wornItems } : null)
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
 * A BARE citation lands on the sub-row the entry's own table already assigns
 * that page (`objectStateForPage`), not on the first row — the same resolution
 * the page prompt and the reference-cell pick use. `emptiedStates` names every
 * state or vantage that ended with no page left, which is a look the book never
 * reaches and a reference cell rendered for nothing.
 *
 * @returns {{applied:boolean, pages:number[], entries:Array<{id,collection,name,
 *   oldPages:number[], newPages:number[], gained:number[], lost:number[]}>,
 *   changed:number, emptied:string[],
 *   emptiedStates:Array<{id:string, name:string, oldPages:number[]}>,
 *   revived:string[]}}
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
  const report = { applied: false, pages: [], entries: [], changed: 0, emptied: [], emptiedStates: [], revived: [], unreadPages: [] };
  if (!visualBible || typeof visualBible !== 'object') return report;

  // Normalise the briefs to {pageNumber, metadata}.
  //
  // A BRIEF THAT COULD NOT BE READ IS NOT A BRIEF THAT ASKS FOR NOTHING.
  // Two shapes arrive here saying "no ids on this page" and they mean opposite
  // things: a brief that parsed and cites none, and a brief whose METADATA
  // block failed — `extractSceneMetadata` then returns the prose-only RECOVERY
  // object (`isRecovered: true`, sceneMetadata.js), whose `objects[]` and
  // `characters[]` are empty because nothing was read, not because nothing was
  // asked for. Crediting the second as a citation-free page let one unreadable
  // brief withdraw every element the bible had placed on that page, in silence.
  // Measured on staging job_1789759147125_p08djwhbl p17 — the page where the
  // book's creature hatches: its brief cited ANI003 and LOC005.3, the parse was
  // destroyed by an appended Visual Bible section (b5443396a), and ANI003
  // reached the bible for page 18 alone. The brief never asked for it, no
  // reference cell was packed, and every judge scored the page against a brief
  // with no creature in it.
  //
  // So an unread page NEITHER CREDITS NOR WITHDRAWS: the bible's own claim on
  // it stands, and the page is named in `unreadPages` for the caller to report.
  // Same contract as notEvaluated.js — "I could not check this" is part of the
  // result, never a silent clean pass.
  const briefs = [];
  const unread = new Set();
  for (const sd of (Array.isArray(pagesWithMetadata) ? pagesWithMetadata : [])) {
    if (!sd) continue;
    const pageNumber = Number(sd.pageNumber ?? sd.page);
    if (!Number.isFinite(pageNumber)) continue;
    const metadata = sd.metadata
      || (sd.objects ? { objects: sd.objects, characters: sd.characters, interactions: sd.interactions } : null)
      || extractSceneMetadata(String(sd.brief || sd.sceneDescription || ''))
      || null;
    if (!metadata || metadata.isRecovered === true) { unread.add(pageNumber); continue; }
    briefs.push({ pageNumber, metadata });
  }
  report.unreadPages = [...unread].sort((a, b) => a - b);
  if (briefs.length === 0) return report; // no readable brief — the guess stands

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
    const credited = sorted(pagesFor.get(id));
    // The bible's claim on an UNREAD page survives — see the header above. It
    // rejoins `newPages`, so the sub-row routing below sends it back to the row
    // the entry's own table authored for it, exactly as a bare citation would.
    const preserved = oldPages.filter(p => unread.has(p) && !credited.includes(p));
    const newPages = preserved.length ? sorted(new Set([...credited, ...preserved])) : credited;
    entry.appearsInPages = newPages;
    if (Array.isArray(entry.pages) || oldPages.length > 0) entry.pages = [...newPages];

    // Sub-rows: a state (or a location's vantage) keeps the pages whose brief
    // cited that exact handle; a handle nobody cited for a page it used to
    // claim loses it. A sub-row is matched by its own id, then by position.
    const subKey = key === 'locations' ? 'vantages' : 'states';
    // An EMPTY `states: []` is the normal case — most entries have no states at
    // all and the parser writes the empty array — so it is `null` here, not a
    // zero-length list the bare-citation routing below would index into.
    const subs = (Array.isArray(entry[subKey]) && entry[subKey].length > 0) ? entry[subKey] : null;
    if (subs) {
      // The AUTHORED tables, snapshotted before any row is rewritten: the
      // bare-citation routing below reads them, and rewriting row 0 first would
      // change the answer every later row gets.
      const authored = subs.map(st => new Set(
        (Array.isArray(st && st.pages) ? st.pages : []).map(Number).filter(Number.isFinite)
      ));
      const dotted = [...subPagesFor.keys()].filter(k => k.startsWith(`${id}.`));
      const barePages = newPages.filter(p => !dotted.some(k => (subPagesFor.get(k) || new Set()).has(p)));
      // A BARE citation resolves HERE THE WAY THE PROMPT RESOLVES IT: the page
      // goes to the sub-row the entry's own table already assigns it
      // (`objectStateForPage`, visualBible.js — written so that "a brief that
      // cites the bare parent id still lands on the right cell for the page"),
      // and only to the first row when no row claims it (`defaultObjectState`).
      //
      // Crediting every bare page to row 0 was a SECOND, disagreeing resolution
      // rule, and it did not merely mis-credit — it rewrote the bible the prompt
      // path then read. Staging job_1789584708605_rts4wqupm: the Art Director
      // authored an object's states as unaltered [3-13], cold [14,15], cracked
      // [18]; the scene review saw that table and correctly left it alone; the
      // briefs cite the bare parent from p11 on; this loop moved [14,15] onto
      // the unaltered row and emptied the other two. Both later pages were then
      // built with the unaltered delta AND the unaltered reference cell — the
      // object drawn glowing on the pages whose own text has gone cold.
      const bareFor = subs.map(() => []);
      for (const p of barePages) {
        const idx = authored.findIndex(set => set.has(p));
        bareFor[idx >= 0 ? idx : 0].push(p);
      }
      subs.forEach((st, i) => {
        if (!st || typeof st !== 'object') return;
        const handle = String(st.id || '').trim().toUpperCase() || `${id}.${i + 1}`;
        const own = sorted(subPagesFor.get(handle));
        const before = sorted(authored[i]);
        st.pages = sorted(new Set([...own, ...bareFor[i]]));
        // A LOOK NO PAGE REACHES. The entry-level `emptied` list never saw this
        // — it counts entries — so a state that lost every page (and whose
        // reference cell was already rendered and paid for) left no signal at
        // all. Reported, never repaired: which page shows which look is the
        // Art Director's to say.
        if (before.length > 0 && st.pages.length === 0) {
          report.emptiedStates.push({ id: handle, name: String(st.name || ''), oldPages: before });
        }
      });
    }

    const gained = newPages.filter(p => !oldPages.includes(p));
    const lost = oldPages.filter(p => !newPages.includes(p));
    report.entries.push({ id, collection: key, name: String(entry.name || ''), oldPages, newPages, gained, lost, preserved });
    if (gained.length || lost.length) report.changed++;
    if (oldPages.length > 0 && newPages.length === 0) report.emptied.push(id);
    if (oldPages.length === 0 && newPages.length > 0) report.revived.push(id);
  }
  return report;
}

module.exports = {
  VB_ELEMENT_BUDGET,
  applyBriefUsage,
  rankPageElements,
  checkVbElementBudget,
  buildVbElementFindings,
  truncateSceneObjects,
  truncateBriefToBudget,
  objectIds,
};
