/**
 * THE DECIDED FIELDS OF EVERY STORY PAGE, BEFORE THE PAGE BRIEFS (owner,
 * 2026-09-28: "Jev first, then remove the scene review").
 *
 * Between the Art Director's two calls (beatsPipeline.runArtDirector) the
 * Visual Bible exists and no page brief does: this module decides each story
 * page's cited elements and their looks, location, aboard, population and gaze
 * (decideBriefFields), and pins them into the briefs the page-brief call
 * returns (assembleBriefs). A leaf module on purpose: the Test Lab, the
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
const { isDimLight } = require('./sceneLight');

/**
 * The cited elements of one page as the light-source question asks about them (decideLightSources):
 * each cite with its name, short description and the name of the look it shows. Clothing is not asked.
 * @param {{elements:Array<{id:string, cite:string, type:string}>}|undefined} vbRow - decideVbAndAboard's row for the page
 * @param {Object} gIndex - jevDecisions.gazeIndex(visualBible)
 * @param {Map<string,string>} lookOf - dotted state id -> the look's label
 */
function litCandidates(vbRow, gIndex, lookOf) {
  const baseOf = id => String(id || '').trim().toUpperCase().split('.')[0];
  return (vbRow ? vbRow.elements : []).filter(x => x.type !== 'clothing').map((x) => {
    const g = gIndex[baseOf(x.cite)] || gIndex[baseOf(x.id)];
    return { id: x.cite, name: g ? g.name : x.id, desc: g ? g.desc : '', look: lookOf.get(String(x.cite).toUpperCase()) || '' };
  });
}

/**
 * The commissioned characters a page's plan line names who are not in its picture: the gaze word
 * `outside` is offered for them, and their names are never written into an image prompt.
 */
function offFrameOf(commissioned, roster, planLine) {
  const planText = jevDecisions.planParts(planLine).slice(1).join(' ');
  return (commissioned || []).filter(c => !(roster || []).includes(c) && jevDecisions.namedIn(c, planText));
}


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
 *   - whether the reader must read lettering in the picture (`readsText`, the
 *     READ noul of the same call; the brief check required_text_undeclared),
 *   - each commissioned character's `looksAt` (decideGaze; the roster is the
 *     shipped plan check's head count — the same `present` the shots read —
 *     and the candidates are the page's cites and the figures its plan line
 *     names, since no interaction row exists yet).
 * With the shot (plan field 0) and the light (b.fixed) they become
 * `b.jevFixed`, which the page-brief call receives as the page's FIXED block
 * (jevDecisions.fixedBlock) and code merges them into the brief after it
 * (assembleBriefs → pinBrief); the Art Director never writes them. The bible's
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
      readsText: !!(r && r.readsText),
    };
  }
  // What lights a dark page: Jev says which cited element is lit or glowing (owner, 2026-10-06). Pages in a light
  // with sky and sun keep no list ([] clears a stale one when a brief is re-pinned).
  const litPages = storyBeats.filter(b => b.fixed && isDimLight(b.fixed.timeOfDay));
  const litEls = litPages.map(b => ({ pageNumber: Number(b.pageNumber), elements: litCandidates(vbByPage.get(Number(b.pageNumber)), gIndex, lookOf) }));
  const lit = await jevDecisions.decideLightSources({ arc: approvedArc, pages: storyBeats, perPage: litEls });
  for (const b of storyBeats) b.jevFixed.lightSources = (lit.byPage.get(Number(b.pageNumber)) || []).map(x => x.name);
  // Gaze: the roster is the head count's commissioned characters; the
  // candidates are the page's decided cites and the figures its plan line names.
  const perPage = storyBeats.map((b) => {
    const n = Number(b.pageNumber);
    const inFrame = present.get(n) || [];
    const roster = commissioned.filter(c => inFrame.some(name => isSameFigureName(c, name)));
    const objects = [...(b.jevFixed.location ? [b.jevFixed.location] : []), ...b.jevFixed.cites];
    const offFrame = offFrameOf(commissioned, roster, b.planLine);
    return { pageNumber: n, roster, offFrame, ...jevDecisions.gazePageMaterial({ objects, interactions: [], planLine: b.planLine, index: gIndex }) };
  });
  const gaze = await jevDecisions.decideGaze({ arc: approvedArc, pages: storyBeats, perPage });
  for (const g of gaze.pages) {
    const b = storyBeats.find(s => Number(s.pageNumber) === g.pageNumber);
    b.jevFixed.looksAt = Object.fromEntries(g.characters.map(c => [c.name, c.looksAt]));
  }
  for (const b of storyBeats) {
    const f = b.jevFixed;
    const ids = [f.location, ...f.cites, f.aboard, ...Object.values(f.looksAt || {})].filter(id => id && /^[A-Z]{3}\d{3}/i.test(String(id)));
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
  const report = { vb: decidedVb, population: pop, gaze, lightSources: Object.fromEntries([...lit.byPage]), locations: Object.fromEntries([...located.byPage].map(([n, r]) => [n, r.cite])), unlocated: located.unplaced, elapsedMs: Date.now() - t0 };
  gl.info('beats_jev_brief_fields', `Jev decided the cited elements, looks, location, aboard, population and gaze of ${storyBeats.length} page(s) before the briefs (${decidedVb.stats.calls + pop.stats.calls + gaze.stats.calls} Jev calls, ${(report.elapsedMs / 1000).toFixed(1)}s)`, null, {
    stats: { vb: decidedVb.stats, population: pop.stats, gaze: gaze.stats, lightSources: lit.stats },
  });
  return { bibleSections, report };
}

