'use strict';

/**
 * THE BOOK REVIEW — Opus as the single picture reviewer (STAGING ONLY).
 *
 * Owner decision 2026-10-29 (docs/decisions.md, tasks/opus-book-review-2026-10-29.md):
 * with runtime `pageJudgeMode` = 'book_review', every per-page picture judge is
 * OFF (quality, inventory, semantic, absence, identity arbiter, entity
 * consistency, eval consolidation, parent-shared, the re-evals inside repair
 * rounds, the style check). When the pages and covers are done, ONE call of
 * bookAudit.auditStoryBook with MODEL_DEFAULTS.bookReviewModel reads the whole
 * book — every story page plus the front, dedication and back covers, with the
 * page text — and returns the faults AND, per fault, the FIX ROUTE:
 *
 *   TOUCHUP     -> the existing inpaint path (executeInpaintAction)
 *   NEW         -> the existing iterate path (executeIterateAction)
 *   CHAR:<Name> -> the existing char-fix path (executeCharFixAction)
 *
 * The route tag REPLACES decideRepairMethod and its overrides in this mode.
 * Flow (owner D4): review -> repair -> re-review (each repaired page shown with
 * its previous AND new picture, the reviewer names the better one) -> repair
 * once more -> final review. Scores are derived from the reviewer's findings
 * through the existing applyScore, so pick-best and evalImageFp work unchanged.
 *
 * D1: a review that fails is retried ONCE; still failing, nothing is repaired
 * and the book ships, with an error logged and a "book review failed" row in
 * notEvaluated. The old per-page judges are NEVER called as a substitute.
 *
 * This module holds the pure logic and the round orchestration. Every paid
 * action (the review call, the three repair methods, the re-detection) is
 * INJECTED by repairPipeline.js, so the same dispatch the per-page round loop
 * runs (runRepairMethod) is what repairs here.
 */

const { log } = require('../utils/logger');
const { runtime } = require('../config/runtime');
const { FINDING_SOURCES } = require('./findingSources');

/** Is this environment running the book review instead of the per-page judges? */
function bookReviewActive() {
  return runtime('pageJudgeMode') === 'book_review';
}

const SEVERITIES = ['minor', 'moderate', 'major', 'critical', 'catastrophic'];
const sevRank = (s) => Math.max(0, SEVERITIES.indexOf(String(s || '').toLowerCase()));

/** The reviewer's weight as the lower-case severity applyScore reads; an unweighted old line is MAJOR (as the consolidator treats it). */
function severityOf(fault) {
  const s = String(fault?.severity || '').toLowerCase();
  return SEVERITIES.includes(s) ? s : 'major';
}

/** One fault as a deduped issue — the shape applyScore's consolidated path reads. */
function toDedupedIssue(fault) {
  return {
    description: fault.detail || fault.line || '',
    severity: severityOf(fault),
    type: fault.type || null,
    // The named character is the subject of the charge (once per class and subject).
    ...(fault.route?.kind === 'CHAR' ? { character: fault.route.charName } : {}),
    sources: [FINDING_SOURCES.BOOK_REVIEW],
  };
}

/**
 * Which ONE repair method a page gets this round, from its faults' route tags.
 * One method per page per round (as in the per-page loop). Precedence: a page
 * the reviewer wants drawn again (NEW) is redrawn whatever else is wrong with it;
 * else a named character is repaired; else the local touch-up. The faults left
 * out of this round's method stay on the page for the next review.
 *
 * A fault with no route cannot be sent anywhere. It is NOT guessed at (no
 * fallback to the old router): it is reported in `unroutable` and the caller logs it.
 *
 * @param {Array} faults IMG faults of ONE page (bookAudit.parseRoutes entries)
 * @returns {{method:'iterate'|'inpaint'|'char-fix'|null, faults:Array, charName:string|null, issueTypes:string[], unroutable:Array, reason:string}}
 */
