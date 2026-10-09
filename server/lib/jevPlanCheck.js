/**
 * JEV ANSWERS PLAN-CHECK QUESTIONS 10 (heights) AND 17 (whole cast) — 2026-10-09.
 *
 * docs/decisions.md 2026-10-09 "Jev stays an added reviewer; only plan-check Q10 (heights) and Q17 (whole
 * cast) move to Jev". The checker (prompts/plan-check.txt) no longer asks these two; this module asks them,
 * per page of a division, and returns findings in EXACTLY the shape the checker's parsed lines have
 * (`{check, text}`, the text naming its page), so the counters, `replanRank` (17 is must-fix, 10 is noted),
 * `findingPages`, the re-plan section, the convergence guard and the reports read them as they read the
 * checker's. The numbering of the checker's other questions is unchanged.
 *
 * WHAT WAS MEASURED (scripts/analysis/eval-jev-review.js plan-run, eval-jev-replan-guard.js wholecast):
 *   Q10  one noul per page, state = the page's WHO / INSTANT / AFTER fields, the checker's own definition
 *        (TWO_HEIGHTS_DEF). AUC 0.849 against the checker's findings on 505 pages. Flagged at 0.7: 23 pages of
 *        505 (the checker filed 42). The 8 lowest-scored pages the checker filed (Jev below 0.5), read for
 *        this wiring, were all two-level pages, which the rule allows. At 0.5 Jev flags 108 pages (21%) —
 *        too many for a finding that, once filed, sends the book through a re-plan round.
 *   Q17  the PAIRED form: the planner's own WHOLE_CAST_DEF as a statement and its inverse, the score being
 *        the fault probability ((1 - P(shared)) + P(fault)) / 2. AUC 0.95 against reading labels, 23/25 faults
 *        found at 0.5 (5 false flags in 56 lines) and 16/16 precision at 0.7 (recall 16/25). Asked only of a
 *        page whose checker ROSTER holds every commissioned name, exactly as measured; the roster arrives with
 *        the checker's reply, so the questions are asked of every page while the checker runs and the gate is
 *        applied when it returns (no added wall clock).
 *
 * THE ONE CHOICE THE OWNER MAY REVERSE: JEV_PLAN_CHECK.wholeCast.at is 0.5 (the checker's own recall on its
 * own lines, 10/10 with 1 false flag), the precision-first alternative is 0.7; heights.at is 0.7.
 *
 * OUTAGES: the calls go through jevDecisions.runJevRequests, so a failing call waits and retries for
 * JEV_OUTAGE.waitMs and then throws JevDecisionError. beatsPipeline.createPlanCheckRunner handles that as every
 * Jev step does (jevFallBack with a jevReport, a loud throw without one). There is NO fallback to asking the LLM
 * checker these two questions: a story on the backup path files no Q10 / Q17 finding, and says so at error level.
 *
 * The generator side is unchanged: story-beats.txt carries the same two rules from the same constants
 * (TWO_HEIGHTS_DEF, WHOLE_CAST_DEF), and these questions quote those constants too.
 */

const J = require('./jevAudit');
const jev = require('./jevDecisions');
const PB = require('./promptBuilders');
const { log } = require('../utils/logger');

/** The checks Jev answers. The checker is not asked them, and a line it files under them anyway is dropped. */
const HEIGHTS_CHECK = 10;
const WHOLE_CAST_CHECK = 17;
const JEV_PLAN_CHECKS = new Set([HEIGHTS_CHECK, WHOLE_CAST_CHECK]);

/** Flag levels (see the header). */
const JEV_PLAN_CHECK = {
  heights: { check: HEIGHTS_CHECK, at: 0.7 },
  wholeCast: { check: WHOLE_CAST_CHECK, at: 0.5 },
};

// The measured wordings. Q10 is eval-jev-review.js `planRequests` (variant H) verbatim; Q17 is the paired form of
// eval-jev-replan-guard.js `requests` (`shared` and `fault`), which typedPlan.js reads too.
const HEIGHTS_QUESTION = `In the instant, people, animals or objects stand at three or more different heights. ${PB.TWO_HEIGHTS_DEF}`;
const WHOLE_CAST_VIRTUE = `The instant gives every character in frame one and the same action, by this rule: ${PB.WHOLE_CAST_DEF}`;
const WHOLE_CAST_FAULT = 'In the instant, the characters in frame only stand, gather or are shown together, or one of them acts while the others look on or do something else.';

/** Fields 1-3 of a plan line (field 0 is the shot or its placeholder); null when the line does not carry four. */
function pageFields(planLine) {
  const parts = jev.planParts(planLine);
  if (parts.length < 4) return null;
  return { who: parts[1], instant: parts.slice(2, parts.length - 1).join(' — '), after: parts[parts.length - 1] };
}

