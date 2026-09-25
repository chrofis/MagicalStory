/**
 * Scene-brief contradiction check — does a brief's PROSE agree with its own
 * METADATA?
 *
 * The Art Director writes both halves of a scene brief in one breath: prose the
 * image model renders, and a JSON block that every downstream supervisor reads
 * (figure naming, the entity grid, clothing validation, avatar reference
 * selection). When the two halves disagree, the prose still gets drawn and the
 * metadata still gets trusted — nothing reconciles them, so the contradiction
 * ships.
 *
 * Eight checks, all computed from the brief itself, all free — no API call, no
 * image. Four are contradictions between the two halves (A, B, E and the id
 * variant), three are declared limits the brief exceeds (C, D, G). Only the
 * types in REVIEWABLE reach a prompt.
 *
 * Comparison is deterministic but NOT string equality where names are
 * concerned: `isSameFigureName` (sceneMetadata.js) treats a title prefix or a
 * trailing epithet as the same figure, because the visual bible and a brief's
 * `characters[]` routinely write one person two ways. See that helper for the
 * measured failure that forced it.
 *
 *   cast_unlisted       a cast member the prose describes is absent from
 *                       `characters[]`. Staging `job_1786397108357_q1fjbdzbx`
 *                       p14: the prose describes five people in full detail and
 *                       `sceneIntent` names Daniel and Sarah, while
 *                       `characters[]` lists only three. Daniel and Sarah were
 *                       rendered with no avatar reference at all, and the
 *                       figure-naming call then stamped "Hans" on Daniel.
 *   cast_id_unresolved  `objects[]` carries a `CHR###` id that resolves to no
 *                       visual-bible entry. On that same page `objects[]` held
 *                       CHR003/CHR004 while `visualBible.mainCharacters` uses
 *                       numeric ids and `secondaryCharacters` was empty — the
 *                       Art Director invented CHR ids for main characters, who
 *                       are referred to by name.
 *   population_contradicted  the metadata declares `population: cast_only`
 *                       while the prose orders unnamed figures into the frame.
 *                       Staging `job_1789853503332_riqncqg1i` p1: three boys on
 *                       scooters and unnamed adults at the chess boards, on a
 *                       page declared to hold nobody but its two-person cast.
 *                       They were drawn, then counted as surplus cast.
 *   shot_widened        the page plan asked for a `close-up`, the brief's
 *                       `shot` came back wider, and the plan line staged
 *                       nothing below the waist that would have forced it.
 *
 * Like clothingCheck, this module REPORTS and never fixes. The scene review
 * authored both halves and has the prose in front of it; inventing a
 * `characters[]` entry or a visual-bible figure here would put a person in the
 * book that nobody wrote (owner decision 2026-08-11).
 */

const { log } = require('../utils/logger');
const { extractSceneMetadata, findCastMissingFromMetadata, isSameFigureName } = require('./sceneMetadata');
const { checkVbElementBudget } = require('./vbElementBudget');
// planCounters requires only shotVocabulary, so this is not a cycle. It is the
// one declaration of how a shot column is read — the plan's word and the
// brief's `shot` are classified by the SAME function, so `close‑up` written
// with a non-ASCII hyphen (3 pages in the stored corpus) cannot read as a
// different shot on one side and the same shot on the other.
const { planSegments, classifyShot } = require('./planCounters');
const { closeUpBelowWaistVerbs, CLOSEUP_BELOW_WAIST_PHRASE, CLOSEUP_KEPT_RULE } = require('./shotVocabulary');

// A visual-bible id: three letters, three digits, optionally a landmark variant
// suffix (`LOC003.1` is variant 1 of LOC003 and resolves to it). Anything not
// matching this shape is free text in `objects[]` and is not an id claim.
const VB_ID = /^([A-Z]{3})(\d{3})(?:\.\d+)?$/;

// The collections a visual-bible id can resolve into. `mainCharacters` is
// deliberately absent: its entries carry numeric character ids, not `CHR###`,
// and scenes refer to main characters by name.
const VB_COLLECTIONS = ['secondaryCharacters', 'animals', 'artifacts', 'locations', 'vehicles', 'clothing'];

/** Every id declared anywhere in the visual bible, upper-cased. */
function knownIds(visualBible) {
  const ids = new Set();
  for (const key of VB_COLLECTIONS) {
    const entries = visualBible && visualBible[key];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const id = entry && entry.id;
      if (id) ids.add(String(id).trim().toUpperCase());
    }
  }
  return ids;
}

// ── Text-zone geometry ──────────────────────────────────────────────────────
// Only reached when the text-zone rules are active for the story — the page
// text is overlaid INSIDE the picture (runtime.textZoneRulesActive). With the
// text in a strip below the image there is no zone in the frame to collide with
// and no distribution to hold.

/** `top-left` → {half:'top', side:'left'}; `bottom-full` → {half:'bottom', side:'full'}. */
function parseTextPosition(value) {
  const m = /^(top|bottom)-(left|right|full)$/.exec(String(value || '').trim().toLowerCase());
  return m ? { half: m[1], side: m[2] } : null;
}

/** The lateral side a `position` string sits on, or 'center' / null. */
function lateralSide(position) {
  const p = String(position || '').toLowerCase();
  if (/\bleft\b/.test(p)) return 'left';
  if (/\bright\b/.test(p)) return 'right';
  if (/\b(center|centre|middle)\b/.test(p)) return 'center';
  return null;
}

function checkTextZoneCollision(page, metadata) {
  const pos = parseTextPosition(metadata && metadata.textPosition);
  if (!pos) return null;
  // extractSceneMetadata flattens `characters` to a name list and keeps the raw
  // rows (with position + depth) under `fullData`. Read the raw rows, and accept
  // an already-raw metadata object from a caller that parsed it itself.
  const raw = (metadata && Array.isArray(metadata.fullData && metadata.fullData.characters))
    ? metadata.fullData.characters
    : (metadata && Array.isArray(metadata.characters) ? metadata.characters : []);
  const positions = (metadata && metadata.characterPositions) || {};
  const chars = raw.filter(c => c && typeof c === 'object');
  const hits = [];
  for (const c of chars) {
    const name = String(c.name || '').trim() || '(unnamed)';
    const position = String(c.position || positions[name] || '');
    const depth = String(c.depth || '').toLowerCase();
    const side = lateralSide(position);
    // A `foreground` figure fills the bottom of the frame; a `background` figure
    // sits high in it. `*-full` spans every side; a corner overlaps its own side
    // and the centre.
    const sideOverlaps = pos.side === 'full' || side === null || side === 'center' || side === pos.side;
    if (!sideOverlaps) continue;
    const band = /foreground/.test(position) || depth === 'foreground' ? 'bottom'
      : (depth === 'background' || /background/.test(position)) ? 'top'
        : null;
    if (band && band === pos.half) hits.push(`${name} (${position || depth || 'no position'})`);
  }
  if (hits.length === 0) return null;
  const other = pos.half === 'bottom' ? 'top' : 'bottom';
  return {
    pageNumber: page.pageNumber,
    type: 'textzone_character_collision',
    detail: `textPosition=${metadata.textPosition} sits in the same band as ${hits.join(' and ')}. `
      + `Pick the cheapest fix: move textPosition to the ${other} half (parity allows any \`${other}-full\`, `
      + `and a corner must match page parity), demote the colliding character out of that band, `
      + `or move them to the opposite lateral side.`,
  };
}

/**
 * A COVER STAGES THE CAST ITS BEAT NAMES (2026-09-25). A cover's plan line is
 * code-written (coverBeats.js), so its cast field is an exact comma list — no
 * prose is read. A name there that is a Visual Bible figure (animal, secondary
 * character) or element must be cited in the brief's `objects[]`; a roster name
 * must have a `characters[]` row. Staging job_1790277448294_5herh01j7's front
 * cover dropped the story's creature.
 */
function checkCoverCast(page, metadata, visualBible) {
  const { isCoverPage } = require('./coverBeats');
  if (!page || !isCoverPage(page.pageNumber)) return [];
  const castField = planSegments(String(page.planLine || '').replace(/^\s*PLAN:\s*/i, ''))[1] || '';
  const named = castField.split(',').map(s => s.trim()).filter(Boolean);
  if (named.length === 0) return [];
  const vb = visualBible || {};
  const pool = [];
  for (const key of ['animals', 'secondaryCharacters', 'artifacts', 'vehicles']) {
    const list = Array.isArray(vb[key]) ? vb[key] : Object.values(vb[key] || {});
    for (const e of list) if (e && e.id) pool.push(e);
  }
  const norm = (s) => String(s || '').trim().toLowerCase();
  const md = (metadata && metadata.fullData) || metadata || {};
  const cited = new Set((Array.isArray(md.objects) ? md.objects : []).map(o => String(o || '').split('.')[0].toUpperCase()));
  const rows = new Set((Array.isArray(md.characters) ? md.characters : []).map(c => norm(typeof c === 'string' ? c : c && c.name)));
  const missing = [];
  for (const name of named) {
    const entry = pool.find(e => norm(e.name) === norm(name) || norm(e.label) === norm(name));
    if (entry) {
      if (!cited.has(String(entry.id).toUpperCase())) missing.push(`${name} (${entry.id}) is not cited in \`objects[]\``);
    } else if (!rows.has(norm(name))) {
      missing.push(`${name} has no \`characters[]\` row`);
    }
  }
  if (missing.length === 0) return [];
  return [{
    pageNumber: page.pageNumber,
    type: 'cover_cast_dropped',
    detail: `This cover's plan line names who is in frame, and the brief drops ${missing.length === 1 ? 'one of them' : 'some of them'}: ${missing.join('; ')}. Stage every named figure in the picture, cite it, and describe it in the prose.`,
  }];
}

