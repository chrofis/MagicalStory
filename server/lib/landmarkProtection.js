/**
 * Landmark protection — era-aware guard for pages that carry a real landmark
 * reference photo.
 *
 * WHY (owner ruling 2026-09-05, staging story job_1788614817116_vxnu60yjg p2):
 * page 2 rendered the Uetliberg Fernsehturm and the Uto Kulm spire on the ridge,
 * faithfully from the attached landmark photo ("Oppidum Uetliberg Rampart").
 * The story has NO era anywhere (input_data.era null, VB era null, scene-brief
 * era null) — i.e. present day, and the era guard is empty. The three-stage
 * compliance judge nevertheless invented a historical setting from the words
 * "ancient earthwork" in the prose and emitted
 *   {type: "object_presence", severity: "MAJOR",
 *    description: "Setting includes unrequested modern infrastructure: …",
 *    fix: "Remove transmission towers and replace background with …"}
 * The consolidator's scene_fix.preserve listed six prose items and no landmark,
 * so the instruction reached Grok as an UNMASKED whole-frame edit
 * ("1. Remove red-white transmission tower and grey-red tower from background",
 * targetBbox null). v1 (towers erased) scored 83 against v0's 55 and shipped —
 * the page lost the real geography of the place it depicts.
 *
 * The owner's ruling: a story set in the middle ages SHOULD have modern towers
 * removed; a present-day story MUST keep its landmarks. So the protection is
 * ERA-AWARE, and it is a MECHANICAL RULE computed in code and injected into
 * BOTH the critic (the compliance eval prompt) and the fixer (the consolidator
 * input + its preserve list) — the memory pattern "mechanical rules and
 * fed-back retries".
 *
 * ONE era classifier: `buildEraGuard()` in promptBuilders.js. It returns '' for
 * a missing / "present day" / "contemporary" / "modern day" era and the guard
 * paragraph otherwise. `eraIsHistorical = !!buildEraGuard(era)` — no second
 * classifier is invented here.
 */

const { log } = require('../utils/logger');

/**
 * The era a page was rendered under. Scene metadata is the carrier
 * (sceneMetadata.era, restored 2026-08-11; iterate re-reads it from the saved
 * scene via `fullData.era`) — the same value buildImagePrompt and the iterate
 * path read, so covers/iterate/eval all agree.
 *
 * @param {object|null} sceneMetadata
 * @returns {string|null}
 */
function resolveSceneEra(sceneMetadata) {
  if (!sceneMetadata || typeof sceneMetadata !== 'object') return null;
  return sceneMetadata.era || sceneMetadata.fullData?.era || null;
}

/**
 * Unique landmark names attached to a page, in order.
 * @param {Array<{name?: string}>|null} landmarkPhotos
 * @returns {string[]}
 */