/**
 * Assemble each page's final brief: merge the decided fields into the metadata
 * the Art Director wrote (owner, 2026-10-05). The Art Director is handed them as
 * the page's FIXED block and does not write them (decisions.md 2026-10-05), so
 * the merge adds fields rather than restoring them. A page whose METADATA does
 * not parse cannot be assembled: logged loudly, the brief contract has already
 * flagged it. An outdoor page with no outdoor weather is left to the brief
 * checks (collectBriefFindings), never guessed here.
 */
function assembleBriefs(expansions, briefBeats, gl) {
  for (const x of expansions) {
    const b = (briefBeats || []).find(bb => bb && bb.pageNumber === x.pageNumber);
    if (!b || !b.jevFixed) continue;
    const merged = jevDecisions.pinBrief(x.brief, b.jevFixed);
    if (merged.unparsed) {
      gl.error('beats_jev_brief_unparsed', `Page ${x.pageNumber}: the brief carries no parseable METADATA — the decided fields could not be written`, null, { pageNumber: x.pageNumber });
      continue;
    }
    x.brief = merged.brief;
  }
}

/** The Visual Bible JSON inside a transcript's ---VISUAL BIBLE--- section, as the page-brief call reads it. */
function visualBibleJsonOf(bibleSections) {
  const section = String(bibleSections || '').match(/---VISUAL BIBLE---\s*([\s\S]*?)(?=---[A-Z\s]+---|$)/i);
  if (!section) return '';
  const json = section[1].match(/```json\s*([\s\S]*?)```/i);
  return json ? json[1].trim() : '';
}

// ───────────────────────── THE COVERS' PLACES ─────────────────────────

/**
 * THE PLACE OF EACH COVER (owner, 2026-10-04: "Jev ranks the cover places,
 * code makes them distinct"). Q8 (2026-09-28) gave every story page a location
 * read off the Visual Bible's page tables; the covers kept the Art Director's
 * own pick under COVER_OWN_PLACE, and the Visual Bible call put all three on
 * one vantage (staging job_1791040103540_atbttop6w LOC001.1,
 * job_1790277448294_5herh01j7 LOC001.2). Now, between the Art Director's two
 * calls:
 *   candidates  the `wide` / `ultra-wide` vantages of every location a story
 *               page stands on (pageLocations) — never a close vantage, never a
 *               place only seen in the distance;
 *   Jev         one choice call per cover over the candidates, on the arc and
 *               the page plan (the state of the 2026-10-04 replay);
 *   code        the assignment: the front cover takes its top-rated vantage;
 *               the others take distinct ones from what is left by their
 *               probabilities, sharing only when none remains.
 * The result is the cover beat's location-only `jevFixed`, pinned like a story
 * page's location (jevDecisions.pinBrief), and the covers' pages in the
 * bible's location / vantage tables.
 */
const COVER_PLACE_SHOTS = new Set(['wide', 'ultra-wide']);

/** P(yes) of one noul answer in a Jev reply; throws on a malformed answer. */
function jevAuditYes(answers, id) {
  return require('./jevAudit').yesProb(answers && answers[id]);
}

/**
 * The yes/no each OFFERED landmark gets per cover (owner, 2026-10-04): does
 * this famous place of the town suit this cover's picture? Generic wording —
 * the cover's purpose and the place's own label, nothing of any one story.
 */
