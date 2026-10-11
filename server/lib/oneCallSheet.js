'use strict';

/**
 * THE avatar sheet of every path (standard and costume, trial and full story): ONE Grok 2.0 call (character2x4Sheet.generateOneCallSheet,
 * photo -> styled 2x4), then ONE sheet judge (avatarSheetJudge: bald or headless cell, held object, broken layout, a tail costume
 * standing without a fin), and on a flag ONE redo of the same call with the defect fed back, judged again. The better of the two ships
 * (fewer failed types, then fewer flagged cells; a tie keeps the first).
 *
 * A judge that cannot answer (API error) ships the first sheet and logs an ERROR (docs/decisions.md 2026-09-11 "Visual Bible element
 * cells": a check that errors keeps the sheet). A flagged sheet never ships without its redo; a sheet still flagged after the redo ships
 * and logs an ERROR (gates are guidelines).
 *
 * EVERY run is recorded (`sheetCheck` on the styled-avatar log entry, which is stored with the story, plus runMetrics counters
 * `avatar_sheet_check_*`), so the check can be counted after 50 sheets and removed if it never earned its call
 * (tasks/verify.json avatar-sheet-check-usefulness-50-runs; scripts/admin/avatar-sheet-check-report.js).
 *
 * docs/decisions.md 2026-10-10 "avatar sheets are ONE Grok 2 call" (replaces the two-call 2026-08-09 rule).
 */

const { log } = require('../utils/logger');
const { MODEL_DEFAULTS } = require('../config/models');

function countMetric(name) {
  try {
    const runMetrics = require('./runMetrics');
    runMetrics.forJob(runMetrics.ambientJobId()).count(name);
  } catch { /* metrics are never fatal */ }
}

// One fixed correction line per judge word, written here, never read from the judge's prose. The redo is told what to fix and in which cells.
function redoLinesOf(defects) {
  const { SHEET_EMPTY_HANDS_RULE, SHEET_NO_LETTERING_RULE, TAIL_POSE_RULE } = require('./character2x4Sheet');
  const lines = {
    bald: () => 'Every cell shows a complete head with the same hair: no bald scalp, no blank, missing or cut-off face.',
    held: () => SHEET_EMPTY_HANDS_RULE,
    tail: () => `${TAIL_POSE_RULE} The tail ends in a visible tail tip or fin in every full-body cell.`,
    layout: (word) => ({
      not_a_grid: 'The output is exactly one 2×4 grid: two rows of four cells, one figure per cell.',
      extra_figures: 'Only the one person appears, once per cell: no second person, ghost figure or part of another person.',
      lettering: SHEET_NO_LETTERING_RULE,
      not_illustrated: 'Every cell is a painted illustration, not a photograph or a cut-out.',
    }[word]),
  };
  return defects.map(({ type, word, cells }) => {
    const rule = lines[type] && lines[type](word);
    if (!rule) throw new Error(`oneCallSheet: no correction line for ${type}/${word}`);
    return `${type}: ${rule}${cells.length ? ` Seen in cell${cells.length > 1 ? 's' : ''} ${cells.join(', ')}.` : ''}`;
  });
}

/**
 * @param {object} character      the sheet character (name, age, gender, photos)
 * @param {object} opts
 * @param {string} opts.artStyle
 * @param {'standard'|'costume'} opts.kind
 * @param {string} [opts.costumeDescription]  'standard outfit' for the everyday sheet
 * @param {string} [opts.costumeName]
 * @param {object} [opts.seasonOutfit]        everyday sheet only; a costume is the outfit
 * @param {Function} [opts.usageTracker]
 * @param {object} [deps]  test seams: { generate, judge }
 * @returns {Promise<{ imageData, usage, prompt, refs, sheetCheck }>}
 */
