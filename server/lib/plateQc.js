'use strict';

/**
 * THE PLATE QC'S CHECKS, AND WHICH OF THEM ARE HARD (owner, 2026-09-25).
 *
 * A plate that fails its QC twice keeps the attempt with the less severe
 * defects, not the one with fewer issues. Severity is structural: the judge
 * names, per issue, the check it fails (one of these keys, filled into
 * prompts/empty-scene-qc.txt as {CHECK_KEYS}), and the pixel checks name theirs
 * in code. No issue TEXT is read to decide anything.
 *
 * HARD — the plate is broken as a picture, whatever the page: a box, panel,
 * border, frame or mat; a photograph or another medium; lettering, a signature
 * or a watermark. SOFT — the plate is a picture but differs from the brief in a
 * nuance: setting, figures, camera, light, placements and the rest.
 *
 * Staging job_1790277448294_5herh01j7: the p10 ultra-wide derive kept its first
 * attempt ("a large glowing white rectangular frame in the center") over a
 * re-derive whose only fault was the setting, because both listed one issue;
 * the LOC001.1 base plate failed on its medium, then on a signature, and
 * shipped with nothing saying so.
 */
const PLATE_QC_CHECKS = [
  { key: 'setting', hard: false, what: 'the setting or location' },
  { key: 'naturalness', hard: false, what: 'unnatural shapes, doubled props, contradicting perspective' },
  { key: 'artefact', hard: true, what: 'a white, black or monochrome box, panel or patch, or a border, frame, mat or margin around the picture' },
  { key: 'figures', hard: false, what: 'any person or trace of one, or an animal the scene does not name' },
  { key: 'foreground', hard: false, what: 'no open foreground' },
  { key: 'text', hard: true, what: 'any caption, label, lettering, signature or watermark' },
  { key: 'medium', hard: true, what: 'a medium other than the art style, a photograph made to look painted included' },
  { key: 'camera', hard: false, what: 'the camera' },
  { key: 'framing', hard: false, what: 'the structure or view the FRAMING puts in the frame' },
  { key: 'light', hard: false, what: 'the time of day or weather' },
  { key: 'era', hard: false, what: 'an element from another era' },
  { key: 'placements', hard: false, what: 'a character position with no usable ground' },
  { key: 'geometry', hard: false, what: 'path direction, vanishing point or light direction' },
  { key: 'landmark', hard: false, what: 'the landmark does not resemble its photo' },
  // SOFT (2026-09-26). A wrong or missing vessel is the plate differing from
  // its brief, like `framing` and `landmark`, not a broken picture. Hard would
  // also drop a derived plate to its base on a judgement the check cannot make
  // sure of: which part of a structure the camera sees, and the aboard page
  // that shows a deck and no hull.
  { key: 'structures', hard: false, what: 'a described vessel, vehicle or structure missing, or another kind or shape' },
];

/** Keys the pixel checks in validateEmptyScene file their issues under. */
const PIXEL_CHECK_KEYS = { box: 'artefact', dark: 'dark', textArea: 'text_area' };

/**
 * An issue whose check is not a known key. The judge was given a closed list
 * and JSON mode, so this is a contract breach; it counts as HARD (a defect we
 * cannot classify is not assumed harmless) and validateEmptyScene logs it.
 */
const UNCLASSIFIED = 'unclassified';

const HARD_KEYS = new Set([...PLATE_QC_CHECKS.filter(c => c.hard).map(c => c.key), UNCLASSIFIED]);
const JUDGE_KEYS = new Set(PLATE_QC_CHECKS.map(c => c.key));

/** The {CHECK_KEYS} text of the QC prompt: "setting (the setting or location), …". */
function checkKeysForPrompt() {
  return PLATE_QC_CHECKS.map(c => `${c.key} (${c.what})`).join(', ');
}

/**
 * One judge issue → { check, issue }. A string or an unknown key is
 * UNCLASSIFIED; the caller logs it.
 */
function normaliseJudgeIssue(raw) {
  if (raw && typeof raw === 'object') {
    const check = String(raw.check || '').trim().toLowerCase();
    const issue = String(raw.issue || raw.description || '').trim() || check || 'vision check failed';
    return { check: JUDGE_KEYS.has(check) ? check : UNCLASSIFIED, issue };
  }
  return { check: UNCLASSIFIED, issue: String(raw || 'vision check failed') };
}