const COVER_OFFERED_Q = Object.freeze({
  frontCover: label => `This famous place of the book's town suits the book's front cover: a bright portrait of the cast standing together in front of it, under the book's title. The place: ${label}`,
  initialPage: label => `This famous place of the book's town suits the title page, the opening picture before the story begins: the cast standing together in front of it, setting out. The place: ${label}`,
  backCover: label => `This famous place of the book's town suits the back cover, a calm closing picture after the adventure: the cast standing together, at rest, in front of it. The place: ${label}`,
});

const COVER_PLACE_Q = Object.freeze({
  frontCover: 'The front cover, under the book title: the place and viewpoint that best stands for the whole story — its key place, where the cast can stand together.',
  initialPage: 'The title page inside the book, the opening picture before page 1: the place and viewpoint where the story begins, where the cast can stand together.',
  backCover: 'The back cover, a calm closing picture after the adventure: the place and viewpoint where the story ends at rest, where the cast can stand together.',
});

const normName = x => String(x || '').toLowerCase().replace(/[()[\],.]/g, ' ').replace(/\s+/g, ' ').trim();

/** The bible location an offered landmark already is (name matched like visualBible.linkPreDiscoveredLandmarks; any location, real or not). */
function bibleLocationOf(visualBible, landmark) {
  const n = normName(landmark && landmark.name);
  if (!n) return null;
  return (visualBible && Array.isArray(visualBible.locations) ? visualBible.locations : []).find((l) => {
    if (!l) return false;
    return [l.landmarkQuery, l.name].some((q) => {
      const v = normName(q);
      return v && (v === n || (v.includes(n) && n.length >= 5) || (n.includes(v) && v.length >= 5));
    });
  }) || null;
}

/** A photo a cover may be painted in front of: an exterior, wide or medium, photo_score >= 40 (owner, 2026-10-04). */
const COVER_PHOTO_MIN_SCORE = 40;
function coverPhotoOf(landmark) {
  const ok = (Array.isArray(landmark && landmark.photoVariants) ? landmark.photoVariants : [])
    .filter(v => v && v.kind === 'exterior' && (v.framing === 'wide' || v.framing === 'medium') && Number(v.photoScore) >= COVER_PHOTO_MIN_SCORE);
  return ok.sort((a, b) => (Number(b.photoScore) - Number(a.photoScore)) || (a.variantNumber - b.variantNumber))[0] || null;
}

/** A photo description without its "[scope, season, time]" tag. */
const photoText = v => String((v && v.description) || '').replace(/^\s*\[[^\]]*\]\s*/, '').trim();

/**
 * The places a cover may take (owner, 2026-10-04):
 *   - the `wide` / `ultra-wide` vantages of the locations story pages stand on;
 *   - every OFFERED landmark (the story's ranked list, `inputData.availableLandmarks`)
 *     no story page stands on, with at least one exterior wide/medium photo of
 *     photo_score >= COVER_PHOTO_MIN_SCORE — a backdrop the cast stands in front
 *     of, painted from its best such photo. It may already be a bible location
 *     (seen from the pages, never stood on) or not be one yet;
 *     materializeCoverPlaces writes it into the bible once a cover picks it.
 * Pure.
 * @returns {Array<{id:string, base:string, name:string, label:string, shot:string, visited:boolean, offered?:Object}>}
 */