/**
 * EACH COVER ITS OWN PLACE (2026-09-25; coverBeats.COVER_OWN_PLACE is the rule
 * the beat states). Structured only: the first location id each cover brief
 * cites in `objects[]`. A cover repeats a place when an EARLIER cover cites the
 * same vantage id, or the same location while the bible holds a location no
 * cover cites. Reported on the repeating cover, so the scene review can rewrite
 * it; staging job_1790277448294_5herh01j7 cited LOC001.2 on all three.
 */
function checkCoverLocations(pages = [], visualBible = null) {
  const { isCoverPage } = require('./coverBeats');
  const covers = (pages || [])
    .filter(p => p && isCoverPage(p.pageNumber))
    .sort((a, b) => b.pageNumber - a.pageNumber) // -1, -2, -3
    .map((p) => {
      const meta = p.metadata || extractSceneMetadata(String(p.brief || ''));
      const md = (meta && meta.fullData) || meta || {};
      const loc = (Array.isArray(md.objects) ? md.objects : []).map(String).find(o => /^LOC\d+/i.test(o)) || null;
      return { pageNumber: p.pageNumber, loc: loc ? loc.toUpperCase() : null };
    })
    .filter(c => c.loc);
  if (covers.length < 2) return [];
  const vbLocs = (Array.isArray(visualBible && visualBible.locations) ? visualBible.locations : [])
    .map(l => String(l && l.id || '').toUpperCase()).filter(Boolean);
  const base = (id) => id.split('.')[0];
  const citedBases = new Set(covers.map(c => base(c.loc)));
  const unused = vbLocs.filter(id => !citedBases.has(id));
  const out = [];
  for (let i = 1; i < covers.length; i++) {
    const c = covers[i];
    const earlier = covers.slice(0, i);
    const sameVantage = earlier.find(e => e.loc === c.loc);
    const sameBase = earlier.find(e => base(e.loc) === base(c.loc));
    if (sameVantage || (sameBase && unused.length > 0)) {
      const other = sameVantage || sameBase;
      out.push({
        pageNumber: c.pageNumber,
        type: 'cover_location_repeated',
        detail: `This cover cites ${c.loc}, the place the cover on page ${other.pageNumber} already uses (${other.loc}). `
          + (unused.length > 0
            ? `Set it at a location no cover uses yet (${unused.join(', ')}).`
            : `Set it at a vantage of ${base(c.loc)} no other cover cites (add one to the location's \`vantages[]\` if needed).`),
      });
    }
  }
  return out;
}

/**
 * A COVER PAGE'S TWO BEAT FACTS (owner, 2026-09-24). A cover is a page the Art
 * Director briefs from its beat (coverBeats.js); two facts of that beat are
 * mechanical, so they are checked here and handed to the scene review like any
 * brief fault:
 *   - every figure looks at the viewer (`looksAt: "viewer"`) — the cover gaze
 *     rule (docs/SETTLED.md: covers are head-on portraits);
 *   - the text goes where the book's text goes (`coverBeats.COVER_TEXT_POSITION`).
 * Story pages return nothing.
 */
function checkCoverBrief(page, metadata) {
  const { isCoverPage, coverKeyOfPage, COVER_TEXT_POSITION } = require('./coverBeats');
  if (!page || !isCoverPage(page.pageNumber)) return [];
  const out = [];
  const raw = (metadata && Array.isArray(metadata.fullData && metadata.fullData.characters))
    ? metadata.fullData.characters
    : (metadata && Array.isArray(metadata.characters) ? metadata.characters : []);
  const off = raw
    .filter(c => c && typeof c === 'object' && c.name)
    .filter(c => !/^(viewer|the viewer|camera)$/i.test(String(c.looksAt || '').trim()))
    .map(c => `${c.name} (${c.looksAt ? `looksAt "${c.looksAt}"` : 'no looksAt'})`);
  if (off.length > 0) {
    out.push({
      pageNumber: page.pageNumber,
      type: 'cover_gaze_not_viewer',
      detail: `This is a book cover: every figure looks at the viewer. ${off.join(', ')} — set \`looksAt: "viewer"\` and turn the figure toward the viewer in the prose.`,
    });
  }
  // A brief with no `textPosition` (a story whose text-zone rules are off
  // carries none) is not a fault: the render takes the beat's position. Only a
  // brief that DECLARES another zone contradicts its beat.
  const want = COVER_TEXT_POSITION[coverKeyOfPage(page.pageNumber)];
  const got = String((metadata && metadata.textPosition) || '').trim();
  if (want && got && got !== want) {
    out.push({
      pageNumber: page.pageNumber,
      type: 'cover_text_zone_mismatch',
      detail: `This cover's text needs \`textPosition: "${want}"\` (its beat's copy space); the brief has ${got ? `"${got}"` : 'none'}. Keep that band clear of every figure and prop.`,
    });
  }
  return out;
}

/**
 * R1 — the distribution floors, tallied across the finished book. Verbatim from
 * the old unified chain (the since-deleted story-unified.txt "Distribution
 * requirements across the full story" + outline-analysis check 20; the live
 * statement of the rule is prompts/scene-expansion-all.txt): full-width between 30% and 50% of
 * pages, at least 30% top-*, at least 30% bottom-*, never more than 3
 * consecutive pages in the same half. Parity is NOT re-checked here — it
 * survived into the Art Director's own rule set.
 *
 * @param {Array<{pageNumber:number, metadata?:Object, brief?:string}>} pages
 * @returns {Array} findings, each carrying `pageNumber: 0` (whole book)
 */
function checkTextZoneDistribution(pages = []) {
  const rows = [];
  for (const page of pages || []) {
    // The book-wide floors are over the STORY pages; a cover's copy space is
    // its beat's (checkCoverBrief), never a vote in the distribution.
    if (!(Number(page && page.pageNumber) > 0)) continue;
    const metadata = (page && page.metadata) || extractSceneMetadata(String((page && page.brief) || ''));
    const pos = parseTextPosition(metadata && metadata.textPosition);
    if (pos) rows.push({ pageNumber: page.pageNumber, ...pos });
  }
  const total = rows.length;
  if (total === 0) return [];
  const findings = [];
  const add = (type, detail) => findings.push({ pageNumber: 0, type, detail });
  const pct = (n) => Math.round((n / total) * 100);

  const fullRows = rows.filter(r => r.side === 'full');
  const fullPct = pct(fullRows.length);
  if (fullPct < 30 || fullPct > 50) {
    add('textzone_fullwidth_floor',
      `${fullRows.length}/${total} pages (${fullPct}%) use \`top-full\` or \`bottom-full\`; between 30% and 50% must. `
      + `Flip the pages whose scene naturally carries an edge-to-edge calm band — wide and ultra-wide shots, `
      + `aerial shots, landscape-heavy scenes, a clean sky band above or a smooth ground band below.`);
  }
  for (const half of ['top', 'bottom']) {
    const n = rows.filter(r => r.half === half).length;
    if (pct(n) < 30) {
      add(`textzone_${half}_floor`,
        `${n}/${total} pages (${pct(n)}%) use a \`${half}-*\` position; at least 30% must.`);
    }
  }
  const sorted = [...rows].sort((a, b) => a.pageNumber - b.pageNumber);
  let run = [];
  const streaks = [];
  for (const r of sorted) {
    const contiguous = run.length && r.pageNumber === run[run.length - 1].pageNumber + 1 && r.half === run[0].half;
    if (!contiguous) { if (run.length > 3) streaks.push(run); run = []; }
    run.push(r);
  }
  if (run.length > 3) streaks.push(run);
  for (const streak of streaks) {
    add('textzone_half_streak',
      `pages ${streak.map(r => r.pageNumber).join(', ')} all put the text in the ${streak[0].half} half; `
      + `never more than 3 consecutive pages in the same half.`);
  }
  return findings;
}