/** { hard: findings[], soft: findings[] } of a validateEmptyScene result. */
function qcSeverity(qc) {
  const findings = Array.isArray(qc?.findings) ? qc.findings : [];
  return {
    hard: findings.filter(f => HARD_KEYS.has(f.check)),
    soft: findings.filter(f => !HARD_KEYS.has(f.check)),
  };
}

/**
 * What ships after a plate failed QC and was retried once.
 *
 * - The retry wins when it passes, or when it has fewer HARD defects, or as
 *   many hard and fewer soft ones. Otherwise the first attempt is kept.
 * - A DERIVED plate whose two attempts both carry a hard defect is dropped: its
 *   pages keep the base plate (owner: a wrong camera on the right place beats
 *   no plate).
 * - Any other plate that ships with a defect, hard or soft, ships visibly
 *   (`shipFailed`, the plate_shipped_failed_qc event at error level) — gates are
 *   guidelines, so the plate ships, but never in silence (owner, 2026-10-07: staging
 *   job_1791315635053_t0t8qpebu p4 kept a beach under a water ceiling after two
 *   failed attempts and the log said only `keeping the first attempt`).
 *
 * @param {{firstQc: Object, retryQc: Object|null, derived?: boolean}} a
 *   `retryQc` null = the retry produced no image.
 * @returns {{keep: 'first'|'retry'|'base', shipFailed: boolean, hardDefects: Array<{check,issue}>, softDefects: Array<{check,issue}>}}
 */
function decidePlateAfterRetry({ firstQc, retryQc, derived = false }) {
  const first = qcSeverity(firstQc);
  let keep = 'first';
  if (retryQc) {
    const retry = qcSeverity(retryQc);
    const better = retryQc.pass
      || retry.hard.length < first.hard.length
      || (retry.hard.length === first.hard.length && retry.soft.length < first.soft.length);
    if (better) keep = 'retry';
    if (derived && first.hard.length > 0 && retry.hard.length > 0) {
      return { keep: 'base', shipFailed: false, hardDefects: retry.hard.length <= first.hard.length ? retry.hard : first.hard, softDefects: [] };
    }
  }
  const keptQc = keep === 'retry' ? retryQc : firstQc;
  const kept = keptQc.pass ? { hard: [], soft: [] } : qcSeverity(keptQc);
  return { keep, shipFailed: !keptQc.pass, hardDefects: kept.hard, softDefects: kept.soft };
}

/**
 * The stored QC history of a retried plate: BOTH attempts and which one
 * shipped. `v1ImageData` is always the first attempt and `retryImageData` the
 * retry, so the rejected image is kept whichever of them won.
 */
function plateQcRecord({ firstImage, firstQc, retryImage = null, retryQc = null, retryPrompt = null, outcome }) {
  return {
    v1ImageData: firstImage,
    v1Issues: firstQc?.issues || [],
    visionFeedback: firstQc?.visionFeedback || null,
    retryPrompt: retryPrompt || null,
    retryImageData: retryImage || null,
    retryIssues: retryQc ? (retryQc.issues || []) : null,
    keptAttempt: outcome?.keep || 'first',
    shippedWithHardDefects: outcome?.shipFailed && outcome.hardDefects.length ? outcome.hardDefects : null,
    shippedWithSoftDefects: outcome?.shipFailed && (outcome.softDefects || []).length ? outcome.softDefects : null,
  };
}

/**
 * The emptySceneQc fields a page record carries, from any object holding a
 * plateQcRecord's fields (a sceneBackgrounds slot or a plate result). One copy
 * for the four page whitelists. null when the plate was never retried.
 */
function emptySceneQcOf(src) {
  if (!src?.v1Issues) return null;
  return {
    v1ImageData: src.v1ImageData || null,
    v1Issues: src.v1Issues || null,
    visionFeedback: src.visionFeedback || null,
    retryPrompt: src.retryPrompt || null,
    retryImageData: src.retryImageData || null,
    retryIssues: src.retryIssues || null,
    keptAttempt: src.keptAttempt || null,
    shippedWithHardDefects: src.shippedWithHardDefects || null,
    shippedWithSoftDefects: src.shippedWithSoftDefects || null,
  };
}