async function generateJudgedOneCallSheet(character, { artStyle, kind, costumeDescription = 'standard outfit', costumeName = null, seasonOutfit = null, usageTracker = null }, deps = {}) {
  const sheet = require('./character2x4Sheet');
  const judgeMod = require('./avatarSheetJudge');
  const generate = deps.generate || sheet.generateOneCallSheet;
  const judge = deps.judge || judgeMod.judgeAvatarSheet;
  const name = character?.name || 'character';
  const startedAt = Date.now();
  const gen = { artStyle, kind, costumeDescription, costumeName, seasonOutfit: kind === 'costume' ? null : seasonOutfit, usageTracker };
  const judgeSheet = async (imageData, label) => {
    const t0 = Date.now();
    try {
      const r = await judge({ sheet: imageData, kind, model: MODEL_DEFAULTS.sheetEvalModel, usageTracker });
      return { defects: judgeMod.sheetDefects(r.parsed), ms: Date.now() - t0 };
    } catch (err) {
      log.error(`❌ [AVATAR SHEET] ${name}/${kind} ${label} sheet judge FAILED (${err.message}) — shipping the ${label} sheet unchecked`);
      countMetric('avatar_sheet_check_judge_error');
      return { error: err.message, ms: Date.now() - t0 };
    }
  };

  const first = await generate(character, gen);
  countMetric('avatar_sheet_check_ran');
  const j1 = await judgeSheet(first.imageData, 'first');
  const check = {
    kind, model: first.modelId || null, judged: !j1.error, judgeError: j1.error || null, judgeMs: j1.ms,
    firstFlags: j1.defects || null, redone: false, secondFlags: null, redoError: null, shipped: 'first', totalMs: 0,
  };
  const done = (shipped) => {
    check.totalMs = Date.now() - startedAt;
    return {
      imageData: shipped.imageData,
      usage: first.usage,
      prompt: shipped.prompt,
      refs: { phantom: null, standardAvatar: null, facePhoto: null },
      sheetCheck: check,
    };
  };

  if (j1.error) return done(first);
  if (j1.defects.length === 0) {
    log.info(`✅ [AVATAR SHEET] ${name}/${kind} judged clean in ${Math.round((Date.now() - startedAt) / 1000)}s`);
    return done(first);
  }

  countMetric('avatar_sheet_check_flagged');
  for (const d of j1.defects) countMetric(`avatar_sheet_check_flag_${d.type}`);
  // One redo: the same call, told which defect types in which cells.
  log.warn(`⚠️ [AVATAR SHEET] ${name}/${kind} first sheet flagged (${j1.defects.map(d => `${d.type}:${d.word}[${d.cells}]`).join(', ')}) — one redo with the defects fed back`);
  check.redone = true;
  countMetric('avatar_sheet_check_redo');
  let second;
  try {
    second = await generate(character, { ...gen, redoLines: redoLinesOf(j1.defects) });
  } catch (err) {
    check.redoError = err.message;
    log.error(`❌ [AVATAR SHEET] ${name}/${kind} redo failed (${err.message}) — shipping the first sheet, which the judge flagged`);
    countMetric('avatar_sheet_check_shipped_flagged');
    return done(first);
  }
  const j2 = await judgeSheet(second.imageData, 'redo');
  check.secondFlags = j2.defects || null;
  if (j2.error) {
    check.judgeError = j2.error;
    countMetric('avatar_sheet_check_shipped_flagged');
    return done(first); // the redo cannot be compared; the first sheet is the one the judge flagged
  }
  const firstCandidate = { defects: j1.defects, sheet: first };
  const better = judgeMod.betterSheet(firstCandidate, { defects: j2.defects, sheet: second });
  const shipsSecond = better.sheet === second;
  check.shipped = shipsSecond ? 'second' : 'first';
  const shippedFlags = shipsSecond ? j2.defects : j1.defects;
  if (shipsSecond) countMetric('avatar_sheet_check_redo_shipped');
  if (shippedFlags.length > 0) {
    log.error(`❌ [AVATAR SHEET] ${name}/${kind} SHIPPED FLAGGED after the redo (${check.shipped} sheet): ${shippedFlags.map(d => `${d.type}:${d.word}[${d.cells}]`).join(', ')}`);
    countMetric('avatar_sheet_check_shipped_flagged');
  } else {
    log.info(`✅ [AVATAR SHEET] ${name}/${kind} the redo is clean (${Math.round((Date.now() - startedAt) / 1000)}s)`);
  }
  return done(shipsSecond ? second : first);
}

module.exports = { generateJudgedOneCallSheet, redoLinesOf };