// ── Object states ─────────────────────────────────────────────────────────
// A stated object (`states[]`) has NO base cell — its states ARE the rendered
// cells — so every page citing it lands on one of them, and a bare citation
// falls back to `states[0]` (visualBible.defaultObjectState). The authoring
// templates make that safe by requiring the UNALTERED look first; when the Art
// Director instead opens with a change, every page before the story makes that
// change is rendered in it.
//
// Measured on staging job_1789343124794_z2c779f7i: an artifact's first state
// was "muddy and cracked" claiming pages 3-15, while the story finds the object
// clean and glowing on p3-p8, muddies it on p9 and cracks it on p10. The
// page-prompt path caught the disagreement (`resolveObjectState` →
// `contradicted`) and dropped the delta from the PROSE, but that happens after
// the review and it cannot swap the attached reference cell: p3-p5 rendered a
// dark, cracked, mud-crusted object six pages before the mud exists.
//
// Both checks below are the same fault seen from two sides, and the review is
// the one place with the plan lines in front of it, so it is the one place the
// page ranges can be corrected.

/** Entries carrying a non-empty `states[]`, by base id. */
function statedEntries(visualBible) {
  const out = new Map();
  for (const key of VB_COLLECTIONS) {
    const entries = visualBible && visualBible[key];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const id = entry && entry.id && String(entry.id).trim().toUpperCase().split('.')[0];
      if (!id || !Array.isArray(entry.states) || entry.states.length === 0) continue;
      out.set(id, entry);
    }
  }
  return out;
}

/** The id claims in a brief's `objects[]`, as {base, handle}. */
function objectHandles(metadata) {
  const objects = (metadata && Array.isArray(metadata.objects)) ? metadata.objects : [];
  const out = [];
  for (const raw of objects) {
    if (typeof raw !== 'string') continue;
    const handle = raw.trim();
    const m = VB_ID.exec(handle.toUpperCase());
    if (m) out.push({ base: m[1] + m[2], handle });
  }
  return out;
}

// ── H — the prose peoples a setting the metadata declares empty ──────────────
//
// `population` is a DECLARATION the whole downstream pipeline trusts: the
// evaluator's SETTING POPULATION line (N-09) and the presence arithmetic
// (evalPipeline.derivePresenceFinding) both read it, and neither ever infers it
// from prose — by design, so that a figure count is arithmetic and not a second
// reading of the brief. That design only holds while the two halves of the
// brief agree.
//
// Measured on job_1789853503332_riqncqg1i p1: `population: "cast_only"` while
// the same brief's prose orders "three older boys on metal scooters" past the
// wall and "unnamed adults" at the chess boards. The image model drew what the
// prose ordered, the arithmetic counted them against a cast of two and billed a
// CRITICAL `extra_character`, the consolidator's answer ("remove five figures")
// was refused as un-inpaintable, and the semantic judge scored the same page
// 100 with those same figures in `expected.characters`. The page shipped at 45.
//
// So this is a BRIEF fault, caught where every other prose-vs-metadata
// disagreement in this file is caught, and fixed where briefs are fixed — the
// scene review sets `population` to the state its own prose describes, or drops
// the background figures out of the prose. Nothing here infers a population:
// the check REPORTS the contradiction and never rewrites the field, exactly as
// the module header promises.
//
// TWO SIGNALS IN ONE CLAUSE, never a people-noun alone. Measured over the 18
// briefs of job_1789853503332_riqncqg1i: a plural people-noun with no cast name
// beside it fired on 5 pages and 4 of them were the CAST being framed — "the two
// boys", "the boys huddled out of the wind", "the four boys kneel". Prose names
// the cast collectively all the time, and a clause is too short a window to tell
// a collective noun from a stranger. So the clause must ALSO place those people
// away from the cast — in the background or midground, in the distance, across
// the space — or say outright that they are nobody the story names.
const BACKGROUND_PEOPLE = /\b(?:people|persons|adults|grown-?ups|grownups|children|kids|boys|girls|men|women|teenagers|teens|passers-?by|passersby|bystanders|onlookers|spectators|pedestrians|shoppers|tourists|visitors|villagers|townsfolk|townspeople|customers|commuters|students|workers|labourers|laborers|strangers|riders|cyclists|walkers|joggers|skaters)\b/i;

// Either half is enough: a figure the prose calls unnamed is not cast whatever
// its depth, and a figure the prose puts in the background is not cast whatever
// it is called.
const NOT_THE_CAST = /\b(?:unnamed|anonymous|nameless|passers-?by|passersby|bystanders|onlookers|spectators|strangers|townsfolk|townspeople|villagers|other people|more people)\b|\b(?:a|the|one|dense|thick|large|whole|surrounding)[ ]crowds?\b|\bcrowds?[ ]of\b/i;
const AWAY_FROM_THE_CAST = /\b(?:background|midground|mid-ground|far side|far end|in the distance)\b/i;

// A DEFINITE COLLECTIVE IS THE CAST. "the two boys", "all four boys", "both
// children" is how every brief refers to its own roster without naming it, and
// a background marker elsewhere in the same sentence ("far in the background
// behind them, the tower…") then made the roster read as strangers — 7 of the
// 31 clauses this check first raised over the stored corpus. An explicit
// anonymity word outranks it: "the anonymous adults" is not the cast.
const CAST_COLLECTIVE = /\b(?:the|both|all|our|his|her|their|these|those)[ ](?:\w+[ ]){0,2}(?:boys|girls|children|kids|friends|siblings|twins|companions|group)\b/i;

const PEOPLE_NEGATED = /\b(?:no|not|none|nobody|never|without|empty|free|devoid|deserted|absent|lacking)\b/i;

/** Split prose into clauses a cast name can be looked for in. */
function proseClauses(text) {
  return String(text || '')
    .split(/(?<=[.!?;:])\s+|\s+—\s+|\n+/)
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * The prose halves a brief states people in: the illustrator-facing prose, and
 * the two metadata fields that are themselves prose (`sceneIntent` is the
 * page's instant, `imageSummary` is what the image prompt is built from).
 */
function populatedProse(brief, metadata) {
  const body = String(brief || '').split(/---\s*METADATA\s*---/i)[0] || '';
  const full = (metadata && metadata.fullData) || {};
  return [body, full.sceneIntent || '', full.imageSummary || ''].join('\n');
}

function checkPopulationContradiction(page, metadata, castNames = []) {
  const { normalisePopulation } = require('./sceneMetadata');
  const full = (metadata && metadata.fullData) || {};
  const declared = normalisePopulation(
    metadata?.population || full.population || null,
    metadata?.crowdExpected === true || full.crowdExpected === true,
  );
  if (declared !== 'cast_only') return null;

  const names = (castNames || []).map(n => String(n || '').trim()).filter(Boolean);
  const hits = [];
  for (const clause of proseClauses(populatedProse(page && page.brief, metadata))) {
    if (!BACKGROUND_PEOPLE.test(clause)) continue;
    if (!NOT_THE_CAST.test(clause) && !AWAY_FROM_THE_CAST.test(clause)) continue;
    if (CAST_COLLECTIVE.test(clause) && !NOT_THE_CAST.test(clause)) continue;
    if (PEOPLE_NEGATED.test(clause)) continue;
    if (names.some(n => clause.toLowerCase().includes(n.toLowerCase()))) continue;
    const quoted = clause.length > 120 ? `${clause.slice(0, 117)}…` : clause;
    // The same sentence reaches here twice on most briefs (the prose body and
    // `imageSummary` restate each other); a finding quoting it twice reads as
    // two faults.
    if (!hits.includes(quoted)) hits.push(quoted);
  }
  if (hits.length === 0) return null;

  return {
    pageNumber: page.pageNumber,
    type: 'population_contradicted',
    clauses: hits,
    detail: `\`population\` is \`cast_only\` — "this page holds the EXPECTED CAST and no other people" — while the prose puts unnamed figures in the frame: `
      + hits.map(h => `"${h}"`).join('; ')
      + `. The evaluator and the figure count both read that field, so the people the prose orders are drawn and then billed as surplus cast. `
      + `Set \`population\` to \`ambient\` if the setting is a public place that simply has people in it, or to \`crowd\` if the page is written around them — or take the unnamed figures out of the prose and keep \`cast_only\`.`,
  };
}

/**
 * N — `timeOfDay` / `weather` missing, or not one of the declared values
 * (the parser normalises an unknown word to null). Reported to the scene
 * review, which owns the fields like every other metadata field it rewrites.
 */
function checkLightDeclared(page, metadata) {
  const { declaredLight, SCENE_LIGHT_FIELD_RULE } = require('./sceneLight');
  const light = declaredLight(metadata);
  const missing = ['timeOfDay', 'weather'].filter(f => !light[f]);
  if (missing.length === 0) return null;
  return {
    pageNumber: page.pageNumber,
    type: 'light_undeclared',
    fields: missing,
    detail: `The metadata declares no valid ${missing.map(f => `\`${f}\``).join(' or ')}. ${SCENE_LIGHT_FIELD_RULE} Set ${missing.length > 1 ? 'them' : 'it'} from the light the prose describes and the book's time.`,
  };
}

