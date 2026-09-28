/**
 * THE DECIDED FIELDS OF EVERY STORY PAGE, BEFORE THE PAGE BRIEFS (owner,
 * 2026-09-28: "Jev first, then remove the scene review").
 *
 * Between the Art Director's two calls (beatsPipeline.runArtDirector) the
 * Visual Bible exists and no page brief does: this module decides each story
 * page's cited elements and their looks, location, aboard, population and gaze
 * (decideBriefFields), and pins them into the briefs the page-brief call
 * returns (pinDecidedFields). A leaf module on purpose: the Test Lab, the
 * rung-1 replay and the unit tests load it without the pipeline's provider
 * graph (beatsPipeline requires it; it never requires beatsPipeline except for
 * the transcript sync, lazily, when a transcript is passed).
 *
 * see docs/decisions.md 2026-09-28 "Jev first, then no scene review"
 */

const { log } = require('../utils/logger');
const jevDecisions = require('./jevDecisions');
const { JevDecisionError } = jevDecisions;
const { resolveShotId } = require('./shotVocabulary');

/**
 * THE LOCATION OF EVERY STORY PAGE, from the Visual Bible's own page tables
 * (owner, 2026-09-28, Q8): the vantage whose `pages` hold the page (dotted id),
 * else the location whose pages hold it (bare id). The Art Director decides the
 * places and viewpoints in the Visual Bible call; code reads them and writes
 * each page's location cite. Pure.
 *
 * @returns {{byPage: Map<number, {cite:string, base:string}>, unplaced:number[], doubled:Array<{pageNumber:number, cites:string[]}>}}
 */
function pageLocations(visualBible, pageNumbers) {
  const hits = new Map(pageNumbers.map(n => [Number(n), []]));
  const nums = arr => (Array.isArray(arr) ? arr : []).map(Number);
  for (const l of (visualBible && Array.isArray(visualBible.locations) ? visualBible.locations : [])) {
    if (!l || !l.id) continue;
    const base = String(l.id).trim().toUpperCase().split('.')[0];
    const vantages = (Array.isArray(l.vantages) ? l.vantages : []).filter(v => v && v.id);
    const own = nums(l.appearsInPages || l.pages);
    for (const n of hits.keys()) {
      const v = vantages.find(x => nums(x.pages).includes(n));
      if (v) hits.get(n).push({ cite: String(v.id).trim().toUpperCase(), base });
      else if (own.includes(n)) hits.get(n).push({ cite: vantages.length ? null : base, base });
    }
  }
  const byPage = new Map();
  const unplaced = [];
  const doubled = [];
  for (const [n, list] of hits) {
    const usable = list.filter(h => h.cite);
    if (!usable.length) { unplaced.push(n); continue; }
    if (new Set(usable.map(h => h.base)).size > 1) doubled.push({ pageNumber: n, cites: usable.map(h => h.cite) });
    byPage.set(n, usable[0]);
  }
  return { byPage, unplaced, doubled };
}

/**
 * THE DECISION LAYER BEFORE THE PAGE BRIEFS (owner, 2026-09-28: "Jev first,
 * then remove the scene review"). Runs between the Art Director's two calls:
 * the Visual Bible exists, no page brief does. Per story page it decides
 *   - the cited Visual Bible elements and the look of each (decideVbAndAboard;
 *     the Art Director's own `pages` claims are the draft the 0.5–0.7 band reads),
 *   - `aboard`, the location or vantage (the bible's page tables, Q8) and the
 *     location's `population` (decidePopulation),
 *   - each commissioned character's `looksAt` (decideGaze; the roster is the
 *     shipped plan check's head count — the same `present` the shots read —
 *     and the candidates are the page's cites and the figures its plan line
 *     names, since no interaction row exists yet).
 * With the shot (plan field 0) and the light (b.fixed) they become
 * `b.jevFixed`, which the page-brief call receives as the page's FIXED block
 * (jevDecisions.fixedBlock) and code pins after it (pinBrief). The bible's
 * element page tables are made to agree with the cites before call 2 reads it.
 *
 * Mutates `beats` (b.jevFixed) and `visualBible`; returns the synced
 * transcript and the report. A Jev failure throws JevDecisionError.
 *
 * @param {Map<number,string[]>} present - page → the names the shipped plan check counts in frame
 */
