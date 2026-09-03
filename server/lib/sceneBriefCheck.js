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
 * Six checks, all computed from the brief itself, all free — no API call, no
 * image. Four are contradictions between the two halves (A, B, E and the id
 * variant), two are declared limits the brief exceeds (C, D). Only the types in
 * REVIEWABLE reach a prompt.
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
 *
 * Like clothingCheck, this module REPORTS and never fixes. The scene review
 * authored both halves and has the prose in front of it; inventing a
 * `characters[]` entry or a visual-bible figure here would put a person in the
 * book that nobody wrote (owner decision 2026-08-11).
 */

const { log } = require('../utils/logger');
const { extractSceneMetadata, findCastMissingFromMetadata, isSameFigureName } = require('./sceneMetadata');

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
 * R1 — the distribution floors, tallied across the finished book. Verbatim from
 * the old unified chain (story-unified.txt "Distribution requirements across the
 * full story" + outline-analysis check 20): full-width between 30% and 50% of
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

/**
 * Check one page.
 *
 * @param {Object} page
 * @param {number} page.pageNumber
 * @param {string} page.brief          the full scene brief (prose + ---METADATA---)
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
  const handRows = interactions.filter(i => i && i.hands === true);
  const perObject = new Map();
  for (const row of handRows) {
    const obj = String(row.object || '').trim().toLowerCase();
    if (!obj) continue;
    const who = String(row.character || '').split(/\s*(?:\+|&|\band\b|,)\s*/i).map(s => s.trim()).filter(Boolean);
    perObject.set(obj, (perObject.get(obj) || []).concat(who.length ? who : ['?']));
  }
  for (const [obj, who] of perObject) {
    if (who.length < 2) continue;
    findings.push({
      pageNumber: page.pageNumber,
      type: 'interaction_object_shared_hands',
      detail: `${who.length} characters (${who.join(', ')}) have hands on "${obj}" at once; one object takes one pair of hands. `
        + `Draw the moment before or after the hand-over — one holds it out, the other reaches — or move the second character to watching.`,
    });
  }

  // F — R4, the text half only. The depth-mismatch half of the old check 24b
  // is deliberately not restored (owner ruling, rule-survival audit 2026-09-03).
  if (opts && opts.textZoneRules) {
    const collision = checkTextZoneCollision(page, metadata);
    if (collision) findings.push(collision);
  }

  return findings;
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
const REVIEWABLE = new Set(['cast_unlisted', 'cast_id_unresolved', 'interaction_multiple_actions', 'interaction_object_shared_hands', 'interaction_actor_unknown',
  'textzone_character_collision', 'textzone_fullwidth_floor', 'textzone_top_floor', 'textzone_bottom_floor', 'textzone_half_streak']);

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
  checkTextZoneDistribution, checkTextZoneCollision, parseTextPosition,
};