/**
 * I — the page's own instant disagrees with the state it resolves to.
 *
 * Reuses `resolveObjectState`, the ONE place a page's state is decided, in
 * `silent` mode: the prompt path logs the same disagreement later, and a second
 * WARN per page would read as two faults.
 */
function checkObjectStateContradiction(page, metadata, visualBible) {
  const stated = statedEntries(visualBible);
  if (stated.size === 0) return [];
  const { resolveObjectState } = require('./visualBible');
  const { elementDisplayLabel } = require('./vbIdGuard');
  const findings = [];
  const seen = new Set();
  for (const { base, handle } of objectHandles(metadata)) {
    const entry = stated.get(base);
    if (!entry || seen.has(base)) continue;
    seen.add(base);
    try {
      const r = resolveObjectState(entry, handle, page.pageNumber, metadata, { silent: true, visualBible });
      if (!r || !r.contradicted || !r.state) continue;
      const label = elementDisplayLabel(entry) || entry.name || base;
      // The WORDS the verdict rests on, not just the sentence they sit in: this
      // axis decides on vocabulary two states share, and the reviewer is the
      // one reader who can tell "the egg in the hollow" (a cavity in the
      // ground) from a cracked shell's hollow interior. Evidence, not a
      // classification - the type and its severity are untouched.
      const words = (r.evidenceTokens || []).map(t => `"${t}"`).join(', ');
      const asserts = r.contradictedBy === 'appearance' && r.rival
        ? `the page's own instant asserts "${r.rival.name}" instead${words ? `, on the word(s) ${words}` : ''}${r.evidence ? ` ("${r.evidence}")` : ''}`
        : "the page's own interactions[] contradict that state's contact";
      findings.push({
        pageNumber: page.pageNumber,
        type: 'vb_state_contradicted',
        ids: [base],
        detail: `This page resolves ${label} (${base}) to ${r.state.id} ("${r.state.name}": ${r.state.delta}), and ${asserts}. `
          + `The reference cell follows the state, so the object is drawn in a look the page has not reached. `
          + `Correct the entry's state pages: a state's pages begin at the page whose plan line makes that change, `
          + `and the pages before it belong to the object's unaltered first state.`,
      });
    } catch (err) {
      log.warn(`[BRIEF-CHECK] page ${page && page.pageNumber}: object state ${base}: ${err.message}`);
    }
  }
  return findings;
}

/**
 * J — the unaltered look is missing or mis-ranged.
 *
 * Whole-book, because the earliest page that cites an entry is only visible
 * across the briefs — and it is read from the BRIEFS, never from the bible's
 * own `pages`, which is the thing under suspicion.
 */
function checkObjectStateBase(pages = [], visualBible = null) {
  const stated = statedEntries(visualBible);
  if (stated.size === 0) return [];
  const { elementDisplayLabel } = require('./vbIdGuard');
  const earliest = new Map();
  for (const page of (pages || [])) {
    const n = Number(page && page.pageNumber);
    // A cover (negative page number) is not a step in the story: it takes the
    // object's FINAL state by rule (visualBible.resolveObjectState rule 0),
    // so it never decides which state opens the book.
    if (!Number.isFinite(n) || n <= 0) continue;
    const metadata = (page && page.metadata) || extractSceneMetadata(String((page && page.brief) || ''));
    for (const { base } of objectHandles(metadata)) {
      if (!stated.has(base)) continue;
      if (!earliest.has(base) || n < earliest.get(base)) earliest.set(base, n);
    }
  }
  const findings = [];
  for (const [base, first] of earliest) {
    const entry = stated.get(base);
    try {
      const opening = entry.states[0];
      const covers = Array.isArray(opening && opening.pages) && opening.pages.map(Number).includes(first);
      if (covers) continue;
      const label = elementDisplayLabel(entry) || entry.name || base;
      findings.push({
        pageNumber: first,
        type: 'vb_state_no_base',
        ids: [base],
        detail: `${label} (${base}) is first staged on page ${first}, and its first state ${opening && opening.id ? `${opening.id} ` : ''}`
          + `("${(opening && opening.name) || '?'}": ${(opening && opening.delta) || '?'}) covers page(s) ${JSON.stringify((opening && opening.pages) || [])}, not page ${first}. `
          + `A bare citation falls back to the first state, so page ${first} is drawn in a change the story has not made there. `
          + `The unaltered look must be the first state, carrying the pages up to the first change, and each later state starts at the page whose plan line makes it.`,
      });
    } catch (err) {
      log.warn(`[BRIEF-CHECK] object state base ${base}: ${err.message}`);
    }
  }
  return findings;
}

// ── Bible page tables vs brief citations ─────────────────────────────
// The Art Director is told, verbatim: "An entry's `pages` and the `objects[]` of
// the page briefs below say the same thing" (prompts/scene-expansion-all.txt,
// the `pages` is earned rule). Both halves are written in one call and nothing
// compared them, so the two tables were free to drift — and every consumer
// downstream reads ONE of them. `pages` drives the reference-cell pick, the
// element budget and the usage rebuild; `objects[]` drives REQUIRED OBJECTS and
// what the illustrator is actually shown. When they disagree the page is built
// from one table and judged against the other.
//
// Structured only: the entry ids, the citation handles and the page numbers.
// Never the prose, never a finding's text.
//
// The page table is read through `vbEntityCoversPage` (iterateBeat.js), the one
// place that already answers "does this entry claim this page" — `pages` unioned
// with `appearsInPages` and every `states[]` row's own pages. It returns null
// when an entry declares no page anywhere, and null is UNKNOWN, not "no page":
// an entry with an empty or missing `pages[]` is skipped in both directions
// rather than coerced into an absence (the same fallback `normalizeCitedHandles`
// takes, 796b070e5). A state handle resolves through its parent — `ART001.2` is
// a citation of ART001 — because the page tables being compared belong to the
// entry, and which FACET a page lands on is what `vb_state_contradicted` and
// `vb_state_no_base` already judge.

// The pools whose entries a brief is REQUIRED to cite. `clothing` is the one
// member of VB_COLLECTIONS deliberately left out: the citation rule lists
// "secondary characters, animals, artifacts and vehicles" and locations, and a
// CLO entry reaches the illustrator through the wearer's clothing contract, not
// through `objects[]` — it is never cited, so every CLO entry would flag on
// every page it claims. Measured on the corpus below: 104 of them.
const CITABLE_POOLS = VB_COLLECTIONS.filter(k => k !== 'clothing');

/** Every visual-bible entry that carries a citable id, by base id. */
function bibleEntries(visualBible) {
  const out = [];
  for (const key of CITABLE_POOLS) {
    const raw = visualBible && visualBible[key];
    const list = Array.isArray(raw) ? raw : Object.values(raw || {});
    for (const entry of list) {
      if (!entry || !entry.id) continue;
      const id = String(entry.id).trim().toUpperCase().split('.')[0];
      if (!VB_ID.test(id)) continue;
      out.push({ id, entry, pool: key });
    }
  }
  return out;
}

/**
 * The base ids a page's `objects[]` cites, whatever shape the rows are in.
 *
 * Read with `findVbIds`, not an anchored match: a row is `ART001`, `ART002.2`
 * or the labelled prose form the trial writer emits (`red leaf bucket
 * [ART002]`), and an anchored regex sees a citation in the first two and none
 * in the third. Every 6-page story in the corpus is written that way, and
 * reading them anchored flagged every element on every page.
 */
function citedBaseIds(metadata) {
  const objects = (metadata && Array.isArray(metadata.objects)) ? metadata.objects : [];
  const { findVbIds, baseVbId } = require('./vbIdGuard');
  const out = new Map();
  for (const raw of objects) {
    const row = String(typeof raw === 'string' ? raw : (raw && raw.id) || '').trim();
    if (!row) continue;
    for (const hit of findVbIds(row)) {
      const base = baseVbId(hit);
      if (base && !out.has(base)) out.set(base, hit);
    }
  }
  return out;
}