function chooseMethod(faults) {
  const routed = (faults || []).filter(f => f && f.route);
  const unroutable = (faults || []).filter(f => f && !f.route);
  if (routed.length === 0) {
    return { method: null, faults: [], charName: null, issueTypes: [], unroutable, reason: 'no routed fault' };
  }
  const fresh = routed.filter(f => f.route.kind === 'NEW');
  if (fresh.length > 0) {
    // A redraw answers every fault on the page, so it is told all of them.
    return { method: 'iterate', faults: routed, charName: null, issueTypes: [], unroutable, reason: `NEW picture (${fresh.length} fault(s) routed NEW)` };
  }
  const chars = routed.filter(f => f.route.kind === 'CHAR');
  if (chars.length > 0) {
    // Worst-weighted named character first; the others wait for the next review.
    const target = [...chars].sort((a, b) => sevRank(severityOf(b)) - sevRank(severityOf(a)))[0].route.charName;
    const mine = chars.filter(f => f.route.charName.toLowerCase() === target.toLowerCase());
    return {
      method: 'char-fix', faults: mine, charName: target,
      issueTypes: [...new Set(mine.map(f => f.type).filter(Boolean))],
      unroutable, reason: `CHAR repair of ${target}`,
    };
  }
  const touch = routed.filter(f => f.route.kind === 'TOUCHUP');
  return { method: 'inpaint', faults: touch, charName: null, issueTypes: [], unroutable, reason: `TOUCHUP (${touch.length} fault(s))` };
}

/** The findings the iterate rewrite and the inpaint editor read, one per fault. */
function buildFixableIssues(faults) {
  return (faults || []).map(f => ({
    description: f.detail,
    // The reviewer's sentence IS the instruction (inpaint sends a lone name-free fix verbatim).
    fix: f.detail,
    type: f.type || null,
    severity: severityOf(f).toUpperCase(),
    ...(f.route?.kind === 'CHAR' ? { character: f.route.charName } : {}),
    sources: [FINDING_SOURCES.BOOK_REVIEW],
  }));
}

/**
 * The plan the inpaint editor executes, built from the reviewer's sentences —
 * no consolidator call. A sentence naming exactly ONE cast / bible figure
 * (castResolver.namesMentioned over the page's repair name map) becomes that
 * figure's per-character fix, so the edit is confined to its box; every other
 * sentence joins the scene fix. The editor strips names from both itself
 * (nameRepairText), so the image model never reads one.
 *
 * @param {Array} faults TOUCHUP faults of one page
 * @param {{names:string[], fallbackByName:Map<string,string>}|null} nameMap repairLogic.buildRepairNameMap
 */
function buildTouchupPlan(faults, nameMap) {
  const { namesMentioned } = require('./castResolver');
  const perChar = [];
  const scene = [];
  for (const f of faults || []) {
    const names = nameMap ? namesMentioned(f.detail, nameMap.names) : [];
    if (names.length === 1) {
      perChar.push({
        characterName: names[0],
        visual_identifier: nameMap.fallbackByName.get(names[0].toLowerCase()) || null,
        fix_instruction: f.detail,
        severity: severityOf(f).toUpperCase(),
        types: f.type ? [f.type] : [],
        issues: [f.detail],
      });
    } else {
      scene.push(f);
    }
  }
  const worst = scene.reduce((w, f) => (sevRank(severityOf(f)) > sevRank(w) ? severityOf(f) : w), 'minor');
  return {
    deduped_issues: (faults || []).map(toDedupedIssue),
    scene_fix: scene.length ? {
      instruction: scene.map(f => f.detail).join(' '),
      severity: worst.toUpperCase(),
      types: [...new Set(scene.map(f => f.type).filter(Boolean))],
      preserve: [],
    } : null,
    per_character_fixes: perChar,
    dropped_issues: [],
    source: FINDING_SOURCES.BOOK_REVIEW,
  };
}

/** Why the per-page judges did not run, as notEvaluated rows (shared vocabulary, server/lib/notEvaluated.js). */
// One row per disabled judge, so a grep over stored stories finds each by name.
const DISABLED_PAGE_JUDGES = Object.freeze([
  'quality', 'inventory', 'semantic', 'absence', 'identity_arbiter',
  'entity_consistency', 'eval_consolidation', 'parent_shared', 'style_check',
]);

function notEvaluatedRows({ reviewFailed = false, reviewFailure = null } = {}) {
  const rows = DISABLED_PAGE_JUDGES.map(dimension => ({
    dimension, reason: 'book_review_mode',
    detail: 'pageJudgeMode is book_review: this per-page judge did not run; the whole-book review judged the pictures (docs/decisions.md 2026-10-29, staging only)',
  }));
  // Owner D3: no character reference pictures go to the review. Never a clean pass.
  rows.push({ dimension: 'likeness', reason: 'no_reference_pictures', detail: 'whether a figure looks like the reference photo or avatar is not checked in book review mode' });
  if (reviewFailed) {
    rows.push({ dimension: 'book_review', reason: 'review_failed', detail: reviewFailure || 'book review failed — not reviewed' });
  }
  return rows;
}