/**
 * The plate fields a page record carries, from the page's sceneBackgrounds slot.
 * ONE copy for the first-render record and the missing-image retry: the retry
 * used to set the image only when it had to render the plate, so a page whose
 * plate already existed came back from the retry without it (no
 * `emptySceneImage`, hence no `hasEmptySceneImage` flag — staging
 * job_1791222889407_ypl33vk8u p9 and p14). A null slot yields all-null fields.
 */
function pagePlateFields(slot) {
  return {
    emptySceneImage: slot?.imageData || null,
    emptyScenePrompt: slot?.prompt || null,
    emptySceneGrokRefImages: slot?.grokRefImages || null,
    // Which vantage group the plate came from, and which angled shot a derived
    // plate was made for (null = the vantage base plate): auditable after the run.
    vantageId: slot?.vantageId || null,
    plateDerivedFor: slot?.plateDerivedFor || null,
    textAreaMask: slot?.textAreaMask || null,
    emptySceneVbGrid: slot?.emptySceneVbGrid || null,
    emptySceneQc: emptySceneQcOf(slot),
  };
}

/**
 * A retry whose prompt cannot fit is not sent twice into the same wall: the
 * dispatcher already logged the PromptFitError (prompt_fit_failed), so the
 * retry counts as "no image" and the first attempt is judged alone.
 */
function nullOnPromptFit(err) {
  const { PromptFitError } = require('./promptFitError');
  if (err instanceof PromptFitError) return null;
  throw err;
}

const describeDefects = (list) => list.map(f => `[${f.check}] ${f.issue}`).join('; ');

/**
 * The generation-log events for a retried plate's outcome — one wording for the
 * vantage base plate, the derived plate and the per-page plate.
 */
function logPlateOutcome(genLog, { event, label, pages = null, outcome, firstQc, retryQc }) {
  if (!genLog) return;
  const sev = (qc) => { const s = qcSeverity(qc); return `${s.hard.length} hard, ${s.soft.length} soft`; };
  if (outcome.keep === 'base') {
    genLog.warn(event, `${label}: both attempts carry a hard defect (${describeDefects(outcome.hardDefects)}) — its pages keep the base plate`);
  } else if (outcome.keep === 'retry') {
    genLog.info(event, `${label}: retry ${retryQc.pass ? 'passed QC' : `kept — ${sev(retryQc)} against the first's ${sev(firstQc)}`}`);
  } else {
    genLog.warn(event, `${label}: ${retryQc ? `retry not less severe (${sev(retryQc)}: ${retryQc.issues.join(', ')})` : 'retry produced no image'} — keeping the first attempt (${sev(firstQc)})`);
  }
  if (outcome.shipFailed) {
    const all = [...outcome.hardDefects, ...(outcome.softDefects || [])];
    genLog.error('plate_shipped_failed_qc', `${label} ships with a failed QC (${outcome.hardDefects.length} hard, ${(outcome.softDefects || []).length} soft): ${describeDefects(all)}`, null,
      { label, pages, keptAttempt: outcome.keep, defects: outcome.hardDefects, softDefects: outcome.softDefects || [] });
  }
}

/**
 * The text position a page's plate is judged with. EVERY page plate is judged
 * (owner, 2026-09-26); only its calm-zone grading depends on the layout: a
 * text-in-image page is graded on the zone its author was told to keep calm,
 * a text-below page has no zone and is judged with null — as the vantage and
 * derived plates always were. One rule for the story run's per-page plate and
 * the Test Lab's empty_scene stage.
 */
function plateQcTextPosition(textInImage, textPosition) {
  return textInImage && textPosition ? textPosition : null;
}

module.exports = {
  plateQcTextPosition,
  nullOnPromptFit,
  logPlateOutcome,
  PLATE_QC_CHECKS,
  PIXEL_CHECK_KEYS,
  UNCLASSIFIED,
  checkKeysForPrompt,
  normaliseJudgeIssue,
  qcSeverity,
  decidePlateAfterRetry,
  plateQcRecord,
  emptySceneQcOf,
  pagePlateFields,
};