function landmarkNames(landmarkPhotos) {
  if (!Array.isArray(landmarkPhotos)) return [];
  const seen = new Set();
  const out = [];
  for (const lp of landmarkPhotos) {
    const name = String(lp?.name || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/**
 * Compute the page's landmark protection state.
 *
 * @param {object} args
 * @param {Array|null} args.landmarkPhotos - the photos actually attached to the render
 * @param {string|null} args.era - story/scene era (free text)
 * @returns {{names: string[], landmarkPresent: boolean, eraIsHistorical: boolean,
 *            eraGuard: string, protect: boolean}}
 */
function computeLandmarkProtection({ landmarkPhotos = null, era = null } = {}) {
  const names = landmarkNames(landmarkPhotos);
  // Lazy require: promptBuilders pulls in a large graph and this module is
  // required from evalPipeline/feedbackConsolidator at call time.
  const { buildEraGuard } = require('./promptBuilders');
  const eraGuard = buildEraGuard(era) || '';
  const eraIsHistorical = !!eraGuard;
  return {
    names,
    landmarkPresent: names.length > 0,
    eraIsHistorical,
    eraGuard,
    // Protection applies ONLY when a real landmark is attached AND the story is
    // not historical. A historical story keeps modern infrastructure as a
    // legitimate finding — that is the era guard's whole job.
    protect: names.length > 0 && !eraIsHistorical,
  };
}

/**
 * The block injected into the three-stage compliance eval prompt
 * ({LANDMARK_CONTEXT}).
 *
 * - protected page → the landmark's geography and structures are PRESENT BY
 *   DESIGN and can never be `object_presence` / unrequested / anachronism.
 * - historical page carrying a landmark → the era guard's own semantics, so
 *   modern infrastructure REMAINS a legitimate finding.
 * - no landmark → empty (unchanged behaviour).
 *
 * @param {ReturnType<typeof computeLandmarkProtection>} protection
 * @returns {string}
 */
function buildLandmarkComplianceBlock(protection) {
  if (!protection || !protection.landmarkPresent) return '';
  const names = protection.names.join(', ');
  if (protection.protect) {
    return `LANDMARK ELEMENTS — PRESENT BY DESIGN: ${names}.
This page was rendered from a reference photo of that real place, and the story is set in the present day. Everything that belongs to it — its terrain, skyline, towers, masts, antennas, buildings, roads, signage and other built structures — is there because the real place has it. Never report any of it as unrequested, unauthorized, extra, added, modern, out of period, anachronistic, or as a setting mismatch, at any severity, on any axis. Never ask for it to be removed or for the background to be replaced. Judge only whether the landmark is rendered well; do not infer a historical period from words in the prose.`;
  }
  return `LANDMARK ELEMENTS: ${names}. This page was rendered from a reference photo of that real place, but the story is NOT set in the present day:
${protection.eraGuard}
Modern infrastructure visible on this page remains a legitimate finding.`;
}

/**
 * Removal-shaped fix detector.
 *
 * Deliberately scoped to the `fix` field — the EDIT INSTRUCTION — never to the
 * description prose. docs/SETTLED.md forbids classifying a finding by reading
 * its description; this does not classify anything. The finding's own declared
 * `type` (`object_presence`) does the classifying, and this only asks whether
 * the proposed edit is a destructive removal/replacement, which is exactly the
 * operation the owner ruled must not run unmasked on a landmark page.
 */
const REMOVAL_FIX = /\b(remove|removing|removal|delete|deleting|erase|erasing|eliminat\w*|strip|paint\s+out|paint\s+over|take\s+out|replace|replacing)\b/i;

function isRemovalShapedFix(issue) {
  const fix = String(issue?.fix || issue?.suggestion || '').trim();
  if (!fix) return false;
  return REMOVAL_FIX.test(fix);
}

/**
 * HARD GUARD. Drop `object_presence` removal findings on a protected page.
 *
 * Fails loudly: every drop logs a WARN naming the page and the landmark. Never
 * silent — a dropped finding that nobody can see in the log is how the original
 * defect went unnoticed for a whole book.
 *
 * @param {Array} issues
 * @param {ReturnType<typeof computeLandmarkProtection>} protection
 * @param {{pageNumber?: number|string|null, label?: string}} [ctx]
 * @returns {{kept: Array, dropped: Array}}
 */
function filterProtectedRemovals(issues, protection, ctx = {}) {
  const list = Array.isArray(issues) ? issues : [];
  if (!protection?.protect || list.length === 0) return { kept: list, dropped: [] };
  const kept = [];
  const dropped = [];
  for (const iss of list) {
    const type = String(iss?.type || '').toLowerCase();
    if (type === 'object_presence' && isRemovalShapedFix(iss)) {
      dropped.push(iss);
      continue;
    }
    kept.push(iss);
  }
  if (dropped.length && !ctx.quiet) {
    const page = ctx.pageNumber != null ? `P${ctx.pageNumber}` : 'page';
    const where = ctx.label ? `${ctx.label} ` : '';
    for (const d of dropped) {
      log.warn(`🏛️  [LANDMARK-GUARD] ${where}${page}: dropped ${String(d.severity || 'MODERATE').toUpperCase()} object_presence removal on a page carrying landmark "${protection.names.join(', ')}" in a present-day story — an unmasked whole-frame removal would erase the real place. Finding: ${String(d.description || d.issue || '(no description)').slice(0, 300)}`);
    }
  }
  return { kept, dropped };
}

/**
 * Seed the consolidated plan's scene_fix.preserve with the landmark names,
 * unconditionally, on a protected page. The consolidator writes preserve from
 * the scene prose and never named the landmark — so the fixer had nothing
 * telling it the towers on the ridge were the point of the page.
 *
 * @param {object} plan - consolidated plan (mutated)
 * @param {ReturnType<typeof computeLandmarkProtection>} protection
 * @returns {string[]} names added
 */
function seedPreserveWithLandmarks(plan, protection) {
  if (!plan || !protection?.protect) return [];
  if (!plan.scene_fix || typeof plan.scene_fix !== 'object') return [];
  const preserve = Array.isArray(plan.scene_fix.preserve) ? plan.scene_fix.preserve : [];
  const existing = new Set(preserve.map(p => String(p || '').toLowerCase()));
  const added = [];
  for (const name of protection.names) {
    const entry = `${name} — the real landmark this page depicts, including its terrain, skyline and built structures`;
    if (existing.has(entry.toLowerCase()) || preserve.some(p => String(p || '').toLowerCase().includes(name.toLowerCase()))) continue;
    preserve.push(entry);
    added.push(name);
  }
  plan.scene_fix.preserve = preserve;
  return added;
}

module.exports = {
  resolveSceneEra,
  landmarkNames,
  computeLandmarkProtection,
  buildLandmarkComplianceBlock,
  isRemovalShapedFix,
  filterProtectedRemovals,
  seedPreserveWithLandmarks,
};
