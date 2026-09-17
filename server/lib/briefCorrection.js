/**
 * ONE CORRECTIVE LOOP FOR EVERY BRIEF PATH (owner, 2026-09-17: "All 3 same as
 * pipeline. These should be siblings or even identical code.")
 *
 * A brief is authored on one path and REWRITTEN on another, and both run the
 * same deterministic checks over the result. What happened to the findings
 * afterwards was not the same job twice — it was one job and one crude copy of
 * it, and the copy measurably did not work: across the 11 stored iterate rounds
 * of staging job_1789584708605_rts4wqupm and job_1789506283204_3kxqshifx the
 * re-ask fired once per page and reduced the finding count on ZERO of them, so
 * the original was kept every time and every page shipped with a WARN.
 *
 * Three defects, all of them in the copy, all of them fixed here so that
 * neither path can carry them alone:
 *
 *  1. THE CORRECTOR SEES THE TEXT IT IS CORRECTING. The iterate re-ask sent the
 *     ORIGINAL prompt plus the findings and asked for "the whole brief again" —
 *     a model cannot revise an artefact it was not shown, so that was a re-roll
 *     wearing a correction's clothes. `assertCorrectorSeesText` makes the
 *     payload carry it, and throws when it does not: a silent re-roll is worse
 *     than a loud failure because it bills like a correction.
 *  2. THE VERDICT IS INTRODUCED-VS-SURVIVED, NEVER A COUNT. `n_after < n_before`
 *     scores a correction that resolves one fault and creates another as EQUAL,
 *     and rejects it — while never asking WHICH faults moved. `judgeCorrection`
 *     partitions by (page, type) the way the authored path's post-review
 *     re-check always has, and takes a correction only when it resolves at
 *     least one finding and introduces none.
 *  3. THE MODEL IS THE PIPELINE'S. The iterate re-ask reused the same
 *     `sceneIteration` model that had just failed the contract.
 *     `MODEL_DEFAULTS.briefCorrectionModel` is the one name both paths read.
 *
 * The two paths issue their correction differently and that difference is real:
 * the authored path's correction is one whole-book review that also answers
 * ~20 non-mechanical checks and spawns a nested worn-state round between the
 * call and the re-check, and by owner ruling (2026-08-11) it is advisory — it
 * reports, it never refuses. The rewrite path's correction is one call about
 * one page that must be taken or refused. So `correctFindings` accepts either
 * an `invoke` that makes the call or the `completed` output of a call the
 * caller already made; every other step — the payload contract, the re-check,
 * the partition, the verdict, the telemetry — is this file, once.
 */

const { log } = require('../utils/logger');

/**
 * A finding's identity for before/after comparison: the page it is on and its
 * type. Never its prose — classification belongs to the prompt and a detail
 * string is free to be reworded between two runs of the same check.
 */
function findingKey(f) {
  if (!f) return '';
  const page = (f.pageNumber === undefined || f.pageNumber === null) ? '' : f.pageNumber;
  return `${page}|${f.type}`;
}

/**
 * Which findings did the correction RESOLVE, which SURVIVED it, and which did
 * it INTRODUCE? The authored path has partitioned exactly this way since its
 * post-review re-check shipped; this is that logic, lifted so one
 * implementation answers for both paths.
 */
function partitionFindings(before = [], after = []) {
  const beforeKeys = new Set((before || []).filter(Boolean).map(findingKey));
  const afterKeys = new Set((after || []).filter(Boolean).map(findingKey));
  return {
    introduced: (after || []).filter(f => f && !beforeKeys.has(findingKey(f))),
    survived: (after || []).filter(f => f && beforeKeys.has(findingKey(f))),
    resolved: (before || []).filter(f => f && !afterKeys.has(findingKey(f))),
  };
}

/**
 * ACCEPTANCE MODES.
 *  - `strict`: take the correction only when it resolves at least one finding
 *    and introduces none. A correction that swaps one fault for another is
 *    refused, and the reason names both halves.
 *  - `advisory`: the correction is taken whatever it did, and the partition is
 *    reported. The authored path's ruling (owner, 2026-08-11), kept because a
 *    reviewer that authored both halves may not be second-guessed in code.
 */
const ACCEPTANCE = new Set(['strict', 'advisory']);

