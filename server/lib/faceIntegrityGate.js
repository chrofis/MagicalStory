'use strict';

/**
 * FACE-INTEGRITY GATE (owner, 2026-09-12).
 *
 * A char fix is a MASKLESS whole-frame edit (docs/SETTLED.md: the same class
 * that erased a named animal's head), so an additive instruction can repaint a
 * head it was never meant to touch. Measured on job_1789207854566_l43qgl34w p9:
 * the finding was a false "missing hat" against a figure already wearing one,
 * the repair smeared the face away AND removed the hat, and it still out-scored
 * the original 70 to 10 because no evaluator reads faces.
 *
 * A vision model is shown the BEFORE and the AFTER and asked one comparative
 * question — is the repaired character's face still intact — and a repair that
 * DESTROYS a face is refused.
 *
 * Fails OPEN by design (docs/SETTLED.md: gates are guidelines): a model outage
 * or an unparsable verdict returns `ok: true` with `available: false` rather
 * than stalling a paid run. Every outcome is counted so a permanently-open gate
 * is visible in the metrics instead of looking like a clean pass.
 *
 * One implementation for all three char-repair entry points — the unified
 * pipeline, the manual regeneration endpoint and the entity-consistency
 * single-page repair. It lived inside runUnifiedRepairPipeline until 2026-09-15,
 * so the two manual paths shipped face-destroying repairs unchecked.
 */

const { MODEL_DEFAULTS } = require('../config/models');

/**
 * @param {string} beforeImage - the image as it stood before the repair (data URI or base64)
 * @param {string} afterImage - the repaired image
 * @param {string} charName - the repaired character
 * @param {Object} opts
 * @param {Object} opts.log - logger (required)
 * @param {Function} [opts.usageTracker] - (provider, usage, label, modelId)
 * @param {string} [opts.jobKey] - run-metrics key (story or job id)
 * @param {string} [opts.context] - log prefix, e.g. 'CHAR-FIX Page 9'
 * @returns {Promise<{ok: boolean, available: boolean, reason: string|null}>}
 */
async function checkFaceIntegrity(beforeImage, afterImage, charName, opts = {}) {
  const log = opts.log;
  if (!log) throw new Error('checkFaceIntegrity: opts.log is required');
  const where = opts.context ? `[${opts.context}] ` : '';
  const count = (metric) => {
    if (!opts.jobKey) return;
    try { require('./runMetrics').forJob(opts.jobKey).count(metric); } catch { /* metrics are never fatal */ }
  };

  try {
    const { PROMPT_TEMPLATES } = require('../services/prompts');
    const { callTextModel } = require('./textModels');
    const template = PROMPT_TEMPLATES.repairFaceCheck;
    if (!template) {
      log.warn(`⚠️ [FACE-GATE] ${where}repair-face-check.txt is not loaded — accepting the repair unchecked`);
      count('repair_face_integrity_unavailable');
      return { ok: true, available: false, reason: 'template missing' };
    }
    const res = await callTextModel(
      template.replace(/\{CHARACTER\}/g, charName || 'the repaired character'),
      // null = model max (owner rule: no output caps anywhere). A truncated
      // JSON verdict is worse than a long one.
      null,
      MODEL_DEFAULTS.repairFaceCheck,
      { images: [beforeImage, afterImage], usageLabel: 'repair_face_check' }
    );
    if (res?.usage && opts.usageTracker) {
      opts.usageTracker('openrouter', res.usage, 'repair_face_check', res.modelId);
    }
    const json = String(res?.text || '').match(/\{[\s\S]*\}/);
    const verdict = json ? JSON.parse(json[0]) : null;
    if (!verdict || typeof verdict.intact !== 'boolean') {
      log.warn(`⚠️ [FACE-GATE] ${where}verdict unparsable — accepting the repair`);
      count('repair_face_integrity_unavailable');
      return { ok: true, available: false, reason: 'verdict unparsable' };
    }
    if (verdict.intact === false) {
      count('repair_reject_face_integrity');
      return { ok: false, available: true, reason: verdict.reason || 'no reason given' };
    }
    count('repair_face_integrity_pass');
    return { ok: true, available: true, reason: null };
  } catch (err) {
    log.warn(`⚠️ [FACE-GATE] ${where}face check unavailable (${err.message}) — accepting the repair`);
    count('repair_face_integrity_unavailable');
    return { ok: true, available: false, reason: err.message };
  }
}

module.exports = { checkFaceIntegrity };
