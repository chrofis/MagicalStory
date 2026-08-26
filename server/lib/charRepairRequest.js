/**
 * charRepairRequest.js — the ONE contract for a character-repair call.
 *
 * `repairCharacterFace` (and its `repairCharacterMismatch` wrapper) used to have
 * its options object assembled by hand in two places: the unified pipeline
 * (repairPipeline.js) and the Test Lab stage (testlab.js). Nothing tied the two
 * together, so they drifted in BOTH directions — the Lab was missing
 * clothingDescription, detectionBodyMask, imageBackend, issueDescription and
 * whiteoutTarget, and neither passed `artStyle`, which left every production
 * repair prompt without its "Art style — match this medium" block.
 *
 * A Lab run that does not send what production sends cannot reproduce a defect
 * or verify a fix, which is the whole point of the Lab. So the field list lives
 * here once, both callers build through this module, and any deliberate Lab
 * deviation has to be passed as an explicit `overrides` object — making it a
 * value the parity test can see rather than a difference buried in a 7k-line
 * file. Declared divergences are indexed in docs/lab-divergences.md.
 */

/**
 * Canonical field list. Adding a field here is what makes it reach BOTH the
 * pipeline and the Lab; a field not listed is rejected, so a new option cannot
 * be wired into one caller only.
 */
const CHAR_REPAIR_REQUEST_KEYS = Object.freeze([
  'imageBackend',          // provider for the repaint ('grok' in production)
  'issueDescription',      // the finding being fixed — drives the repair axes
  'clothingDescription',   // the outfit contract for this character on this page
  'characterDescription',  // face/hair/build prose for the prompt
  'photoType',             // which avatar variant was handed over
  'sceneDescription',      // the page's scene prose
  'artStyle',              // the book's medium — empty block without it
  'faceBbox',              // face region (face repair)
  'bodyBbox',              // figure region (full-character repair)
  'whiteoutTarget',        // 'face' | 'body' — chooses the repair method
  'detectionBodyMask',     // reuse the detection silhouette instead of re-running SAM
  'protectedFaces',        // other characters that must not be repainted
  'protectedBodies',
  'textPosition',          // keeps the repaint out of the text zone
  'includeDebug',          // per-step debug images
  // THE THREE AXES, selectable. The spine has always read opts.treatment /
  // regionSource / faceOnly, but nothing could set them: callers could only
  // pick a legacy flag combination and take whatever mapping fell out. That
  // made "is blur better than whiteout for a face?" unaskable — the exact
  // question the 2026-08-05 whole-figure decision answered for the body and
  // nobody ever answered for the head. Omitted → the mapping decides, so
  // production behaviour is unchanged.
  'treatment',             // 'blur' | 'crosshatch' | 'whiteout'
  'regionSource',          // 'box' | 'cutout'
  'faceOnly',              // head vs whole figure
]);

/**
 * Build the options object for a character repair.
 *
 * @param {Object} fields - values for the canonical keys; missing keys become null
 * @param {Object} [options]
 * @param {Object} [options.overrides] - deliberate deviation from what production
 *   would send. Test Lab only, and every key used here must be listed in
 *   docs/lab-divergences.md with a status.
 * @returns {Object} options for repairCharacterFace / repairCharacterMismatch
 */
function buildCharRepairRequest(fields = {}, { overrides = null } = {}) {
  const unknown = Object.keys(fields).filter(k => !CHAR_REPAIR_REQUEST_KEYS.includes(k));
  if (unknown.length > 0) {
    throw new Error(
      `buildCharRepairRequest: unknown field(s) ${unknown.join(', ')} — add them to `
      + 'CHAR_REPAIR_REQUEST_KEYS so BOTH the pipeline and the Test Lab send them, '
      + 'or pass them as an explicit override (see docs/lab-divergences.md).',
    );
  }
  const request = {};
  for (const key of CHAR_REPAIR_REQUEST_KEYS) {
    request[key] = key in fields ? fields[key] : null;
  }
  if (!overrides) return request;

  const unknownOverrides = Object.keys(overrides).filter(k => !CHAR_REPAIR_REQUEST_KEYS.includes(k));
  if (unknownOverrides.length > 0) {
    throw new Error(`buildCharRepairRequest: unknown override(s) ${unknownOverrides.join(', ')}`);
  }
  return { ...request, ...overrides };
}

module.exports = { CHAR_REPAIR_REQUEST_KEYS, buildCharRepairRequest };
