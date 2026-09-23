/**
 * Two severity guards on the image judges' "it is not there" findings.
 *
 * Motivating page: staging job_1790100385959_1nitlympp p12 v0. The quality
 * judge listed a figure on empty ground, read it as a second Max and filed
 * `duplicate_character` CRITICAL; it filed Kiaan's boots and the gilet as
 * missing (MAJOR) — both are drawn. Three false findings took the repair slots
 * and the page's real (semantic) findings were capped out.
 *
 * Both guards change a SEVERITY and nothing else (CLAUDE.md eval rule): the
 * finding stays on the record with its original severity kept beside it. What
 * a finding MEANS is never read from its text — the duplicate cap reads the
 * finding's `type` and the detector's figure count; the second look hands the
 * finding's text to an independent judge that looks at the picture, and reads
 * back only its yes/no/unclear.
 */
const { log } = require('../utils/logger');
const { PROMPT_TEMPLATES, fillTemplate, assertPromptFilled } = require('../services/prompts');

// A finding at or above this severity may take a repair slot and must be
// confirmed first.
const SLOT_SEVERITIES = new Set(['CRITICAL', 'MAJOR']);
// Types whose whole claim is an absence. Any other type claims one when the
// judge sets `absent: true` on it (a worn item missing from a figure is filed
// as `clothing`).
const ABSENCE_TYPES = new Set(['missing_element', 'missing_character', 'accessory_missing']);
const ADVISORY = 'MINOR';

/**
 * duplicate_character is capped to advisory when the detector counted no more
 * people than the page's cast holds: two copies of one character plus the rest
 * of the cast cannot fit in that count unless someone else is missing, which
 * is its own finding. Structured inputs only.
 *
 * @returns {number} how many findings were capped
 */
function capDuplicatesByDetector(issues, { detectedPeopleCount, castPeopleCount } = {}) {
  const det = Number(detectedPeopleCount);
  const cast = Number(castPeopleCount);
  if (detectedPeopleCount == null || castPeopleCount == null || !Number.isFinite(det) || !Number.isFinite(cast)) return 0;
  if (det > cast) return 0;
  let n = 0;
  for (const i of Array.isArray(issues) ? issues : []) {
    if (String(i?.type || '').toLowerCase() !== 'duplicate_character') continue;
    const sev = String(i.severity || '').toUpperCase();
    if (sev === ADVISORY) continue;
    i.severityBeforeCap = sev;
    i.severity = ADVISORY;
    i.severityCappedBy = `detector_count:${det}<=cast:${cast}`;
    n++;
  }
  return n;
}

function isSlotAbsenceClaim(i, presenceMarker) {
  if (!i || typeof i !== 'object') return false;
  if (presenceMarker && i.derivedBy === presenceMarker) return false; // detector arithmetic, already two witnesses
  if (!SLOT_SEVERITIES.has(String(i.severity || '').toUpperCase())) return false;
  return i.absent === true || ABSENCE_TYPES.has(String(i.type || i.subType || '').toLowerCase());
}

function claimLine(i, n) {
  const who = typeof i.character === 'string' && i.character.trim() ? `${i.character.trim()}: ` : '';
  const what = String(i.description || i.problem || i.issue || '').trim();
  return `${n}. ${who}${what}`;
}

/**
 * One independent look at the picture for every CRITICAL/MAJOR absence claim
 * on the page, in one call. The judge sees the image and the claims only —
 * no brief, no references, no other finding. A claim it does not confirm as
 * absent ("yes, it is visible" or "unclear") is capped to advisory; a confirmed
 * absence keeps its severity.
 *
 * A failed call leaves every claim at its severity and says so, loudly, on
 * each finding (`secondLook.error`) and in the log.
 *
 * @param {object} args
 * @param {string} args.imageData  data URI of the judged image
 * @param {Array[]} args.lists     issue arrays to scan (mutated in place)
 * @param {string} [args.presenceMarker] derivedBy value of detector-derived findings
 * @param {Function} args.callJudge async (parts) => { text, usage } — the vision call
 * @param {string} [args.pageLabel]
 * @returns {Promise<{checked:number, capped:number, confirmed:number, error:string|null, usage:object|null}>}
 */
async function secondLookAbsenceClaims({ imageData, lists, presenceMarker = null, callJudge, pageLabel = '' }) {
  const claims = [];
  for (const list of lists) for (const i of (Array.isArray(list) ? list : [])) {
    if (isSlotAbsenceClaim(i, presenceMarker) && !i.secondLook) claims.push(i);
  }
  const out = { checked: claims.length, capped: 0, confirmed: 0, error: null, usage: null };
  if (!claims.length) return out;

  const tpl = PROMPT_TEMPLATES.absenceSecondLook;
  if (!tpl) throw new Error('absenceSecondLook template not loaded');
  const prompt = fillTemplate(tpl, { CLAIMS: claims.map((c, k) => claimLine(c, k + 1)).join('\n') });
  const mime = String(imageData).match(/^data:(image\/\w+);base64,/)?.[1] || 'image/jpeg';
  const parts = [
    { inline_data: { mime_type: mime, data: String(imageData).replace(/^data:image\/\w+;base64,/, '') } },
    { text: prompt },
  ];
  assertPromptFilled(parts, 'secondLookAbsenceClaims');

  let answers;
  try {
    const { text, usage } = await callJudge(parts);
    out.usage = usage || null;
    const s = String(text || '');
    const body = s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1);
    answers = JSON.parse(body).claims;
    if (!Array.isArray(answers)) throw new Error('reply has no claims[]');
  } catch (err) {
    out.error = err.message;
    log.error(`❌ [SECOND-LOOK] ${pageLabel}absence check FAILED (${err.message}) — ${claims.length} claim(s) keep their severity unconfirmed`);
    for (const c of claims) c.secondLook = { error: err.message };
    return out;
  }

  claims.forEach((c, k) => {
    const a = answers.find(x => Number(x?.id) === k + 1) || {};
    const visible = ['yes', 'no', 'unclear'].includes(String(a.visible).toLowerCase()) ? String(a.visible).toLowerCase() : 'unclear';
    c.secondLook = { visible, where: typeof a.where === 'string' ? a.where : '' };
    if (visible === 'no') { out.confirmed++; return; }
    c.severityBeforeCap = String(c.severity).toUpperCase();
    c.severity = ADVISORY;
    c.severityCappedBy = `second_look:${visible}`;
    out.capped++;
  });
  log.info(`🔎 [SECOND-LOOK] ${pageLabel}${claims.length} absence claim(s): ${out.confirmed} confirmed, ${out.capped} capped to advisory`);
  return out;
}

module.exports = { capDuplicatesByDetector, secondLookAbsenceClaims, isSlotAbsenceClaim, ABSENCE_TYPES };