async function decideBriefFields({ beats, visualBible, bibleSections, approvedArc, inputData, present, gl }) {
  const { isCoverPage } = require('./coverBeats');
  const { isSameFigureName } = require('./sceneMetadata');
  const t0 = Date.now();
  const storyBeats = beats.filter(b => !isCoverPage(b.pageNumber));
  const missingCount = storyBeats.filter(b => !(present && present.has(Number(b.pageNumber)))).map(b => b.pageNumber);
  if (missingCount.length) {
    throw new JevDecisionError(`no head count for page(s) ${missingCount.join(', ')} — the gaze decision has no roster`);
  }
  const vb = visualBible || {};
  const commissioned = (inputData.characters || []).map(c => c && c.name).filter(Boolean);
  const els = jevDecisions.vbElements(vb, commissioned);
  const decidedIds = els.map(e => e.id);
  const vehicleIds = els.filter(e => e.type === 'vehicle').map(e => e.id);
  const pagesOf = e => (Array.isArray(e.appearsInPages) ? e.appearsInPages : (Array.isArray(e.pages) ? e.pages : [])).map(Number);
  // The Art Director's own page claims from the Visual Bible call: the draft
  // the 0.5–0.7 object band reads (it read the brief's cites before).
  const adCited = new Map(storyBeats.map(b => [Number(b.pageNumber), new Set(els.filter(e => pagesOf(e.entry).includes(Number(b.pageNumber))).map(e => e.id))]));
  const decidedVb = await jevDecisions.decideVbAndAboard({ arc: approvedArc, pages: storyBeats, visualBible: vb, commissionedNames: commissioned, adCited });
  const located = pageLocations(vb, storyBeats.map(b => Number(b.pageNumber)));
  for (const n of located.unplaced) {
    gl.error('beats_jev_page_unlocated', `Page ${n} sits in no location's pages in the Visual Bible — the Art Director cites its location and writes its population`, null, { pageNumber: n });
  }
  for (const d of located.doubled) {
    gl.warn('beats_jev_page_two_locations', `Page ${d.pageNumber} sits in the pages of more than one location (${d.cites.join(', ')}) — the first is cited`, null, d);
  }
  const locOf = new Map([...located.byPage].map(([n, r]) => [n, r.base]));
  const pop = await jevDecisions.decidePopulation({ arc: approvedArc, pages: storyBeats, visualBible: vb, locOf });
  // Labels for the FIXED block: an element's name, and the look for a dotted id.
  const gIndex = jevDecisions.gazeIndex(vb);
  const lookOf = new Map(els.flatMap(e => jevDecisions.stateOptions(e.entry).map(o => [o.id, o.label])));
  const baseOf = id => String(id || '').trim().toUpperCase().split('.')[0];
  const labelOf = (id) => {
    const e = gIndex[id] || gIndex[baseOf(id)];
    const name = e ? (e.vantage ? `${e.name}, ${e.vantage}` : e.name) : id;
    const look = lookOf.get(String(id).toUpperCase());
    return look ? `${name}, ${look}` : name;
  };
  const vbByPage = new Map(decidedVb.pages.map(r => [r.pageNumber, r]));
  for (const b of storyBeats) {
    const n = Number(b.pageNumber);
    const r = vbByPage.get(n);
    const loc = located.byPage.get(n);
    const planShot = resolveShotId(jevDecisions.planParts(b.planLine)[0]);
    const cites = r ? r.elements.map(e => e.cite) : [];
    b.jevFixed = {
      ...(planShot ? { shot: planShot } : {}),
      ...(b.fixed ? { timeOfDay: b.fixed.timeOfDay, indoor: b.fixed.indoor } : {}),
      cites, decidedIds,
      ...(loc ? { location: loc.cite } : {}),
      ...(loc && pop.byLocation[loc.base] ? { population: pop.byLocation[loc.base].population } : {}),
      aboard: r ? r.aboard : null, aboardIds: vehicleIds,
    };
  }
  // Gaze: the roster is the head count's commissioned characters; the
  // candidates are the page's decided cites and the figures its plan line names.
  const perPage = storyBeats.map((b) => {
    const n = Number(b.pageNumber);
    const inFrame = present.get(n) || [];
    const roster = commissioned.filter(c => inFrame.some(name => isSameFigureName(c, name)));
    const objects = [...(b.jevFixed.location ? [b.jevFixed.location] : []), ...b.jevFixed.cites];
    return { pageNumber: n, roster, ...jevDecisions.gazePageMaterial({ objects, interactions: [], planLine: b.planLine, index: gIndex }) };
  });
  const gaze = await jevDecisions.decideGaze({ arc: approvedArc, pages: storyBeats, perPage });
  for (const g of gaze.pages) {
    const b = storyBeats.find(s => Number(s.pageNumber) === g.pageNumber);
    b.jevFixed.looksAt = Object.fromEntries(g.characters.map(c => [c.name, c.looksAt]));
  }
  for (const b of storyBeats) {
    const f = b.jevFixed;
    const ids = [f.location, ...f.cites, f.aboard, ...Object.values(f.looksAt || {})].filter(id => id && id !== jevDecisions.GAZE_AWAY && /^[A-Z]{3}\d{3}/i.test(String(id)));
    f.labels = Object.fromEntries(ids.map(id => [id, labelOf(id)]));
  }
  // The element page tables follow the cites, before the page-brief call reads the bible.
  if (visualBible) {
    const citesByPage = new Map(storyBeats.map(b => [Number(b.pageNumber), b.jevFixed.cites]));
    const moved = jevDecisions.applyVbPages(visualBible, citesByPage, decidedIds);
    if (moved && bibleSections) {
      const synced = require('./beatsPipeline').syncVisualBibleSection(bibleSections, visualBible);
      if (synced === bibleSections) gl.warn('beats_vb_sync_failed', 'The decided element pages could not be written back into the transcript');
      else bibleSections = synced;
    }
  }
  const report = { vb: decidedVb, population: pop, gaze, locations: Object.fromEntries([...located.byPage].map(([n, r]) => [n, r.cite])), unlocated: located.unplaced, elapsedMs: Date.now() - t0 };
  gl.info('beats_jev_brief_fields', `Jev decided the cited elements, looks, location, aboard, population and gaze of ${storyBeats.length} page(s) before the briefs (${decidedVb.stats.calls + pop.stats.calls + gaze.stats.calls} Jev calls, ${(report.elapsedMs / 1000).toFixed(1)}s)`, null, {
    stats: { vb: decidedVb.stats, population: pop.stats, gaze: gaze.stats },
  });
  return { bibleSections, report };
}

