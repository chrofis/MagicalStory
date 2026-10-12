'use strict';
// The landmark guideline in one place (owner rulings 2026-09-04 / 2026-09-05,
// docs/decisions.md "Landmark minimum is a guideline"; moved into the arc and the
// plan 2026-10-12, "Landmarks are staged by the arc and counted on story pages").
// When the reader's location is the BINDING setting and real landmarks were
// offered, the story should stage at least two of them. A strong guideline,
// never a gate: a shortfall that survives the arc's repair loop ships with a
// WARN and `landmarkMinimumShortfall`, it never fails the job.
//
// THE CHAIN, one typed list the whole way:
//   arc      writes "Landmarks staged:" (parseLandmarksStaged resolves each line
//            against the OFFERED list by name; code counts, never reads prose)
//   beats    the divider and the plan check read that list (inputData.landmarksStaged)
//   bible    a staged landmark is a real-landmark LOCATION of a story page, or a
//            `backdropLandmarks` row on one (the Visual Bible's typed field)
//   count    stagedLandmarks(): story pages only (> 0), locations + backdrops

const LANDMARK_MINIMUM = 2;

/** Is the guideline in force for this story? */
function landmarkGuidelineActive(inputData) {
  return inputData?.premiseNamedWorld === false && (inputData?.availableLandmarks?.length || 0) > 0;
}

/** The names the story was offered, in the list's order. */
function offeredLandmarkNames(inputData) {
  return (inputData?.availableLandmarks || []).map(l => String(l?.name || '').trim()).filter(Boolean);
}

/** How many the guideline asks for: two, or every one offered when fewer were. */
function landmarkRequirement(inputData) {
  return Math.min(LANDMARK_MINIMUM, offeredLandmarkNames(inputData).length);
}

// One key for "the same listed name", whatever its case or spacing.
const keyOf = (name) => String(name || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

/** The offered entry a written name stands for (its `name` or its `query`), or null. Data equality, never a prose match. */
function offeredEntryFor(name, offered) {
  const k = keyOf(name);
  if (!k) return null;
  const exact = (offered || []).find(l => keyOf(l?.name) === k || keyOf(l?.query) === k);
  if (exact) return exact;
  // Listed names carry Wikipedia qualifiers ("Lindenhof (Zürcher Hügelzug)", "Rathaus (Zürich)") that a writer drops:
  // agent stand-in arcs wrote "Lindenhof" in 2 of 2 cases (2026-10-12). The bare name counts only when ONE listed entry has it.
  const bare = (s) => keyOf(String(s || '').replace(/\s*\([^)]*\)\s*$/, ''));
  const hits = (offered || []).filter(l => bare(l?.name) === k || bare(l?.query) === k);
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Read the arc's "Landmarks staged:" lines against the OFFERED list.
 * A line is a dash or number bullet (or none) holding a name and nothing else; a
 * trailing "[type]" is dropped, "none" is the empty answer.
 * @param {string[]|null} lines the block's lines (parseArcCreate / parseArcRetell `landmarkLines`); null = no block written
 * @param {Array} offered inputData.availableLandmarks
 * @returns {{present:boolean, names:string[], unlisted:string[]}} `names` are the OFFERED names (list spelling), first
 *   mention order, unique; `unlisted` are lines naming nothing on the list.
 */
function parseLandmarksStaged(lines, offered) {
  if (!Array.isArray(lines)) return { present: false, names: [], unlisted: [] };
  const names = [];
  const unlisted = [];
  for (const raw of lines) {
    const line = String(raw || '').replace(/\*\*/g, '').replace(/^\s*(?:[-–—*•]|\d{1,2}[.)])\s*/, '').replace(/\s*\[[^\]]*\]\s*$/, '').trim();
    if (!line || /^none\.?$/i.test(line)) continue;
    const hit = offeredEntryFor(line, offered);
    if (!hit) { unlisted.push(line); continue; }
    if (!names.includes(hit.name)) names.push(hit.name);
  }
  return { present: true, names, unlisted };
}

/** The one repair line for an arc that stages fewer landmarks than the guideline asks. '' when it does not. */
function landmarkShortfallFinding(stagedNames, inputData) {
  if (!landmarkGuidelineActive(inputData)) return '';
  const need = landmarkRequirement(inputData);
  const have = (stagedNames || []).length;
  if (have >= need) return '';
  const said = have ? `only ${have} (${stagedNames.map(n => `"${n}"`).join(', ')})` : 'none';
  return `The "Landmarks staged:" block names ${said} of the listed landmarks; the guideline asks for at least ${need}. Where a sentence's place is, or stands beside, a listed landmark, stage it there and list it by its exact name; a listed landmark cannot be listed unless a sentence takes place at it or beside it. Never relocate the story or bend the plot to reach one.`;
}

/**
 * The findings code counts on an arc's "Landmarks staged:" lines, as the array
 * arcRepairFindings({ codeFindings }) takes: [] or [the shortfall line]. A missing
 * block (`lines` null) counts as none staged, as production reads it. The Test Lab's
 * arc mirrors call this where beatsPipeline reads its landmark answer (sibling set
 * arc-retell-gate).
 */
function arcLandmarkCodeFindings(lines, inputData) {
  const { names } = parseLandmarksStaged(lines, (inputData && inputData.availableLandmarks) || []);
  const finding = landmarkShortfallFinding(names, inputData);
  return finding ? [finding] : [];
}

/**
 * The landmarks a Visual Bible STAGES on a story page (pages > 0; the covers
 * are -1..-3): a real-landmark location whose pages include one, or a
 * `backdropLandmarks` row ({landmarkQuery, pages}) naming an OFFERED landmark.
 * Cover-only places no longer count (owner, 2026-10-12).
 * @returns {Array<{name:string, via:'location'|'backdrop', pages:number[]}>} unique by name, a location winning over a backdrop
 */
function stagedLandmarks(vb, offered = []) {
  const out = [];
  const storyPages = (pages) => (Array.isArray(pages) ? pages : []).map(Number).filter(n => Number.isFinite(n) && n > 0);
  const add = (name, via, pages) => {
    const k = keyOf(name);
    if (!k || !pages.length) return;
    const have = out.find(o => keyOf(o.name) === k);
    if (have) { have.pages = [...new Set([...have.pages, ...pages])].sort((a, b) => a - b); return; }
    out.push({ name, via, pages });
  };
  for (const l of ((vb || {}).locations || [])) {
    if (l && l.isRealLandmark) add(l.landmarkQuery || l.name, 'location', storyPages(l.appearsInPages || l.pages));
  }
  for (const b of ((vb || {}).backdropLandmarks || [])) {
    const hit = b && offeredEntryFor(b.landmarkQuery, offered);
    if (hit) add(hit.name, 'backdrop', storyPages(b.pages));
  }
  return out;
}

function describeStagedLandmarks(staged) {
  return staged.length ? staged.map(l => `"${l.name}"`).join(', ') : 'none';
}

module.exports = {
  LANDMARK_MINIMUM,
  landmarkGuidelineActive,
  offeredLandmarkNames,
  landmarkRequirement,
  offeredEntryFor,
  parseLandmarksStaged,
  landmarkShortfallFinding,
  arcLandmarkCodeFindings,
  stagedLandmarks,
  describeStagedLandmarks,
};