/**
 * K — the bible's authored page table and the page's own citations disagree.
 *
 * Two directions, reported as two types because the fix differs:
 *   vb_page_uncited  the entry claims this page and the brief cites nothing that
 *                    resolves to it — the element reaches the illustrator through
 *                    its id and nothing else, so it is either drawn from nothing
 *                    or the page does not belong in its `pages`.
 *   vb_cite_offpage  the brief cites the entry here and the entry's page table
 *                    leaves this page out — the citation earns a page the bible
 *                    never granted, and the budget, the state pick and the usage
 *                    rebuild all read the table, not the citation.
 *
 * A figure carried in `characters[]` counts as cited: a secondary character on
 * the roster is in the frame already, and `objects[]` is not where they belong.
 * Compared with `isSameFigureName`, for the same reason check A is.
 *
 * A garment with a `wornItems` row on this page counts as present too
 * (2026-09-23): the row IS the page's declaration of it, worn or off, and a
 * garment lives in `wornItems`, not `objects[]`. Without this, every page of a
 * worn outer layer faulted — 11 of 11 `vb_page_uncited` findings on staging
 * job_1790100385959_1nitlympp — and the review padded `objects[]` to match.
 */
function checkBiblePageTable(page, metadata, visualBible) {
  const n = Number(page && page.pageNumber);
  if (!Number.isFinite(n) || n <= 0) return [];
  const entries = bibleEntries(visualBible);
  if (entries.length === 0) return [];
  const { vbEntityCoversPage } = require('./iterateBeat');
  const { elementDisplayLabel } = require('./vbIdGuard');
  const cited = citedBaseIds(metadata);
  const { wornItemsFromMetadata } = require('./wornItems');
  const declaredWorn = new Set(wornItemsFromMetadata(metadata).map(w => String(w.id).toUpperCase()));
  const onCast = ((metadata && Array.isArray(metadata.characters)) ? metadata.characters : [])
    .map(c => String(typeof c === 'string' ? c : (c && c.name) || '').trim()).filter(Boolean);
  const uncited = [];
  const offpage = [];
  for (const { id, entry } of entries) {
    const covers = vbEntityCoversPage(entry, n);
    if (covers === null) continue; // no page table anywhere: unknown, not an absence
    if (covers) {
      // A figure on the roster is in the frame already — a name match only ever
      // SUPPRESSES an absence, it is never itself a citation. The other way
      // round costs a false positive: an animal entry named "Mother Dragon"
      // against a cast entry "Mother" is one name under isSameFigureName, and
      // reading that as a citation reported the creature off-page on a page it
      // was never on (staging job_1789163494908_kc2joi4ax p2).
      if (!cited.has(id) && !declaredWorn.has(id) && !onCast.some(name => isSameFigureName(name, entry.name))) uncited.push({ id, entry });
    } else if (cited.has(id)) {
      offpage.push({ id, entry, handle: cited.get(id) });
    }
  }
  const label = (e) => elementDisplayLabel(e.entry) || e.entry.name || e.id;
  const findings = [];
  if (uncited.length > 0) {
    findings.push({
      pageNumber: n,
      type: 'vb_page_uncited',
      ids: uncited.map(e => e.id),
      detail: `The Visual Bible puts ${uncited.map(e => `${label(e)} (${e.id})`).join(' and ')} on page ${n}, `
        + `and this page's objects[] cites ${cited.size ? [...cited.values()].join(', ') : 'no bible id at all'}. `
        + `An entry's \`pages\` and the page briefs' \`objects[]\` say the same thing: either stage `
        + `${uncited.length > 1 ? 'them' : 'it'} in the prose and cite the id here, or drop page ${n} from `
        + `${uncited.length > 1 ? 'those entries' : 'that entry'}'s \`pages\`.`,
    });
  }
  if (offpage.length > 0) {
    findings.push({
      pageNumber: n,
      type: 'vb_cite_offpage',
      ids: offpage.map(e => e.id),
      detail: `objects[] cites ${offpage.map(e => `${e.handle} (${label(e)})`).join(' and ')} on page ${n}, `
        + `and ${offpage.length > 1 ? 'those entries claim' : 'that entry claims'} `
        + `${offpage.map(e => `${e.id} ${JSON.stringify(Array.isArray(e.entry.pages) ? e.entry.pages : [])}`).join(', ')} — page ${n} is not among them. `
        + `The page table is what the element budget, the state pick and the reference cell all read, so add page ${n} `
        + `to the entry's \`pages\` if it really is in frame here, and withdraw the citation if it is not.`,
    });
  }
  return findings;
}

/**
 * Check one page.
 *
 * @param {Object} page
 * @param {number} page.pageNumber
 * @param {string} page.brief          the full scene brief (prose + ---METADATA---)
 * @param {string} [page.planLine]     the page's plan line, for element coverage
 * @param {Object} [page.metadata]     already-parsed metadata, when the caller has it
 * @param {string[]} castNames         the story cast
 * @param {Object} [visualBible]
 * @param {Object} [opts]
 * @param {boolean} [opts.textZoneRules] run the text-zone geometry check
 * @returns {Array<{pageNumber, type, detail, names?, ids?}>}
 */