/** The entity-consistency report of a run that did not run it: no findings, and not a clean pass. */
function notRunEntityReport() {
  return {
    timestamp: new Date().toISOString(),
    characters: {},
    objects: {},
    grids: [],
    totalIssues: 0,
    overallConsistent: false,
    notRun: true,
    summary: 'Entity consistency check NOT RUN: pageJudgeMode is book_review (the whole-book review judges the pictures)',
  };
}

/**
 * Stamp a version with the findings of the review that read it, through the
 * ONE scoring path (applyScore). `comparisonLoss`: the re-review named the other
 * picture of this page the better one — charged to the loser as a MAJOR so
 * pick-best follows the reviewer's choice without a second scorer.
 */
function stampVersionFromReview(version, { faults, round, comparisonLoss = false, notEvaluated = [] }) {
  const { applyScore } = require('./scoring');
  const images = require('./images');
  const issues = (faults || []).map(toDedupedIssue);
  if (comparisonLoss) {
    issues.push({
      description: 'The book review judged this picture worse than the other version of the same page.',
      severity: 'major',
      type: 'version_comparison',
      character: 'version_comparison',
      sources: [FINDING_SOURCES.BOOK_REVIEW],
    });
  }
  const plan = { deduped_issues: issues, scene_fix: null, per_character_fixes: [], dropped_issues: [], source: FINDING_SOURCES.BOOK_REVIEW };
  const evaluation = {
    ...(version.evaluation || {}),
    evaluated: true,
    bookReview: true,
    reasoning: `Book review round ${round}: ${(faults || []).length} picture fault(s)${comparisonLoss ? '; judged worse than the other version of this page' : ''}`,
    // The bytes this verdict is about (pickBestVersionIndex refuses a score for other bytes).
    evalImageFp: typeof version.imageData === 'string' && version.imageData.startsWith('data:') ? images.hashImageData(version.imageData) : null,
    bboxDetection: images.detectionForVersion(version),
    notEvaluated,
  };
  version.evaluation = evaluation;
  version.reviewFaults = faults || [];
  version.reviewRound = round;
  version.comparisonLoss = comparisonLoss;
  applyScore(version, { evalResult: evaluation, entityResult: { issues: [], penalty: 0 }, consolidatedPlan: plan, requireConsolidation: true });
  version.score = version.finalScore;
  return version;
}

/** Group a review's IMG faults by page; a fault with no page number belongs to no picture and is returned apart. */
function groupFaultsByPage(imgFaults) {
  const byPage = new Map();
  const pageless = [];
  for (const f of imgFaults || []) {
    if (f.page == null) { pageless.push(f); continue; }
    if (!byPage.has(f.page)) byPage.set(f.page, []);
    byPage.get(f.page).push(f);
  }
  return { byPage, pageless };
}

/**
 * Run the book review rounds. Mutates `pageVersions` (appends repaired versions,
 * stamps scores) exactly as the per-page round loop does.
 *
 * @param {object} d
 * @param {Array} d.rawImages                      the pipeline's page records (covers included)
 * @param {Map<number,Array>} d.pageVersions       page -> versions
 * @param {(versions:Array)=>object} d.selectBestVersion
 * @param {number} d.maxRepairRounds               0 = review only
 * @param {(shown:Map, previous:Map)=>Promise<object|null>} d.reviewBook one auditStoryBook call; null = failed
 * @param {(a:object)=>Promise<object>} d.runRepairMethod  repairPipeline.runRepairMethod
 * @param {(r:object, p:object)=>object} d.buildRoundVersion
 * @param {(r:object, label:string)=>Promise<object>} d.redetect  fresh detection for a repaired image
 * @param {(img:object, version:object)=>object|null} d.nameMapFor repairLogic.buildRepairNameMap for the page
 * @param {(r:object, parent:object)=>void} d.inheritSceneContract
 * @param {(audit:object, round:number)=>object} d.auditRecord  the pipeline's compact round record
 * @param {Function} [d.onProgress]
 * @returns {Promise<{auditRecords:Array, repairRounds:Array, reviewFailed:boolean, reviewFailure:string|null, shownPickMoved:number[]}>}
 */