function coverPlaceCandidates(visualBible, storyPageNumbers, availableLandmarks = []) {
  const { resolveShotId } = require('./shotVocabulary');
  const located = pageLocations(visualBible, storyPageNumbers);
  const bases = new Set([...located.byPage.values()].map(r => r.base));
  const out = [];
  for (const l of (visualBible && Array.isArray(visualBible.locations) ? visualBible.locations : [])) {
    if (!l || !l.id) continue;
    const base = String(l.id).trim().toUpperCase().split('.')[0];
    if (!bases.has(base)) continue;
    for (const v of (Array.isArray(l.vantages) ? l.vantages : [])) {
      if (!v || !v.id) continue;
      const shot = resolveShotId(v.shot);
      if (!COVER_PLACE_SHOTS.has(shot)) continue;
      const desc = String(v.description || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      const name = `${l.name}, ${v.name}`;
      out.push({ id: String(v.id).trim().toUpperCase(), base, shot, name, visited: true, label: `${name} (${shot} view)${desc ? `: ${desc}` : ''}` });
    }
  }
  const seen = new Set();
  for (const lm of (Array.isArray(availableLandmarks) ? availableLandmarks : [])) {
    if (!lm || !lm.name || seen.has(normName(lm.name))) continue;
    seen.add(normName(lm.name));
    const loc = bibleLocationOf(visualBible, lm);
    const locBase = loc ? String(loc.id).trim().toUpperCase().split('.')[0] : null;
    if (locBase && bases.has(locBase)) continue; // stood on: its own vantages are the candidates
    const photo = coverPhotoOf(lm);
    if (!photo) continue;
    const base = locBase || `NEW:${normName(lm.name)}`;
    out.push({
      id: `${base}+`, base, shot: 'wide', name: lm.name, visited: false,
      offered: { landmark: lm, photo, locId: locBase },
      label: `${lm.name}${lm.type ? ` (${String(lm.type).toLowerCase()})` : ''}: ${photoText(photo).slice(0, 140)} — a famous place of the town; no story page is set here`,
    });
  }
  return out;
}

/**
 * Write each picked OFFERED landmark into the bible as the place its cover
 * stands at — from structured data only: the landmark's name and type, and its
 * best cover photo's description and number. A landmark already in the bible
 * gets a new wide vantage; one that is not gets a location with one wide
 * vantage, linked to the offered landmark like any real landmark
 * (visualBible.linkPreDiscoveredLandmarks) and carrying its photoVariants. The
 * vantage cites that photo (`landmarkPhoto`), so its plate is painted from it.
 * Covers that picked the same offered landmark share the vantage. Mutates;
 * returns coverKey → the vantage id now cited.
 */
function materializeCoverPlaces(visualBible, covers) {
  const out = {};
  if (!visualBible) return out;
  if (!Array.isArray(visualBible.locations)) visualBible.locations = [];
  const made = new Map();
  const nextLocId = () => {
    const nums = visualBible.locations.map(l => Number((String((l && l.id) || '').match(/^LOC(\d+)/i) || [])[1] || 0));
    return `LOC${String(Math.max(0, ...nums) + 1).padStart(3, '0')}`;
  };
  for (const c of covers) {
    if (!c.offered) { out[c.coverKey] = c.cite; continue; }
    const key = normName(c.offered.landmark.name);
    if (made.has(key)) { out[c.coverKey] = made.get(key); continue; }
    const { landmark, photo } = c.offered;
    let loc = c.offered.locId ? visualBible.locations.find(l => String(l.id).toUpperCase() === c.offered.locId) : null;
    const text = photoText(photo);
    if (!loc) {
      loc = {
        id: nextLocId(), label: String(landmark.type || 'landmark').toLowerCase(), name: landmark.name,
        isRealLandmark: true, landmarkQuery: landmark.name, scaleClass: 'landmark', setting: 'outdoor, landmark',
        description: text, appearsInPages: [], coverOnly: true,
      };
      visualBible.locations.push(loc);
      require('./visualBible').linkPreDiscoveredLandmarks({ locations: [loc] }, [landmark]);
    }
    if (!Array.isArray(loc.photoVariants) && Array.isArray(landmark.photoVariants)) loc.photoVariants = landmark.photoVariants;
    if (!Array.isArray(loc.vantages)) loc.vantages = [];
    const n = Math.max(0, ...loc.vantages.map(v => Number(String((v && v.id) || '').split('.')[1] || 0))) + 1;
    const vantage = {
      id: `${loc.id}.${n}`, name: `in front of ${landmark.name}`, shot: 'wide', description: text,
      emptyScenePrompt: `${text} Seen wide, with open, level ground in the foreground in front of it.`,
      landmarkPhoto: String(photo.variantNumber), pages: [], coverOnly: true,
    };
    loc.vantages.push(vantage);
    made.set(key, vantage.id);
    out[c.coverKey] = vantage.id;
  }
  return out;
}

/**
 * The label a cover's FIXED location line carries (`LOC003.1 (<label>)`). A
 * visited vantage is already in the bible text the Art Director reads, so its
 * name is enough. An OFFERED landmark is materialized into the in-memory bible
 * AFTER that text was written and never reaches it — the Art Director saw only
 * "Fislisbach (Stadt), in front of it" and invented a paved town square for a
 * plate that shows a meadow and a distant town (staging
 * job_1791222889407_ypl33vk8u, the opening page). So the label carries what the
 * plate is painted from: the vantage's description, from the chosen photo.
 * @param {Object} visualBible
 * @param {{cite:string, label:string, offered?:Object}} cover
 */
function coverPlaceLabel(visualBible, cover) {
  if (!cover.offered) return cover.label;
  const id = String(cover.cite || '').toUpperCase();
  const vantage = (visualBible && Array.isArray(visualBible.locations) ? visualBible.locations : [])
    .flatMap(l => (Array.isArray(l && l.vantages) ? l.vantages : []))
    .find(v => v && String(v.id).toUpperCase() === id);
  const text = String((vantage && vantage.description) || '').trim();
  return text
    ? `${cover.label}, in front of it — the place as its photo shows it: ${text}`
    : `${cover.label}, in front of it`;
}

/** A cover's own Jev rating below this is a leftover, not a pick (owner: "never a near-zero leftover"). */
const COVER_PLACE_FLOOR = 0.1;

/**
 * THE THREE COVERS MUST BE DISTINCT (owner, 2026-10-04: "Either different
 * landmark that is best or different view point and different cast").
 *   - The front cover picks first: its top-rated candidate.
 *   - Two covers on DIFFERENT landmarks are distinct.
 *   - Two covers on the SAME landmark are distinct only with a different
 *     viewpoint AND a different cast (`casts[i]` as a set of names).
 *   - Every other cover's own rating is at least COVER_PLACE_FLOOR.
 * Code searches every assignment of the other covers: the fewest pairs that
 * are not distinct first, then the fewest covers under the floor, then the
 * highest summed rating; ties keep the earlier
 * candidate. When no assignment meets them all, the best one is returned with
 * `unmet` listing what failed — the caller logs it at error level and ships it
 * flagged. Pure.
 *
 * @param {string[]} coverKeys
 * @param {number[][]} probs - probs[i][j]: cover i, candidate j
 * @param {{cands?:Array<{id:string, base:string}>, casts?:string[][], floor?:number}} [opts]
 * @returns {{pick:number[], unmet:string[]}}
 */
function assignCoverPlaces(coverKeys, probs, { cands = null, casts = null, floor = COVER_PLACE_FLOOR } = {}) {
  const n = coverKeys.length;
  const m = probs.length ? probs[0].length : 0;
  if (!n) return { pick: [], unmet: [] };
  if (!m) throw new Error('assignCoverPlaces: no candidate vantage');
  const C = cands || probs[0].map((_, j) => ({ id: `c${j}`, base: `c${j}` }));
  const castKey = i => [...new Set((casts && casts[i]) || [])].map(x => String(x).trim().toLowerCase()).sort().join('|');
  const front = coverKeys.indexOf('frontCover');
  const pick = new Array(n);
  if (front >= 0) pick[front] = probs[front].reduce((bi, p, j, arr) => (p > arr[bi] + 1e-12 ? j : bi), 0);
  const failures = () => {
    const out = [];
    for (let a = 0; a < n; a++) {
      if (a !== front && probs[a][pick[a]] < floor) out.push(`floor: ${coverKeys[a]} rated ${probs[a][pick[a]].toFixed(2)} for ${C[pick[a]].id}, under ${floor}`);
      for (let b = a + 1; b < n; b++) {
        if (C[pick[a]].base !== C[pick[b]].base) continue;
        const sameView = pick[a] === pick[b];
        const sameCast = castKey(a) === castKey(b);
        if (sameView || sameCast) out.push(`distinct: ${coverKeys[a]} and ${coverKeys[b]} share ${C[pick[a]].base}${sameView ? ' and its viewpoint' : ''}${sameCast ? ' with the same cast' : ''}`);
      }
    }
    return out;
  };
  let best = null;
  const walk = (i) => {
    if (i === n) {
      const unmet = failures();
      const pairs = unmet.filter(u => u.startsWith('distinct:')).length;
      const low = unmet.length - pairs;
      const sum = pick.reduce((s, j, k) => (k === front ? s : s + probs[k][j]), 0);
      // Distinctness first (the owner's must), then the floor, then the ratings.
      const better = !best || pairs < best.pairs || (pairs === best.pairs && (low < best.low || (low === best.low && sum > best.sum + 1e-12)));
      if (better) best = { unmet, pairs, low, sum, pick: [...pick] };
      return;
    }
    if (i === front) { walk(i + 1); return; }
    for (let j = 0; j < m; j++) { pick[i] = j; walk(i + 1); }
  };
  walk(0);
  return { pick: best.pick, unmet: best.unmet };
}

/** The cover question's state: the arc and the whole page plan (shot stripped). */
function coverPlaceState(arc, pages, town = null) {
  const plan = pages.map(p => `Page ${p.pageNumber}: ${jevDecisions.stripPlanShot(p.planLine)}`).join('\n');
  return `THE STORY, beat by beat:\n${String(arc || '').trim() || '(no arc stored)'}\n\n${jevDecisions.PLAN_HEAD}\n${plan}\n\nTHE BOOK'S COVERS each show the cast standing together, whole in frame, on solid ground at a place of this story${town ? ` or a famous place of its town, ${town}` : ''}, seen wide.`;
}

/**
 * Jev ranks, code assigns. Returns no covers (and `reason`) when the bible has
 * no candidate vantage; the caller logs that loudly. A Jev failure throws
 * JevDecisionError (the outage wait already ran).
 *
 * @param {{arc:string, pages:Array, visualBible:Object, coverKeys:string[]}} input
 * @returns {Promise<{covers:Array<{coverKey:string, cite:string, label:string, p:number, shared:boolean, candidates:Object}>, candidates:string[], reason?:string, stats:Object}>}
 */
async function decideCoverPlaces({ arc, pages, visualBible, coverKeys, casts = {}, availableLandmarks = [], town = null }, opts = {}) {
  const stats = jevDecisions.newStats();
  const keys = (coverKeys || []).filter(k => COVER_PLACE_Q[k]);
  const cands = coverPlaceCandidates(visualBible, pages.map(p => Number(p.pageNumber)), availableLandmarks);
  if (!keys.length) return { covers: [], candidates: [], stats: jevDecisions.summarise(stats) };
  if (!cands.length) return { covers: [], candidates: [], reason: 'no wide or ultra-wide vantage of a location a story page stands on, and no offered landmark with a cover photo', stats: jevDecisions.summarise(stats) };
  // TWO RANKINGS (owner, 2026-10-04): the visited vantages compete in one
  // choice per cover, as before; each OFFERED landmark gets its own yes/no per
  // cover — never ranked against the places the story visits, which take
  // nearly all of a shared choice's probability (replay: ~0.01 for every
  // offered landmark). The rating of a candidate is its choice probability or
  // its P(yes); assignCoverPlaces reads both on one scale.
  const state = coverPlaceState(arc, pages, town);
  const visited = cands.map((c, j) => [c, j]).filter(([c]) => !c.offered);
  const offered = cands.map((c, j) => [c, j]).filter(([c]) => c.offered);
  const reqs = [];
  for (const k of keys) {
    if (visited.length) {
      reqs.push({ key: `cover:${k}`, state, questions: { PLACE: { type: 'choice', instructions: COVER_PLACE_Q[k], criteria: Object.fromEntries(visited.map(([c, j]) => [`v${j}`, c.label])) } } });
    }
    if (offered.length) {
      reqs.push({ key: `offered:${k}`, state, questions: Object.fromEntries(offered.map(([c, j]) => [`o${j}`, { type: 'noul', instructions: COVER_OFFERED_Q[k](c.label) }])) });
    }
  }
  const ans = await jevDecisions.runJevRequests(reqs, { ...opts, usageLabel: 'jev_decisions_cover_place', stats });
  const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const probs = keys.map((k) => {
    const row = new Array(cands.length).fill(0);
    const a = ans.get(`cover:${k}`) || [];
    for (const [, j] of visited) {
      row[j] = mean(a.map((x) => {
        const q = x && x.PLACE;
        if (!q || !q.probabilities) throw new JevDecisionError(`Jev cover place answer for ${k} carries no probabilities`);
        return Number(q.probabilities[`v${j}`] || 0);
      }));
    }
    const b = ans.get(`offered:${k}`) || [];
    for (const [, j] of offered) row[j] = mean(b.map(x => jevAuditYes(x, `o${j}`)));
    return row;
  });
  const { pick, unmet } = assignCoverPlaces(keys, probs, { cands, casts: keys.map(k => casts[k] || []) });
  const covers = keys.map((k, i) => ({
    coverKey: k,
    cite: cands[pick[i]].id,
    label: cands[pick[i]].name,
    ...(cands[pick[i]].offered ? { offered: cands[pick[i]].offered, photo: cands[pick[i]].offered.photo.variantNumber } : {}),
    p: +probs[i][pick[i]].toFixed(3),
    shared: pick.filter(j => j === pick[i]).length > 1,
    cast: casts[k] || [],
    candidates: Object.fromEntries(cands.map((c, j) => [c.id, +probs[i][j].toFixed(3)])),
  }));
  log.info(`🖼️ [JEV/cover-place] ${covers.map(c => `${c.coverKey} ${c.cite} ${c.p}${c.shared ? ' (shared)' : ''}`).join(', ')} over ${cands.length} candidate(s) (${stats.calls} calls)${unmet.length ? ` — NOT DISTINCT: ${unmet.join('; ')}` : ''}`);
  return { covers, candidates: cands.map(c => c.id), unmet, stats: jevDecisions.summarise(stats) };
}

/**
 * The covers' pages in the bible's location and vantage tables follow the
 * decided places: every cover page leaves every table, then each cover joins
 * its vantage and that vantage's location. Covers without a decided place keep
 * the bible's own claim. Mutates; returns the number of entries changed.
 *
 * @param {Object} visualBible
 * @param {Map<number,string>} citeByPage - cover page number → vantage id
 */
function applyCoverPlacePages(visualBible, citeByPage) {
  if (!citeByPage.size) return 0;
  const covers = new Set([...citeByPage.keys()].map(Number));
  let changed = 0;
  const rewrite = (obj, field, add) => {
    const before = Array.isArray(obj[field]) ? obj[field].map(Number) : [];
    const uniq = [...new Set([...before.filter(n => !covers.has(n)), ...add])];
    if (JSON.stringify(uniq) !== JSON.stringify(before)) { obj[field] = uniq; changed++; }
  };
  for (const l of (visualBible && Array.isArray(visualBible.locations) ? visualBible.locations : [])) {
    if (!l || !l.id) continue;
    const base = String(l.id).trim().toUpperCase().split('.')[0];
    const vantages = Array.isArray(l.vantages) ? l.vantages : [];
    for (const v of vantages) {
      if (!v || !v.id) continue;
      const id = String(v.id).trim().toUpperCase();
      rewrite(v, 'pages', [...citeByPage].filter(([, c]) => c === id).map(([n]) => Number(n)));
    }
    const field = Array.isArray(l.appearsInPages) || !Array.isArray(l.pages) ? 'appearsInPages' : 'pages';
    rewrite(l, field, [...citeByPage].filter(([, c]) => c.split('.')[0] === base).map(([n]) => Number(n)));
  }
  return changed;
}

// ───────────────────────── THE COVERS' OTHER FIXED FIELDS ─────────────────────────

/**
 * WHAT CODE OWNS ON A COVER (owner, 2026-10-05: "make code own them"). Until
 * then the Art Director wrote a cover's own shot (the image prompt ignores it),
 * timeOfDay and weather (staging Lab #1648: every cover said "morning" in an
 * afternoon-to-dusk book), population (decidePopulation skipped covers), era
 * (absent on all six stored covers) and `looksAt` (checked afterwards by the
 * since-deleted cover_gaze_not_viewer). Now:
 *   shot       `wide` — a cover is a wide portrait (the beat says so);
 *   looksAt    `viewer` on every figure (SETTLED: covers are head-on);
 *   light      the book's own, by cover (coverLight below);
 *   population the decision for the cover's location, when one was made;
 *   era        the story-level era the Visual Bible states.
 * A cover keeps writing only what the beat gives it that code does not decide:
 * its cast, the ids after its location, `aboard`, the prose.
 */
const COVER_SHOT = 'wide';
const COVER_GAZE = 'viewer';

/**
 * The light of each cover, from the story pages' light decisions (b.fixed):
 *   front cover  the book's dominant light: the most frequent timeOfDay among
 *                the outdoor pages (all pages when none is outdoors), a tie
 *                going to the one reached first; the light of the first page
 *                holding it — its weather advice and indoors flag with it;
 *   title page   page 1's light (the story opens as the dedication page does);
 *   back cover   the last story page's light (the story ends as the book closes).
 * `weather` is Jev's advice for that page. Pure; returns null when the source
 * page has no decided light.
 *
 * THE COVER'S OWN PLACE (owner, 2026-10-06): when the cover's place (`location`, a LOC or vantage id) has
 * story pages, the rules above run over THOSE pages only: a cover standing in a cave is lit like the
 * cave pages, not like the book's average. A place no story page stands on (an offered landmark) has no
 * light of its own to read, so the book's pages are the evidence, as before.
 *
 * @param {string} coverKey
 * @param {Array<{pageNumber:number, fixed?:{timeOfDay:string, indoor:boolean, weatherAdvice:string}, jevFixed?:{location?:string}}>} storyBeats
 * @param {string|null} [location] - the cover's decided location / vantage id
 */
function coverLight(coverKey, storyBeats, location = null) {
  const decided = (storyBeats || []).filter(b => b && b.fixed && b.fixed.timeOfDay).sort((a, b) => a.pageNumber - b.pageNumber);
  if (!decided.length) return null;
  const base = id => String(id || '').trim().toUpperCase().split('.')[0];
  const place = location ? base(location) : null;
  const own = place ? decided.filter(b => b.jevFixed && b.jevFixed.location && base(b.jevFixed.location) === place) : [];
  const pages = own.length ? own : decided;
  let src;
  if (coverKey === 'initialPage') src = pages[0];
  else if (coverKey === 'backCover') src = pages[pages.length - 1];
  else {
    const pool = pages.some(b => !b.fixed.indoor) ? pages.filter(b => !b.fixed.indoor) : pages;
    const tally = new Map();
    for (const b of pool) tally.set(b.fixed.timeOfDay, (tally.get(b.fixed.timeOfDay) || 0) + 1);
    const top = Math.max(...tally.values());
    const time = [...tally].find(([, n]) => n === top)[0];
    src = pool.find(b => b.fixed.timeOfDay === time);
  }
  return {
    timeOfDay: src.fixed.timeOfDay,
    indoor: !!src.fixed.indoor,
    // An outdoor source page whose advice is `none` (Jev contradicting its own indoors answer, staging
    // job_1791145238223_50osg2osm p3-p10) pins no weather: `none` outdoors is a fault, and none is invented.
    ...(src.fixed.indoor ? { weather: 'none' } : (src.fixed.weatherAdvice && src.fixed.weatherAdvice !== 'none' ? { weather: src.fixed.weatherAdvice } : {})),
    sourcePage: src.pageNumber,
  };
}

/**
 * The code-decided fields of one cover, to merge into its `jevFixed`. Every
 * field is present only when code has a value for it; a field it has none for
 * stays the Art Director's (a cover location with no population decision, a
 * bible without an era) and the caller logs that.
 *
 * @param {Object} o
 * @param {string} o.coverKey
 * @param {Array} o.storyBeats
 * @param {string|null} o.location - the cover's decided vantage / location id
 * @param {Object<string,{population:string}>} [o.population] - decidePopulation's byLocation
 * @param {string|null} [o.era] - the Visual Bible's story-level era
 */
function coverFacts({ coverKey, storyBeats, location = null, population = null, era = null }) {
  const light = coverLight(coverKey, storyBeats, location);
  const base = location ? String(location).trim().toUpperCase().split('.')[0] : null;
  const pop = base && population && population[base] ? population[base].population : null;
  const eraText = typeof era === 'string' && era.trim() ? era.trim() : null;
  return {
    coverPlace: true,
    shot: COVER_SHOT,
    looksAtAll: COVER_GAZE,
    ...(light ? { timeOfDay: light.timeOfDay, indoor: light.indoor, ...(light.weather ? { weather: light.weather } : {}), lightFromPage: light.sourcePage } : {}),
    ...(pop ? { population: pop } : {}),
    ...(eraText ? { era: eraText } : {}),
  };
}

/**
 * THE POPULATION OF A COVER'S PLACE (owner, 2026-10-06). Population is the place's
 * (decidePopulation), and a cover's place no story page stands on (an offered
 * landmark: the title page and the back cover of staging
 * job_1791267520938_essbvehs8) had no decision. Jev decides it from the cover's own
 * beat, once per place not decided yet. Returns null when every cover place already
 * has a decision.
 *
 * @param {Object} o
 * @param {string} o.arc
 * @param {Array<{pageNumber:number, planLine:string, jevFixed?:{location?:string}}>} o.coverBeats
 * @param {Object} o.visualBible
 * @param {Object<string,Object>} [o.decided] - decidePopulation's byLocation so far
 * @param {Object} [o.opts] - passed to decidePopulation (callImpl in tests)
 * @returns {Promise<{byLocation:Object, stats:Object}|null>}
 */
async function decideCoverPopulation({ arc, coverBeats, visualBible, decided = {}, opts = {} }) {
  const baseOf = id => String(id || '').trim().toUpperCase().split('.')[0];
  const locOf = new Map((coverBeats || [])
    .filter(cb => cb && cb.jevFixed && cb.jevFixed.location && !decided[baseOf(cb.jevFixed.location)])
    .map(cb => [Number(cb.pageNumber), baseOf(cb.jevFixed.location)]));
  if (!locOf.size) return null;
  return jevDecisions.decidePopulation({ arc, pages: coverBeats, visualBible, locOf }, opts);
}

module.exports = {
  litCandidates, offFrameOf, coverLight, coverFacts, decideCoverPopulation, COVER_SHOT, COVER_GAZE,
  decideBriefFields, assembleBriefs, pageLocations, visualBibleJsonOf,
  COVER_PLACE_SHOTS, COVER_PLACE_Q, COVER_OFFERED_Q, COVER_PLACE_FLOOR, COVER_PHOTO_MIN_SCORE, coverPhotoOf, bibleLocationOf, materializeCoverPlaces, coverPlaceLabel, coverPlaceCandidates, assignCoverPlaces, coverPlaceState, decideCoverPlaces, applyCoverPlacePages,
};