/**
 * Pin the decided fields into each page brief the page-brief call returned
 * (owner, 2026-09-28). The Art Director was handed them as the page's FIXED
 * block, so a pin that changes something is a field it did not copy: restored
 * by code and logged as `beats_jev_field_disobeyed` — the count measures how
 * well call 2 follows the FIXED block. An outdoor page with no outdoor weather
 * is left to the brief checks (collectBriefFindings), never guessed here.
 */
function pinDecidedFields(expansions, briefBeats, gl) {
  const disobeyed = [];
  for (const x of expansions) {
    const b = (briefBeats || []).find(bb => bb && bb.pageNumber === x.pageNumber);
    if (!b || !b.jevFixed) continue;
    const pinned = jevDecisions.pinBrief(x.brief, b.jevFixed);
    if (pinned.unparsed) {
      gl.error('beats_jev_brief_unparsed', `Page ${x.pageNumber}: the brief carries no parseable METADATA — the decided fields could not be written`, null, { pageNumber: x.pageNumber });
      continue;
    }
    const fields = [...new Set(pinned.changes.filter(c => !c.problem).map(c => c.field))];
    if (!fields.length) continue;
    x.brief = pinned.brief;
    disobeyed.push({ pageNumber: x.pageNumber, fields, changes: pinned.changes.filter(c => !c.problem) });
    gl.warn('beats_jev_field_disobeyed', `Page ${x.pageNumber}: the page brief did not copy decided field(s) ${fields.join(', ')} — code restored them`, null, { pageNumber: x.pageNumber, fields, pass: 'page briefs' });
  }
  if (disobeyed.length) log.warn(`📌 [BEATS] the page-brief call left decided fields uncopied on ${disobeyed.length} page(s) — restored: ${disobeyed.map(d => `p${d.pageNumber} ${d.fields.join('/')}`).join(', ')}`);
  return disobeyed;
}

/** The Visual Bible JSON inside a transcript's ---VISUAL BIBLE--- section, as the page-brief call reads it. */
function visualBibleJsonOf(bibleSections) {
  const section = String(bibleSections || '').match(/---VISUAL BIBLE---\s*([\s\S]*?)(?=---[A-Z\s]+---|$)/i);
  if (!section) return '';
  const json = section[1].match(/```json\s*([\s\S]*?)```/i);
  return json ? json[1].trim() : '';
}

module.exports = { decideBriefFields, pinDecidedFields, pageLocations, visualBibleJsonOf };
