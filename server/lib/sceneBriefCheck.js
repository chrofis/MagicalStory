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
 * Two contradictions, both computed by exact comparison, both free — no API
 * call, no image:
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
const { extractSceneMetadata, findCastMissingFromMetadata } = require('./sceneMetadata');

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

/**
 * Check one page.
 *
 * @param {Object} page
 * @param {number} page.pageNumber
 * @param {string} page.brief          the full scene brief (prose + ---METADATA---)
 * @param {Object} [page.metadata]     already-parsed metadata, when the caller has it
 * @param {string[]} castNames         the story cast
 * @param {Object} [visualBible]
 * @returns {Array<{pageNumber, type, detail, names?, ids?}>}
 */
function checkPage(page, castNames = [], visualBible = null) {
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
        + `Whoever is in the frame belongs in characters[]; whoever is only mentioned should not read as present.`,
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

  // C — hands-on load. Measured over two stories (34 pages, 60 interaction rows,
  // docs/interaction-load-2026-08-23.md): rows putting hands on an object the
  // character is not already carrying fail 88%, and a second one on the same page
  // takes the page's mean semantic score to 18. Counted from the declared
  // `contact` field, never matched out of the `where` prose — two attempts at
  // pattern-matching that prose produced wrong counts while this was measured.
  // Briefs written before the field existed carry no `contact` and never flag.
  const interactions = (metadata && Array.isArray(metadata.interactions)) ? metadata.interactions : [];
  const handsOn = interactions.filter(i => i && String(i.contact || '').toLowerCase() === 'hands');
  if (handsOn.length > 1) {
    findings.push({
      pageNumber: page.pageNumber,
      type: 'interaction_hands_on_excess',
      detail: `${handsOn.length} interactions declare contact:"hands" (${handsOn.map(i => `${String(i.character || '?').trim()}→${String(i.object || '?').trim()}`).join(', ')}); the cap is one. `
        + `Characters acting on one object share a single fused entry; the rest watch or stand.`,
    });
  }

  return findings;
}

/**
 * Check every page. Returns findings plus a per-page index the review prompt
 * renders directly — same shape as clothingCheck.checkScenes.
 */
function checkScenes(pages, castNames = [], visualBible = null) {
  const all = [];
  for (const page of (pages || [])) {
    try {
      all.push(...checkPage(page, castNames, visualBible));
    } catch (err) {
      log.warn(`[BRIEF-CHECK] page ${page && page.pageNumber}: ${err.message}`);
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
//   cast_id_unresolved  11 pages of 42, every one a CHR id invented for a main
//     character. One id short of a real reference, and the page that motivated
//     this work is one of them. SENT.
//   object_id_unresolved 12 pages of 42, all ART ids the brief invents for a
//     prop it introduces itself. No entry means no reference image either way,
//     and there is no measured link to a defect — sending it would have the
//     reviewer rewriting one page in four for nothing. Kept as a diagnostic,
//     NOT sent. Drop or add a type here without touching the others.
const REVIEWABLE = new Set(['cast_unlisted', 'cast_id_unresolved', 'interaction_hands_on_excess']);

/** Render findings as the {BRIEF_FINDINGS} block for scene-review.txt. */
function renderFindingsBlock(byPage) {
  if (!byPage || byPage.size === 0) return '';
  const lines = [];
  for (const pageNumber of [...byPage.keys()].sort((a, b) => a - b)) {
    const sendable = byPage.get(pageNumber).filter(f => REVIEWABLE.has(f.type));
    if (sendable.length === 0) continue;
    lines.push(`- Page ${pageNumber}:`);
    for (const f of sendable) lines.push(`  - [${f.type}] ${f.detail}`);
  }
  if (lines.length === 0) return '';
  return [
    '# BRIEF FAULTS',
    '',
    "Each line states either a disagreement between a brief's prose and its own metadata, found by exact comparison against the cast and the visual bible, or a declared limit the brief exceeds. A name can be mentioned without the person being in the frame, so judge each one and rewrite the pages where the fault is real.",
    '',
    ...lines,
  ].join('\n');
}

module.exports = { checkPage, checkScenes, renderFindingsBlock, knownIds, REVIEWABLE };