/** Q10's state: the page's three fields, labelled (eval-jev-review.js `stateOf`). */
const heightsState = f => `WHO IS IN FRAME: ${f.who}\nTHE INSTANT THE PICTURE SHOWS: ${f.instant}\nWHAT IS TRUE AFTER THIS PAGE: ${f.after}`;

/**
 * Ask Jev Q10 and Q17 of every page of a division. Pure scores, no thresholds.
 *
 * @param {Object} input
 * @param {Array<{pageNumber:number, planLine:string}>} input.pages the division, as the checker is given it
 * @param {string[]} input.commissionedNames the characters Q17 is about (fewer than two: Q17 is not asked)
 * @param {Function} [input.callImpl]
 * @returns {Promise<{heights: Map<number,number>, whole: Map<number,number>, skipped: number[], stats: Object}>}
 * @throws {JevDecisionError} a call still failing after the outage wait
 */
async function askPlanCheckJev({ pages, commissionedNames = [], callImpl } = {}) {
  const stats = jev.newStats();
  const askWhole = commissionedNames.filter(Boolean).length > 1;
  const skipped = [];
  const reqs = [];
  const asked = [];
  for (const p of pages || []) {
    const n = Number(p.pageNumber);
    const f = pageFields(p.planLine);
    if (!f) { skipped.push(n); continue; }
    reqs.push({ key: `plancheck:p${n}:H`, state: heightsState(f), questions: { Q: { type: 'noul', instructions: HEIGHTS_QUESTION } } });
    if (askWhole) {
      const state = jev.localLineState(p.planLine);
      reqs.push({ key: `plancheck:p${n}:WV`, state, questions: { Q: { type: 'noul', instructions: WHOLE_CAST_VIRTUE } } });
      reqs.push({ key: `plancheck:p${n}:WF`, state, questions: { Q: { type: 'noul', instructions: WHOLE_CAST_FAULT } } });
    }
    asked.push(n);
  }
  if (skipped.length) log.warn(`⚠️ [JEV/plan-check] page(s) ${skipped.join(', ')} carry fewer than four fields — Q10 and Q17 were not asked of them`);
  const ans = await jev.runJevRequests(reqs, { callImpl, usageLabel: 'jev_plan_check', stats });
  const p = (n, side) => J.yesProb(ans.get(`plancheck:p${n}:${side}`)[0].Q);
  const heights = new Map();
  const whole = new Map();
  for (const n of asked) {
    heights.set(n, +p(n, 'H').toFixed(3));
    if (askWhole) whole.set(n, jev.faultScore(p(n, 'WV'), p(n, 'WF')));
  }
  return { heights, whole, skipped, stats: jev.summarise(stats) };
}

/** Does this ROSTER entry hold every commissioned name, under people or covers (Q17's own gate)? */
function holdsWholeCast(entry, commissionedNames) {
  const want = commissionedNames.map(n => String(n || '').trim().toLowerCase()).filter(Boolean);
  if (want.length < 2 || !entry) return false;
  const inFrame = new Set([...(entry.people || []), ...(entry.covers || [])].map(x => String(x).trim().toLowerCase()));
  return want.every(w => inFrame.has(w));
}

/**
 * Apply the measured levels. The findings are the checker's shape (`{check, text}`; the text names its page);
 * the score rides in `jev` for the report and never in the line the re-planner reads.
 *
 * @param {{scores:{heights:Map, whole:Map}, roster:Map|null, commissionedNames:string[]}} input
 * @returns {{findings: Array<{check:number, text:string, jev:{score:number}}>}}
 */
function planCheckJevFindings({ scores, roster, commissionedNames = [] }) {
  const findings = [];
  for (const [n, v] of scores.heights) {
    if (v >= JEV_PLAN_CHECK.heights.at) {
      findings.push({ check: HEIGHTS_CHECK, text: `Page ${n}: the instant puts figures at three or more different heights in one frame. ${PB.TWO_HEIGHTS_REMEDY}`, jev: { score: v } });
    }
  }
  for (const [n, v] of scores.whole) {
    if (v < JEV_PLAN_CHECK.wholeCast.at) continue;
    // Q17 is about a page that gathers the whole cast; without the checker's roster there is no such page to name.
    if (!roster || !holdsWholeCast(roster.get(n), commissionedNames)) continue;
    findings.push({ check: WHOLE_CAST_CHECK, text: `Page ${n}: the page holds every commissioned character and its instant does not give all of them one shared action.`, jev: { score: v } });
  }
  findings.sort((a, b) => a.check - b.check || PB.findingPages(a)[0] - PB.findingPages(b)[0]);
  return { findings };
}

module.exports = {
  JEV_PLAN_CHECK,
  JEV_PLAN_CHECKS,
  HEIGHTS_QUESTION,
  WHOLE_CAST_VIRTUE,
  WHOLE_CAST_FAULT,
  pageFields,
  askPlanCheckJev,
  holdsWholeCast,
  planCheckJevFindings,
};