function judgeCorrection({ before = [], after = [], acceptance = 'strict' } = {}) {
  if (!ACCEPTANCE.has(acceptance)) throw new Error(`briefCorrection: unknown acceptance "${acceptance}"`);
  const parts = partitionFindings(before, after);
  const name = (f) => `${f.pageNumber ? `p${f.pageNumber} ` : ''}${f.type}`;
  if (acceptance === 'advisory') {
    return { ...parts, accepted: true, reason: 'advisory: the correction stands and its faults are reported' };
  }
  if (parts.introduced.length > 0) {
    return {
      ...parts,
      accepted: false,
      reason: `refused: introduces ${parts.introduced.map(name).join(', ')}`
        + (parts.resolved.length > 0 ? ` while resolving ${parts.resolved.map(name).join(', ')}` : ''),
    };
  }
  if (parts.resolved.length === 0) {
    return { ...parts, accepted: false, reason: 'refused: resolves nothing' };
  }
  return {
    ...parts,
    accepted: true,
    reason: `taken: resolves ${parts.resolved.map(name).join(', ')}`
      + (parts.survived.length > 0 ? `, ${parts.survived.map(name).join(', ')} survive` : ''),
  };
}

/**
 * THE PAYLOAD CONTRACT: a corrector is shown the text it is correcting.
 *
 * Both paths assert it against the payload they actually send, so the defect
 * cannot come back on either one — the authored path carries the briefs in the
 * review prompt's own scenes block, the rewrite path in the block
 * `renderCorrectionRequest` builds. A sample from the middle of the text is
 * enough, and taking it from the middle survives the head/tail trimming a
 * prompt shrinker does.
 */
function assertCorrectorSeesText(payload, priorText, label = 'correction') {
  const text = String(priorText || '').trim();
  if (!text) throw new Error(`briefCorrection: ${label} has no prior text to correct`);
  const body = String(payload || '');
  const mid = Math.max(0, Math.floor(text.length / 2) - 60);
  const sample = text.slice(mid, mid + 120).trim();
  if (sample && !body.includes(sample)) {
    throw new Error(`briefCorrection: ${label} payload does not carry the text it corrects`);
  }
  return true;
}

/**
 * The corrective request for a single-artefact correction: the answer that was
 * returned, the findings against it, and what to do about them. Terse on
 * purpose — the instruction is the caller's, the shape is this file's.
 */
function renderCorrectionRequest({ context = '', priorText, findingsText, instruction }) {
  const parts = [];
  if (context) parts.push(String(context).trim());
  parts.push('This is the answer you returned:', '', String(priorText).trim(), '');
  parts.push('It breaks the brief contract:', String(findingsText).trim(), '');
  parts.push(String(instruction).trim());
  return parts.join('\n');
}

/**
 * The corrective loop. Findings in → corrected text, or a reasoned refusal.
 *
 * @param {string}   label        for the log line
 * @param {string}   priorText    the artefact being corrected — the payload must carry it
 * @param {string}   payload      the prompt to send (or that was sent)
 * @param {Array}    before       findings against `priorText`
 * @param {Function} [invoke]     async (payload) => { text, usable, usage } — the call
 * @param {Object}   [completed]  the output of a call the caller already made, same shape
 * @param {Function} recheck      (text) => findings, the same checks that produced `before`
 * @param {string}   [acceptance] 'strict' (default) or 'advisory'
 * @returns {Promise<{accepted, text, before, after, resolved, survived, introduced, reason, usage}>}
 */
async function correctFindings({
  label = 'brief', priorText, payload, before = [],
  invoke = null, completed = null, recheck, acceptance = 'strict',
} = {}) {
  if (typeof recheck !== 'function') throw new Error('briefCorrection: recheck is required');
  if (!invoke && !completed) throw new Error('briefCorrection: pass either invoke or completed');
  assertCorrectorSeesText(payload, priorText, label);

  const out = completed || await invoke(payload);
  const usage = out?.usage || null;
  if (!out || out.usable === false || !String(out.text || '').trim()) {
    const parts = partitionFindings(before, before);
    return {
      ...parts, accepted: false, text: priorText, before, after: before, usage,
      reason: `refused: the correction came back unusable${out?.reason ? ` (${out.reason})` : ''}`,
    };
  }
  const after = recheck(out.text) || [];
  const verdict = judgeCorrection({ before, after, acceptance });
  log[verdict.accepted ? 'info' : 'warn'](
    `${verdict.accepted ? '🔄' : '⚠️'} [BRIEF-FIX] ${label}: ${verdict.reason}`,
  );
  return { ...verdict, text: verdict.accepted ? out.text : priorText, before, after, usage };
}

module.exports = {
  findingKey,
  partitionFindings,
  judgeCorrection,
  assertCorrectorSeesText,
  renderCorrectionRequest,
  correctFindings,
};