function checkPage(page, castNames = [], visualBible = null, opts = {}) {
  const findings = [];
  const brief = String((page && page.brief) || '');
  if (!brief.trim()) return findings;
  const metadata = (page && page.metadata) || extractSceneMetadata(brief);
  findings.push(...checkCoverBrief(page, metadata));
  findings.push(...checkCoverCast(page, metadata, visualBible));

  // A — cast the prose describes, `characters[]` omits. Possessive-aware by
  // construction: `Hans's attic` and `Daniel's phone torch` name a place and a
  // prop, not a person in the frame, and counting them produced 4 false
  // positives out of 5 across three stories.
  const missing = findCastMissingFromMetadata(brief, castNames, metadata);
  if (missing.length > 0) {
    const listed = (metadata && Array.isArray(metadata.characters) ? metadata.characters : [])
      .map(c => String(typeof c === 'string' ? c : (c && c.name) || '').trim())
      .filter(Boolean);
    findings.push({
      pageNumber: page.pageNumber,
      type: 'cast_unlisted',
      names: missing,
      detail: `The prose names ${missing.join(' and ')}; characters[] lists ${listed.length ? listed.join(', ') : 'nobody'}. `
        + `Whoever is in the frame belongs in characters[]; whoever is only mentioned should not read as present. `
        + `A figure added this way takes the action the page already has, or "watching" — never a second one.`,
    });
  }

  // B — ids in `objects[]` that resolve to nothing.
  const known = knownIds(visualBible);
  const dangling = { CHR: [], other: [] };
  const objects = (metadata && Array.isArray(metadata.objects)) ? metadata.objects : [];
  for (const raw of objects) {
    if (typeof raw !== 'string') continue;
    const m = VB_ID.exec(raw.trim().toUpperCase());
    if (!m) continue; // free text, not an id claim
    const base = m[1] + m[2];
    if (known.has(base)) continue;
    (m[1] === 'CHR' ? dangling.CHR : dangling.other).push(raw.trim());
  }
  if (dangling.CHR.length > 0) {
    findings.push({
      pageNumber: page.pageNumber,
      type: 'cast_id_unresolved',
      ids: dangling.CHR,
      detail: `objects[] lists ${dangling.CHR.join(', ')}; no visual bible entry has ${dangling.CHR.length > 1 ? 'those ids' : 'that id'}. `
        + `Main characters are referred to by name and appear in characters[], not in objects[].`,
    });
  }
  if (dangling.other.length > 0) {
    findings.push({
      pageNumber: page.pageNumber,
      type: 'object_id_unresolved',
      ids: dangling.other,
      detail: `objects[] lists ${dangling.other.join(', ')}; no visual bible entry has ${dangling.other.length > 1 ? 'those ids' : 'that id'}.`,
    });
  }

  // C — one action per page. Measured over two stories (34 pages, 60 interaction
  // rows, docs/interaction-load-2026-08-23.md): every page declaring two distinct
  // actions failed, 7 of 7, mean semantic 17. How many characters perform the one
  // action does not matter — four sharing a single action averaged 73, two doing
  // two different things averaged 20. Counted from the declared `action` labels,
  // never matched out of the `where` prose: two attempts at pattern-matching that
  // prose produced wrong counts while this was being measured. Briefs written
  // before the field existed carry no labels and never flag.
  const interactions = (metadata && Array.isArray(metadata.interactions)) ? metadata.interactions : [];
  const actions = [...new Set(interactions
    .map(i => (i && String(i.action || '').trim().toLowerCase()))
    .filter(a => a && !PASSIVE_ACTIONS.has(a)))];
  if (actions.length > 1) {
    findings.push({
      pageNumber: page.pageNumber,
      type: 'interaction_multiple_actions',
      detail: `The page declares ${actions.length} separate actions (${actions.map(a => `"${a}"`).join(', ')}); a page shows one. `
        + `Any number of characters may share the one action — give the rest of them watching or standing, or move the second action to its own page.`,
    });
  }

  // E — an actor nobody can resolve. Until 2026-08-24 sanitizeInteractions
  // deleted these rows silently at log.info. Measured over 24 stories / 282
  // pages, that guard fired 9 times: twice on `ANI001` and once on `Drache`
  // (legitimate visual-bible actors, now admitted), twice on `Schatzkiste` (a
  // chest in the actor slot — a real authoring error), and four times on
  // `Wächter One`/`Wächter Two`, secondary characters the prose puts in frame
  // while `characters[]` omits them. Deleting never removed those guards from
  // the picture — the prose still described them — it removed only the line
  // saying what they were doing. So the row is kept and the disagreement is
  // reported here instead, for the review that authored both halves to settle.
  // Compared with isSameFigureName, not string equality, for the same reason
  // check A is: an interactions row saying "Kapitänin Rossa" while
  // characters[] lists "Rossa" is one figure, not an unresolvable actor.
  const castOnPage = ((metadata && Array.isArray(metadata.characters) ? metadata.characters : [])
    .map(c => String(typeof c === 'string' ? c : (c && c.name) || '').trim())
    .filter(Boolean));
  const vbKnown = knownIds(visualBible);
  const unresolved = new Set();
  for (const row of interactions) {
    if (!row || !row.character) continue;
    for (const part of String(row.character).split(/\s*(?:\+|&|\band\b|,)\s*/i)) {
      const name = part.trim();
      if (!name || castOnPage.some(entry => isSameFigureName(entry, name))) continue;
      const handle = /^([A-Z]{3})(\d{3})(?:\.\d+)?$/.exec(name.toUpperCase());
      if (handle && vbKnown.has(handle[1] + handle[2])) continue;  // a visual-bible actor
      unresolved.add(name);
    }
  }
  if (unresolved.size > 0) {
    const names = [...unresolved];
    findings.push({
      pageNumber: page.pageNumber,
      type: 'interaction_actor_unknown',
      names,
      detail: `interactions[] gives an action to ${names.map(n => `"${n}"`).join(' and ')}, `
        + `who ${names.length > 1 ? 'are' : 'is'} neither in characters[] nor a visual bible entry. `
        + `A person in the frame belongs in characters[]; an animal or object belongs to its visual bible id; `
        + `anything that is not in the picture should not be given an action at all.`,
    });
  }

  // D — one object, one pair of hands. Measured 2026-08-23 on
  // job_1787493968756_4fgr5nukroz: every hand-off scored at the bottom of the
  // book (10, 20, 30) while one-character-one-object pages scored 70–100 in the
  // same story. Counted from the declared `hands` flag and the character names
  // already on the row — a fused "A + B" row is two pairs of hands on one
  // object, which is the hand-off shape. Rows without the flag never count.
  // A location id is never a one-grip object, and a joint hold that is the
  // page's only action is allowed (owner, 2026-09-23 — sceneMetadata).
  const { forbiddenSharedGrips, SHARED_GRIP_RULE } = require('./sceneMetadata');
  for (const { obj, who } of forbiddenSharedGrips(interactions)) {
    findings.push({
      pageNumber: page.pageNumber,
      type: 'interaction_object_shared_hands',
      detail: `${who.length} characters (${who.join(', ')}) have hands on "${obj}" at once, and that joint hold is not the page's only action. ${SHARED_GRIP_RULE} `
        + `Make the joint hold the one action, or draw the moment before or after the hand-over, or move the second character to watching.`,
    });
  }

  // G — the VB element budget (owner, 2026-09-06; FOUR since 2026-09-11,
  // VB_ELEMENT_BUDGET): packable Visual Bible elements on a page — a garment
  // its owner's avatar wears is not one. Counted and ranked in
  // vbElementBudget.js against the same set and the same priority order the
  // reference selection uses, so the finding names exactly the elements the
  // packer would keep and drop.
  const overflow = checkVbElementBudget(page.pageNumber, metadata, visualBible);
  if (overflow) findings.push(overflow);

  // I — the page's instant disagrees with the object state it resolves to.
  findings.push(...checkObjectStateContradiction(page, metadata, visualBible));

  // K — the bible's page table and this page's citations disagree.
  findings.push(...checkBiblePageTable(page, metadata, visualBible));

  // E2 — the plan asked for a close-up and the brief came back wider.
  //
  // Rule 5d already tells the Art Director "a close-up is not widened into an
  // establishing shot without need" and nothing measured whether it held.
  // Measured over 24 staging books to 2026-09-20: 19 planned close-ups were
  // delivered wider, and on 12 of them the plan line was clean — the AD invented
  // the below-waist staging itself, usually by carrying a sitting pose over from
  // the neighbouring page, and then owed itself the wider frame. On
  // job_1789853503332_riqncqg1i that took the close-up off the hatching page,
  // whose plan line is a pure waist-up holding beat.
  //
  // A widening the PLAN caused is legitimate here and is not reported: the
  // planner is the one that has to answer it, and planCounters raises
  // SHOT_CLOSEUP_BELOW_WAIST against the same verb list for exactly that case.
  // Reporting it twice would have the Art Director rewrite around a fault it
  // did not author.
  const planLine = String((page && page.planLine) || '');
  if (planLine) {
    const planSegs = planSegments(planLine);
    const plannedShot = planSegs.length ? classifyShot(planSegs[0]) : 'other';
    // `extractSceneMetadata` puts the brief's own JSON under `fullData` and
    // lifts only some fields to the top — `shot` is not one of them. Every
    // other reader in the pipeline spells it this way round (images.js,
    // scaleRepair.js, storyJobPipeline.js); reading `metadata.shot` alone finds
    // nothing on a real brief and the check silently never fires.
    const declaredShot = String((metadata && ((metadata.fullData && metadata.fullData.shot) || metadata.shot)) || '').trim();
    const gotShot = classifyShot(declaredShot);
    const planStaged = closeUpBelowWaistVerbs(planSegs.slice(1).join(' — '));
    if (plannedShot === 'close-up' && declaredShot && gotShot !== 'close-up' && planStaged.length === 0) {
      findings.push({
        pageNumber: page.pageNumber,
        type: 'shot_widened',
        // WHAT THIS DOES NOT CLAIM. The plan line was screened against an
        // explicit verb list (${CLOSEUP_BELOW_WAIST_PHRASE}) and that list is
        // narrow on purpose — reading the 13 pages it raises over the stored
        // corpus, several plan lines do stage something below the waist in
        // words no verb can catch ("lands on his hands", "digging with bare
        // hands", "on the bottom step"). So the finding states the MISMATCH and
        // asks; it must not tell the Art Director its own staging was at fault
        // when on some of these pages the beat genuinely needed the room.
        detail: `The page plan asks for a close-up and the brief came back \`${declaredShot}\`. `
          + `The plan line names none of ${CLOSEUP_BELOW_WAIST_PHRASE}, so nothing in the beat forces the wider frame. `
          + `A sitting, kneeling or crouching pose does NOT force it: a close-up crops the legs away, which is what a close-up is, and a crouch brings the head down to what it is looking at. `
          // The same constant scene-review 7b / 10 and the Art Director's 11c
          // state, so the reviewer is never told to widen what this check
          // reports (Lab 1433 p8, 2026-09-24).
          + `${CLOSEUP_KEPT_RULE} Put \`shot\` back to \`close-up\`, unless the plan line's own words put the subject below the frame line in a phrasing that list does not cover — then keep the wider shot and say in the prose what needs the room.`,
      });
    }
  }

  // (No L. `landmark_view_missing` was removed 2026-09-24, Lab 1433 — see
  // docs/decisions.md: a missing landmarkView already resolves to the
  // exterior photo, and the views it cannot give are not derivable here.)

  // M — the page's camera is one its vantage's plate cannot hold.
  const offPlate = checkShotOffPlate(page, metadata, visualBible);
  if (offPlate) findings.push(offPlate);

  // H — prose peoples a setting the metadata declares empty. Cast names are the
  // same roster check A compares against, so a clause naming one of them is the
  // cast being staged, never the setting's own people.
  const populated = checkPopulationContradiction(page, metadata, castNames);
  if (populated) findings.push(populated);

  // N — the page declares no light (sceneLight.js, owner 2026-09-24). Its
  // `timeOfDay` and `weather` choose the plate it is painted on and write the
  // page prompt's LIGHT line; a page without them inherits whatever light its
  // vantage's base plate was painted in. Structured fields only.
  const lightMissing = checkLightDeclared(page, metadata);
  if (lightMissing) findings.push(lightMissing);

  // F — R4, the text half only. The depth-mismatch half of the old check 24b
  // is deliberately not restored (owner ruling, rule-survival audit 2026-09-03).
  if (opts && opts.textZoneRules) {
    const collision = checkTextZoneCollision(page, metadata);
    if (collision) findings.push(collision);
  }

  return findings;
}

/** A brief's own JSON field, wherever extractSceneMetadata left it. */
function briefField(metadata, key) {
  return String((metadata && ((metadata.fullData && metadata.fullData[key]) || metadata[key])) || '').trim();
}

