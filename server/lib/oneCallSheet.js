'use strict';

/**
 * The trial's avatar sheet: ONE Grok call (character2x4Sheet.generateOneCallSheet, Standard tier, drawn straight in the story's
 * art style), judged as a whole by the sheet defect judge (avatarSheetJudge, with the photo), and on any defect ONE redo of the same
 * call with the judge's defect types and cells fed back, judged again. The better of the two ships (fewer failed types, then fewer
 * flagged cells; a tie keeps the first).
 *
 * Never shipped unchecked, except when the judge itself cannot answer: an API error is logged as an error and the first sheet
 * ships (the 2026-09-11 sheet/cell gates are fail-open on a check that errors, docs/decisions.md "Visual Bible element cells", and
 * the pass-2 style judge of this sheet already behaves so). A redo whose Grok call fails ships the first sheet, flagged in the log.
 *
 * docs/decisions.md 2026-10-10 "one-call sheets in the trial". The full-story sheet keeps the row chain (generateCharacter2x4Sheet).
 */

const { log } = require('../utils/logger');
const { MODEL_DEFAULTS } = require('../config/models');

function countMetric(name) {
  try {
    const metrics = require('./runMetrics').forJob(require('./runMetrics').ambientJobId());
    metrics.count(name);
  } catch { /* metrics are never fatal */ }
}

/**
 * @param {object} character      the sheet character (name, age, gender, photos, avatars)
 * @param {object} opts
 * @param {string} opts.artStyle
 * @param {string} [opts.costumeDescription]  'standard outfit' for the everyday sheet
 * @param {string} [opts.costumeName]
 * @param {object} [opts.seasonOutfit]        everyday sheet only; a costume is the outfit
 * @param {'standard'|'costume'} opts.kind    which judge rules apply (headgear belongs on a costume sheet)
 * @param {Function} [opts.usageTracker]
 * @param {object} [deps]  test seams: { generate, judge }
 * @returns {Promise<object>} the generateCharacter2x4Sheet result shape convertAvatarToStyle reads, plus `sheetJudge`
 */
async function generateJudgedOneCallSheet(character, { artStyle, costumeDescription = 'standard outfit', costumeName = null, seasonOutfit = null, kind, usageTracker = null }, deps = {}) {
  const sheet = require('./character2x4Sheet');
  const judgeMod = require('./avatarSheetJudge');
  const generate = deps.generate || sheet.generateOneCallSheet;
  const judge = deps.judge || judgeMod.judgeAvatarSheet;
  const facePhoto = await sheet.resolveFacePhoto(character);
  if (!facePhoto) throw new Error(`No face photo for ${character?.name || 'character'}.`);
  const name = character?.name || 'character';
  const startedAt = Date.now();
  const gen = { artStyle, costumeDescription, costumeName, seasonOutfit: kind === 'costume' ? null : seasonOutfit, usageTracker };
  const judgeSheet = async (imageData, label) => {
    const t0 = Date.now();
    try {
      const r = await judge({ sheet: imageData, photo: facePhoto, kind, model: MODEL_DEFAULTS.sheetEvalModel, usageTracker });
      return { defects: judgeMod.sheetDefects(r.parsed), parsed: r.parsed, ms: Date.now() - t0 };
    } catch (err) {
      log.error(`❌ [ONE-CALL SHEET] ${name} ${label} sheet judge FAILED (${err.message}) — shipping the first sheet unchecked`);
      countMetric('avatar_sheet_oneCall_judge_failed');
      return { error: err.message, ms: Date.now() - t0 };
    }
  };

  const attempts = [];
  const first = await generate(character, gen);
  attempts.push({ attempt: 1, ms: Date.now() - startedAt });
  const j1 = await judgeSheet(first.imageData, 'first');
  const record = { judged: !j1.error, redone: false, shipped: 'first', firstDefects: j1.defects || null, secondDefects: null, judgeError: j1.error || null, judgeMs: j1.ms };
  const done = (shipped) => ({
    imageData: shipped.imageData,
    realisticImageData: null,
    usage: first.usage,
    prompt: shipped.prompt,
    refs: { phantom: null, standardAvatar: null, facePhoto },
    passes: null,
    attemptHistory: attempts,
    finalScore: null,
    styleJudgeRejected: false,
    styleJudgeReasons: [],
    sheetJudge: { ...record, totalMs: Date.now() - startedAt },
  });

  if (j1.error || j1.defects.length === 0) {
    if (!j1.error) log.info(`✅ [ONE-CALL SHEET] ${name}/${kind} judged clean in ${Math.round((Date.now() - startedAt) / 1000)}s`);
    return done(first);
  }

  // One redo: the same call, told which defect types in which cells.
  const feedback = judgeMod.redoFeedback(j1.defects);
  log.warn(`⚠️ [ONE-CALL SHEET] ${name}/${kind} first sheet failed the judge (${j1.defects.map(d => `${d.type}:${d.verdict}[${d.cells}]`).join(', ')}) — one redo with the defects fed back`);
  countMetric('avatar_sheet_oneCall_redo');
  record.redone = true;
  let second;
  try {
    second = await generate(character, { ...gen, redoFeedback: feedback });
  } catch (err) {
    log.error(`❌ [ONE-CALL SHEET] ${name}/${kind} redo failed (${err.message}) — shipping the first sheet, which the judge flagged`);
    countMetric('avatar_sheet_oneCall_shipped_flagged');
    return done(first);
  }
  attempts.push({ attempt: 2, ms: Date.now() - startedAt, feedback });
  const j2 = await judgeSheet(second.imageData, 'second');
  record.secondDefects = j2.defects || null;
  record.judgeError = record.judgeError || j2.error || null;
  if (j2.error) {
    countMetric('avatar_sheet_oneCall_shipped_flagged');
    return done(first); // the judge's failure was logged above; the redo cannot be compared
  }
  const better = judgeMod.betterSheet(j1.defects, j2.defects);
  const shipped = better === 'second' ? second : first;
  const shippedDefects = better === 'second' ? j2.defects : j1.defects;
  record.shipped = better;
  if (shippedDefects.length > 0) {
    log.warn(`⚠️ [ONE-CALL SHEET] ${name}/${kind} shipped the ${better} sheet with defects still flagged: ${shippedDefects.map(d => `${d.type}:${d.verdict}[${d.cells}]`).join(', ')}`);
    countMetric('avatar_sheet_oneCall_shipped_flagged');
  } else {
    log.info(`✅ [ONE-CALL SHEET] ${name}/${kind} the redo is clean (${Math.round((Date.now() - startedAt) / 1000)}s)`);
  }
  return done(better === 'second' ? second : first);
}

module.exports = { generateJudgedOneCallSheet };