async function runBookReviewRounds(d) {
  const { applyRoundCap } = require('./repairLogic');
  const { baseRepairMethod, summarizeRepairRound, repairAttemptFromResult } = require('./repairLogic');
  const pLimit = require('p-limit');
  const pagesWithImage = d.rawImages.filter(i => i.imageData);
  const auditRecords = [];
  const repairRounds = [];
  const rowsFor = (extra = {}) => notEvaluatedRows(extra);

  const pickedByPage = () => {
    const out = new Map();
    for (const img of pagesWithImage) {
      const v = d.selectBestVersion(d.pageVersions.get(img.pageNumber) || []);
      if (v?.imageData) out.set(img.pageNumber, v);
    }
    return out;
  };

  // D1: ONE retry, then give up loudly. Never the old judges.
  const reviewWithRetry = async (shown, previous, label) => {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const audit = await d.reviewBook(shown, previous);
      if (audit) return audit;
      log.error(`❌ [BOOK-REVIEW] ${label}: the review call failed (attempt ${attempt} of 2)`);
    }
    return null;
  };

  const applyReview = (audit, round, shown, parentByPage) => {
    const { byPage, pageless } = groupFaultsByPage(audit.byRoute.IMG);
    for (const f of pageless) log.warn(`📖 [BOOK-REVIEW] Round ${round}: a fault carries no page number and belongs to no picture — ${f.line}`);
    for (const page of byPage.keys()) {
      if (!shown.has(page)) log.warn(`📖 [BOOK-REVIEW] Round ${round}: faults name page ${page}, which was not in the book that was read`);
    }
    for (const [page, version] of shown) {
      version.pageNumber = page;
      const faults = byPage.get(page) || [];
      const parent = parentByPage?.get(page) || null;
      if (!parent) {
        stampVersionFromReview(version, { faults, round, notEvaluated: rowsFor() });
        continue;
      }
      // A repaired page: the reviewer saw both pictures and named the better one.
      const verdict = audit.betterVerdicts?.[page] || null;
      if (!verdict) log.warn(`📖 [BOOK-REVIEW] Round ${round} p${page}: no BETTER verdict for a repaired page — the two versions are ranked on their faults alone`);
      stampVersionFromReview(version, { faults, round, comparisonLoss: verdict === 'PREVIOUS', notEvaluated: rowsFor() });
      if (verdict === 'NEW') {
        stampVersionFromReview(parent, { faults: parent.reviewFaults || [], round: parent.reviewRound ?? 0, comparisonLoss: true, notEvaluated: rowsFor() });
      }
      if (verdict === 'PREVIOUS') {
        parent.failedRepairs = [...(parent.failedRepairs || []), { method: baseRepairMethod(version.method || methodOfSource(version.source)), round, error: 'the book review judged the repaired picture worse than this one' }];
      }
    }
  };

  // ── Round 0: the first review, before any repair ───────────────────────
  const shown0 = pickedByPage();
  const first = await reviewWithRetry(shown0, new Map(), 'round 0');
  if (!first) {
    const failure = 'book review failed — not reviewed (2 attempts); the book ships unrepaired';
    log.error(`❌ [BOOK-REVIEW] ${failure}`);
    for (const v of shown0.values()) {
      v.evaluation = { ...(v.evaluation || {}), evaluated: false, bookReview: true, notEvaluated: rowsFor({ reviewFailed: true, reviewFailure: failure }) };
    }
    return { auditRecords, repairRounds, reviewFailed: true, reviewFailure: failure };
  }
  applyReview(first, 0, shown0, null);
  auditRecords.push({ ...d.auditRecord(first, 0), bookReview: true, raw: first.raw });
  log.info(`📖 [BOOK-REVIEW] Round 0: ${first.byRoute.IMG.length} IMG / ${first.byRoute.TEXT.length} TEXT fault(s) over ${first.pagesRead.length} page(s)`);

  // ── Repair rounds ──────────────────────────────────────────────────────
  let reviewFailure = null;
  for (let round = 1; round <= d.maxRepairRounds; round++) {
    const tasks = [];
    const candidates = [];
    for (const img of pagesWithImage) {
      const versions = d.pageVersions.get(img.pageNumber) || [];
      const best = d.selectBestVersion(versions);
      if (!best?.reviewFaults?.length) continue;
      const choice = chooseMethod(best.reviewFaults);
      for (const u of choice.unroutable) {
        log.error(`❌ [BOOK-REVIEW] Round ${round} p${img.pageNumber}: the fault carries no fix route and is NOT repaired (no fallback router) — ${u.line}`);
      }
      if (!choice.method) continue;
      const failedBefore = (best.failedRepairs || []).some(f => f.method === choice.method);
      if (failedBefore) {
        log.warn(`📖 [BOOK-REVIEW] Round ${round} p${img.pageNumber}: ${choice.method} already tried on this very picture and not kept — not repeated`);
        continue;
      }
      candidates.push({ img, best, choice });
    }
    if (candidates.length === 0) { log.info(`📖 [BOOK-REVIEW] Round ${round}: nothing to repair`); break; }

    // The same per-round cap the per-page loop applies (worst first), with the
    // CRITICAL/CATASTROPHIC pages exempt on the last round.
    const score = (c) => (typeof c.best.finalScore === 'number' ? c.best.finalScore : 0);
    const ordered = [...candidates].sort((a, b) => score(a) - score(b));
    const critical = candidates
      .filter(c => c.best.reviewFaults.some(f => ['critical', 'catastrophic'].includes(severityOf(f))))
      .map(c => c.img.pageNumber);
    const capped = applyRoundCap(ordered.map(c => c.img.pageNumber), {
      round, totalPages: pagesWithImage.length, lastRound: round >= d.maxRepairRounds, criticalPageNums: critical,
    });
    const admitted = new Set(capped.admitted);
    for (const c of ordered) if (admitted.has(c.img.pageNumber)) tasks.push(c);
    if (capped.deferred.length) log.info(`📖 [BOOK-REVIEW] Round ${round}: page(s) ${capped.deferred.join(', ')} deferred by the round cap`);

    if (d.onProgress) await d.onProgress(round, tasks.length);
    log.info(`🔄 [BOOK-REVIEW] Round ${round}: ${tasks.length} page(s) — ${tasks.map(t => `p${t.img.pageNumber} ${t.choice.method}`).join(', ')}`);

    const limit = pLimit(50);
    const parentOf = new Map();
    const results = await Promise.all(tasks.map(({ img, best, choice }) => limit(async () => {
      const pageNumber = img.pageNumber;
      parentOf.set(pageNumber, best);
      const failed = (error, extra = {}) => ({ pageNumber, imageData: null, method: choice.method, error, ...extra });
      try {
        let latestEval;
        if (choice.method === 'inpaint') {
          const plan = buildTouchupPlan(choice.faults, d.nameMapFor(img, best));
          latestEval = { fixableIssues: buildFixableIssues(choice.faults), consolidatedPlan: plan, reasoning: 'book review touch-up', pageNumber };
        } else if (choice.method === 'iterate') {
          latestEval = { fixableIssues: buildFixableIssues(choice.faults), consolidatedPlan: null, reasoning: 'book review: draw the picture again', pageNumber };
        } else {
          latestEval = best.evaluation || null;
        }
        const decision = choice.method === 'char-fix'
          ? { charName: choice.charName, issueTypes: choice.issueTypes, severity: choice.faults.map(severityOf).sort((a, b) => sevRank(b) - sevRank(a))[0].toUpperCase() }
          : { reason: choice.reason };
        const result = await d.runRepairMethod({ img, method: choice.method, latestEval, decision, round, recolourInput: null, failed });
        if (result && choice.method === 'inpaint') result.reviewPlan = latestEval.consolidatedPlan;
        return result;
      } catch (err) {
        log.error(`❌ [BOOK-REVIEW] Round ${round} ${choice.method} failed for page ${pageNumber}: ${err.message}`);
        return failed(err.message);
      }
    })));

    const successes = results.filter(r => r && r.imageData);
    for (const r of results.filter(r => r && !r.imageData)) {
      const img = d.rawImages.find(i => i.pageNumber === r.pageNumber);
      const parent = parentOf.get(r.pageNumber);
      if (parent) parent.failedRepairs = [...(parent.failedRepairs || []), { method: baseRepairMethod(r.method), round, error: r.error || 'no result' }];
      if (img) {
        img.retryHistory = img.retryHistory || [];
        img.retryHistory.push({
          attempt: img.retryHistory.length + 1, type: 'round_repair_failed', round, method: r.method || null,
          error: r.error || 'no result',
          ...(r.attemptFrames?.length ? { character: r.charName || null, attemptFrames: r.attemptFrames } : {}),
          timestamp: new Date().toISOString(),
        });
      }
    }
    log.info(`✅ [BOOK-REVIEW] Round ${round}: ${successes.length}/${tasks.length} repaired`);

    const beforeScores = {};
    for (const t of tasks) beforeScores[t.img.pageNumber] = typeof t.best.finalScore === 'number' ? t.best.finalScore : null;

    if (successes.length === 0) {
      // The book is byte-identical to the one just reviewed; a second read buys the same findings.
      repairRounds.push(summarizeRepairRound({ round, attempts: results.filter(Boolean).map(repairAttemptFromResult), beforeScores, afterScores: {}, criticalCleared: {} }));
      break;
    }

    for (const r of successes) d.inheritSceneContract(r, parentOf.get(r.pageNumber) || null);
    // A fresh detection on the new bytes (the iterate result carries its own).
    const detectLimit = pLimit(8);
    await Promise.all(successes.filter(r => !r.bboxDetection).map(r => detectLimit(async () => {
      try { r.bboxDetection = await d.redetect(r, `r${round}`); } catch (err) {
        log.warn(`⚠️ [BOOK-REVIEW] Round ${round} P${r.pageNumber}: detection failed (${err.message}) — a character repair on this version will have no box`);
        r.bboxDetection = null;
      }
    })));

    const shown = pickedByPage();
    const previous = new Map();
    const newVersions = new Map();
    for (const r of successes) {
      const parent = parentOf.get(r.pageNumber);
      const plan = r.reviewPlan || null;
      const v = d.buildRoundVersion(r, {
        score: null,
        evaluation: { evaluated: false, bookReview: true, bboxDetection: r.bboxDetection || null },
        entityIssues: [],
        repairPlan: plan ? JSON.parse(JSON.stringify(plan)) : null,
      });
      v.pageNumber = r.pageNumber;
      d.pageVersions.get(r.pageNumber).push(v);
      shown.set(r.pageNumber, v);
      previous.set(r.pageNumber, parent);
      newVersions.set(r.pageNumber, v);
    }

    const audit = await reviewWithRetry(shown, previous, `re-review after round ${round}`);
    if (!audit) {
      reviewFailure = `book review failed after repair round ${round} — the repaired picture(s) were not reviewed; the previous version(s) ship`;
      log.error(`❌ [BOOK-REVIEW] ${reviewFailure}`);
      for (const v of newVersions.values()) {
        v.evaluation = { ...v.evaluation, evaluated: false, notEvaluated: rowsFor({ reviewFailed: true, reviewFailure }) };
      }
      for (const v of shown.values()) v.evaluation = { ...(v.evaluation || {}), notEvaluated: rowsFor({ reviewFailed: true, reviewFailure }) };
      break;
    }
    applyReview(audit, round, shown, previous);
    const afterScores = {};
    const criticalCleared = {};
    const { dominatesByCritical } = require('./scoring');
    for (const [page, v] of newVersions) {
      afterScores[page] = typeof v.finalScore === 'number' ? v.finalScore : null;
      const before = parentOf.get(page);
      if (before && dominatesByCritical(v, before)) criticalCleared[page] = true;
    }
    repairRounds.push(summarizeRepairRound({ round, attempts: results.filter(Boolean).map(repairAttemptFromResult), beforeScores, afterScores, criticalCleared }));
    auditRecords.push({ ...d.auditRecord(audit, round), bookReview: true, raw: audit.raw, repairedPages: [...newVersions.keys()], betterVerdicts: audit.betterVerdicts || {} });
    log.info(`📖 [BOOK-REVIEW] Re-review after round ${round}: ${audit.byRoute.IMG.length} IMG fault(s); verdicts ${JSON.stringify(audit.betterVerdicts || {})}`);
  }

  if (auditRecords.length) auditRecords[auditRecords.length - 1].finalRound = true;
  return { auditRecords, repairRounds, reviewFailed: false, reviewFailure };
}

/** 'inpaint-round-2' -> 'inpaint' (a version's source names the method that made it). */
function methodOfSource(source) {
  const s = String(source || '');
  if (s.startsWith('composite-iterate') || s.startsWith('iterate')) return 'iterate';
  if (s.startsWith('inpaint')) return 'inpaint';
  if (s.startsWith('char-fix')) return 'char-fix';
  return s;
}

module.exports = {
  bookReviewActive,
  chooseMethod,
  buildFixableIssues,
  buildTouchupPlan,
  toDedupedIssue,
  severityOf,
  notEvaluatedRows,
  DISABLED_PAGE_JUDGES,
  notRunEntityReport,
  stampVersionFromReview,
  groupFaultsByPage,
  runBookReviewRounds,
  methodOfSource,
};