/**
 * M — a page whose `shot` its vantage's plate cannot hold (2026-09-23).
 *
 * One plate is painted per vantage, from the vantage's own `shot`. Pages at eye
 * level share an eye-level plate, and an angled page on one gets a plate DERIVED
 * from it (shotVocabulary.plateClass, storyJobPipeline). Nothing derives the
 * other way: a page at eye level on an angled plate is drawn on the angled one.
 * On staging job_1790100385959_1nitlympp five pages were: a close-up on the
 * aerial plate (p13), three eye-level pages on the high-angle one (p14, p16,
 * p17) and a medium on the ultra-wide one (p18). The page is resolved to its
 * vantage by getPrimaryVantageForPage, the function the plate grouping uses.
 *
 * THE PLAN'S SHOT WINS (2026-09-24, Lab 1433). When the page's `shot` is the
 * one its plan line asks for, the fault is the VANTAGE's shot, not the page's:
 * the finding never asks for the page's shot to change (the contradiction
 * `shot_widened` and scene-review 7b had), only for a vantage that can hold
 * it. With none, the page stands and the review says so — the review cannot
 * edit a vantage's `shot`. On Lab 1433 p13 and p14 the old wording asked for
 * planned close-ups to become `aerial` / `high-angle`.
 */
function checkShotOffPlate(page, metadata, visualBible) {
  const n = Number(page && page.pageNumber);
  const shot = briefField(metadata, 'shot');
  if (!Number.isFinite(n) || n <= 0 || !shot || !visualBible) return null;
  const { plateClass, PLATE_BASE_CLASS } = require('./shotVocabulary');
  const { getPrimaryVantageForPage } = require('./sceneMetadata');
  const objects = (metadata && Array.isArray(metadata.objects)) ? metadata.objects
    : ((metadata && metadata.fullData && Array.isArray(metadata.fullData.objects)) ? metadata.fullData.objects : []);
  const hit = getPrimaryVantageForPage({ objects, fullData: { shot } }, visualBible, { pageNumber: n });
  const vantages = hit && hit.location && Array.isArray(hit.location.vantages) ? hit.location.vantages : [];
  if (!hit || !vantages.includes(hit.vantage)) return null; // no authored vantage: the plate follows the page's shot
  const plateShot = String(hit.vantage.shot || '').trim();
  const plate = plateClass(plateShot);
  if (plate === PLATE_BASE_CLASS || plateClass(shot) === plate) return null;
  const fits = vantages.filter(v => v && v !== hit.vantage && [PLATE_BASE_CLASS, plateClass(shot)].includes(plateClass(v.shot)));
  const planSegs = planSegments(String((page && page.planLine) || ''));
  const plannedShot = planSegs.length ? classifyShot(planSegs[0]) : 'other';
  const shotIsPlanned = plannedShot !== 'other' && classifyShot(shot) === plannedShot;
  const recite = `Cite a vantage of this place whose plate can: ${fits.map(v => `${v.id} (\`${v.shot}\`)`).join(', ')}`;
  let fix;
  if (shotIsPlanned) {
    fix = fits.length
      ? `${recite}, if one of them shows the place this page needs. Keep \`shot\`: it is the plan line's. If none does, leave the page and say it stands.`
      : '`shot` is the plan line\'s and no vantage of this place can hold it, so leave the page and say it stands.';
  } else {
    fix = fits.length
      ? `${recite}. If none shows the place this page needs, set \`shot\` to \`${plateShot}\`.`
      : `This place has no vantage whose plate can, so set \`shot\` to \`${plateShot}\` and stage the moment at that distance.`;
  }
  return {
    pageNumber: n,
    type: 'shot_off_plate',
    ids: [String(hit.vantageId)],
    detail: `This page is a \`${shot}\` and cites ${hit.vantageId}, whose plate is painted \`${plateShot}\`; a \`${plateShot}\` plate cannot hold a \`${shot}\`. ${fix}`,
  };
}

/**
 * Check every page. Returns findings plus a per-page index the review prompt
 * renders directly — same shape as clothingCheck.checkScenes.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.textZoneRules] run the text-zone checks (R1 + R4).
 *   Pass runtime.textZoneRulesActive(inputData) — see that helper.
 */
function checkScenes(pages, castNames = [], visualBible = null, opts = {}) {
  const all = [];
  for (const page of (pages || [])) {
    try {
      all.push(...checkPage(page, castNames, visualBible, opts));
    } catch (err) {
      log.warn(`[BRIEF-CHECK] page ${page && page.pageNumber}: ${err.message}`);
    }
  }
  try {
    all.push(...checkObjectStateBase(pages, visualBible));
  } catch (err) {
    log.warn(`[BRIEF-CHECK] object state base: ${err.message}`);
  }
  try {
    all.push(...checkCoverLocations(pages, visualBible));
  } catch (err) {
    log.warn(`[BRIEF-CHECK] cover locations: ${err.message}`);
  }
  if (opts && opts.textZoneRules) {
    try {
      all.push(...checkTextZoneDistribution(pages));
    } catch (err) {
      log.warn(`[BRIEF-CHECK] text-zone distribution: ${err.message}`);
    }
  }
  const byPage = new Map();
  for (const f of all) {
    if (!byPage.has(f.pageNumber)) byPage.set(f.pageNumber, []);
    byPage.get(f.pageNumber).push(f);
  }
  return { findings: all, byPage };
}

// Which findings are worth a reviewer's time. MEASURED over the three staging
// stories the checks were built from (42 pages total), not assumed:
//   cast_unlisted       2 pages of 42. Both true: q1fjbdzbx p14 (five people in
//     the prose, three in characters[]) and 7f75jspcz p11 ("Daniel and Hans
//     remain a few steps back, out of the tight frame, their presence felt") —
//     which is a drawability defect in its own right. Rare and specific. SENT.
//     RE-MEASURED 2026-09-01, because that count predates the 2026-08-16
//     widening to visual-bible secondaries: across every story then held on
//     staging the type fired on 6 pages, and all 6 were one false positive —
//     the bible's "Kapitänin Rossa" against a characters[] entry "Rossa",
//     compared as strings. With isSameFigureName the corpus is 0. The type
//     stays SENT: the false positives are gone, and the true shape it was
//     built for (a described figure genuinely absent from characters[]) is
//     covered by tests/manual/sceneCastConsistency.test.js.
//   cast_id_unresolved  11 pages of 42, every one a CHR id invented for a main
//     character. One id short of a real reference, and the page that motivated
//     this work is one of them. SENT.
//   object_id_unresolved 12 pages of 42, all ART ids the brief invents for a
//     prop it introduces itself. No entry means no reference image either way,
//     and there is no measured link to a defect — sending it would have the
//     reviewer rewriting one page in four for nothing. Kept as a diagnostic,
//     NOT sent. Drop or add a type here without touching the others.
//   textzone_*          only produced when the text-zone rules are active for
//     the story (a SHORT text overlaid inside the picture). R1's three
//     distribution floors are a whole-book tally and carry pageNumber 0; R4's
//     collision is per page. Both restore rules the old unified chain enforced
//     and the beats chain silently dropped (rule-survival audit, 2026-09-03).
//   vb_element_overflow  the owner's cap of packable Visual Bible elements
//     per page (three 2026-09-06; FOUR since 2026-09-11, VB_ELEMENT_BUDGET). Mechanical, and the fix is a deletion the
//     reviewer can make without inventing anything. SENT; what survives the
//     review is truncated in code.
//   vb_state_contradicted / vb_state_no_base  a stated object whose states[]
//     page ranges disagree with the story (2026-09-14). Both are mechanical —
//     the first reuses `resolveObjectState`, the second compares the first
//     state's pages against the earliest page a brief cites the entry on — and
//     the fix is a page-range edit the reviewer can make from the plan lines it
//     already holds. Evidence: job_1789343124794_z2c779f7i, where the opening
//     state was a change claiming 12 pages and the first six rendered altered.
//     SENT.
//   vb_page_uncited / vb_cite_offpage  the bible's authored page table and the
//     briefs' citations disagree (2026-09-17). scene-expansion-all.txt states
//     the contract verbatim — "An entry's `pages` and the `objects[]` of the
//     page briefs below say the same thing" — and nothing verified it.
//     MEASURED over every staging story whose bible was authored under that
//     rule (15 stories, 209 pages, the rule landed with 061521b95 on
//     2026-09-11): 34 findings on 31 pages of 209, 29 uncited and 5 off-page.
//     Every one inspected by hand against its plan line, and every one a real
//     disagreement — no false positives. Four stories carry all 34 and eleven
//     are clean; the two worst (17 and 13) are the first two runs after the
//     rule landed, and the five most recent stories produce none. The shapes:
//     a blanket `pages` range over the whole book, a page table that runs a
//     page past the location change, a table that claims more elements for a
//     page than the element budget allows (the brief obeyed the budget, the
//     bible did not), and — the other way — a citation the plan line justifies
//     on a page the bible forgot to grant. The fix is a page-range or citation
//     edit the reviewer can make from the plan lines it already holds, and the
//     table it corrects is what the reference-cell pick, the element budget and
//     the usage rebuild all read. SENT.
//     The same sweep over all 124 stored stories returns 758 flagged pages of
//     1370; those bibles were authored before the rule existed, by the writer
//     rather than the Art Director, and their `pages` was never a claim about
//     the briefs. That number measures the old contract, not this one.
//     NOT the catcher for job_1789584708605_rts4wqupm p14/p15: applyBriefUsage
//     emptied those state rows AFTER the review, and this check runs before it.
//     On that story's AUTHORED table it names p18, the page the cracked state
//     claimed and no brief stages (tests/unit/scene-brief-bible-pages.test.ts).
//   element_uncited      REMOVED 2026-09-18, after six days live (owner call).
//     It fired when a word taken from a bible entry's name/type appeared in the
//     plan line's staged segment while `objects[]` did not cite that entry's
//     id — it decided what a page stages by matching prose, which is the one
//     thing a code check may not do (classification belongs to the PROMPT; code
//     may only change a severity).
//     MEASURED before removal, replayed over the 138 stored staging stories (30
//     carry both a bible and plan lines; 451 pages in scope): 137 findings on
//     118 pages — 26% of every page it could see — of which 28 TRUE (20%), 103
//     FALSE (75%) and 6 unclear. IN PRODUCTION, over the 10 runs since it
//     shipped in 4d169a6a3 (2026-09-12): 43 fired, 9 true, 33 false, 1 unclear.
//     The scene review ACTED on 20 of those 43 and got it wrong 12 times, and
//     the damage is in the stored final briefs: a hatched dragon added to SIX
//     egg pages of 9oxos7dwv; the correct cold-egg citation ART001.2 REMOVED
//     from 3kxqshifx p16 and replaced by the dragon, one page before the hatch;
//     VEH001 — a wreck "spanning the width of a house" — added to a museum
//     interior holding a forearm-length model in y3n0euk3z p1; an iron crowbar
//     added to ueh8h145m p1, whose own plan line puts it in a bunk aboard
//     another ship.
//     Three false shapes are STRUCTURAL, not tunable: a creature entry reduced
//     to its name matches the unhatched egg the story calls by that name (19
//     findings); the head-noun rule took the LAST token of the `type` sentence,
//     so "Julian's bicycle" typed "child's balance or pedal bicycle, smaller
//     than Levin's" yielded the word `levin` (11 findings in one story); and a
//     one-word head noun cannot separate a wedged stone from a stone wall, or a
//     lantern from a lantern man. This entry's own former claim — "1 page of 18
//     and no false ones" — does not reproduce: on that same story it names 2 of
//     18, one true and one false.
//     THE RULE ITSELF STAYS, stated where classification belongs:
//     `prompts/scene-review.txt:72` check 9d for the critic, and
//     `prompts/scene-expansion-all.txt:157` for the Art Director ("An entry's
//     `pages` and the `objects[]` of the page briefs below say the same
//     thing"). Over the same briefs 9d named 4 pages this code structurally
//     could not see — one where the plan line says "shell" while the code's
//     word for that entry was `egg` — and declined to repeat 20 of the 41 pages
//     the code handed it, nearly all false. HONEST LIMIT: it is not proven the
//     reviewer finds all 9 true ones unaided, because 9d and this check shipped
//     in the SAME commit and the reviewer has never run without the code's line
//     in front of it. Do not rebuild it as a code check; widen 9d instead.
//     docs/decisions.md, 2026-09-18.
//
// THE SECOND READER (2026-09-17). Everything above measures these types against
// the AUTHORED brief, the one the scene review reads once before any render. A
// repaired page's brief is written a second time, by the iterate rewrite, and
// that rewrite BECOMES the page's contract — the judges score against it and it
// is promoted onto the page record. `iterateBeat.checkRewrittenBrief` runs
// `checkPage` over it, so these same types are now the rewrite's contract too.
// Three differences, all decided there and all measured on the 11 stored
// iterate rounds of two staging runs:
//   - `cast_unlisted` fires on the rewrite whatever the parent did
//     (`element_uncited` did too until it was removed on 2026-09-18 — see its
//     entry above); the interaction family, `cast_id_unresolved`,
//     `vb_element_overflow` and `vb_state_contradicted` fire only when the
//     PARENT brief was free of that type, because a rewrite inherits the
//     bible's page tables and cannot be asked inside a page rewrite to fix what
//     it was handed.
//   - `vb_page_uncited` / `vb_cite_offpage` are NOT run on the rewrite. They
//     fire there (5 and 3 of those 11 rounds) and every one of the 8 names a
//     defect `iterateBeat.checkDeclaredSet` already names from the parent's own
//     citation list, in a re-ask of its own. One basis per defect.
//   - `vb_state_no_base` is whole-book (`checkObjectStateBase`) and `checkPage`
//     never produces it, so the iterate path cannot see it.
//   - the `textzone_*` family is not run there: `opts.textZoneRules` is off on
//     that call, and a repaired page usually has its text position locked.
const REVIEWABLE = new Set(['cover_cast_dropped', 'cover_location_repeated', 'cast_unlisted', 'cast_id_unresolved', 'interaction_multiple_actions', 'interaction_object_shared_hands', 'interaction_actor_unknown',
  'vb_element_overflow', 'vb_state_contradicted', 'vb_state_no_base',
  'vb_page_uncited', 'vb_cite_offpage',
  // The scene review already has the brief and the plan line in front of it and
  // already rewrites briefs, so restoring a forfeited close-up costs no extra
  // round — which is why this reports to the reviewer rather than forcing one.
  'shot_widened',
  // The review owns `population` the same way it owns every other metadata
  // field it rewrites, and the fix is one field or one clause — no extra round.
  'population_contradicted',
  // One citation on the page the review already rewrites (2026-09-23) — see
  // checkShotOffPlate. Its sibling `landmark_view_missing` was DELETED on
  // 2026-09-24 (Lab 1433): sent on 18 of 18 pages, it came back `exterior` on
  // every one — the value a missing field already resolves to — and on 17 of
  // them the page cites a dotted LOC id the photo picker reads first, so the
  // field could not have changed the photo at all. docs/decisions.md.
  'shot_off_plate',
  // The review owns `timeOfDay` / `weather` (check 3a); a missing value is one
  // field on a page it already rewrites (sceneLight.js, 2026-09-24).
  'light_undeclared',
  'textzone_character_collision', 'textzone_fullwidth_floor', 'textzone_top_floor', 'textzone_bottom_floor', 'textzone_half_streak',
  // A cover page's two mechanical beat facts (checkCoverBrief, 2026-09-24).
  'cover_gaze_not_viewer', 'cover_text_zone_mismatch']);

// Reserved `action` labels for characters who are present but not acting. They
// are values rather than an omitted field on purpose: when the field was
// optional, exp 818 left 7 of 21 rows blank — a pointer, a speaker and a helmsman
// among them — and each blank silently escaped the one-action count. A reserved
// value makes "not acting" a claim the reviewer can see and disagree with.
const PASSIVE_ACTIONS = new Set(['watching', 'standing']);

/** Render findings as the {BRIEF_FINDINGS} block for scene-review.txt. */
function renderFindingsBlock(byPage) {
  if (!byPage || byPage.size === 0) return '';
  const lines = [];
  for (const pageNumber of [...byPage.keys()].sort((a, b) => a - b)) {
    const sendable = byPage.get(pageNumber).filter(f => REVIEWABLE.has(f.type));
    if (sendable.length === 0) continue;
    // Page 0 is the whole-book tally (the text-position distribution floors),
    // not a page.
    lines.push(pageNumber === 0 ? '- Whole book:' : `- Page ${pageNumber}:`);
    for (const f of sendable) lines.push(`  - [${f.type}] ${f.detail}`);
  }
  if (lines.length === 0) return '';
  return [
    '# BRIEF FAULTS',
    '',
    "Each line states either a disagreement between a brief's prose and its own metadata, found by comparing it against the cast and the visual bible, or a declared limit the brief exceeds. A name can be mentioned without the person being in the frame, so judge each one and rewrite the pages where the fault is real.",
    '',
    ...lines,
  ].join('\n');
}

module.exports = {
  checkPage, checkScenes, renderFindingsBlock, knownIds, REVIEWABLE,
  checkObjectStateContradiction, checkObjectStateBase, statedEntries,
  checkBiblePageTable, bibleEntries, citedBaseIds, CITABLE_POOLS,
  checkTextZoneDistribution, checkTextZoneCollision, parseTextPosition, checkCoverBrief, checkCoverCast, checkCoverLocations,
  checkPopulationContradiction,
  checkShotOffPlate,
  checkLightDeclared,
};
