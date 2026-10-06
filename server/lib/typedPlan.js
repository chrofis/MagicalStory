/**
 * THE TYPED PAGE PLAN — Lab experiment, 2026-10-05 (production unchanged).
 * docs/decisions.md "Typed page plan: measured, not adopted" carries the verdict;
 * tasks/typed-plan-2026-10-05.md the design.
 *
 * Every plan line names a picture TYPE (shotVocabulary.PLAN_TYPES) before who
 * is in frame; the book's targets are given to the planner up front and
 * counted in code (planCounters.typedPlanCounters / countPlanTargets); Jev
 * judges each page with ONE question per call; Jev picks the camera shot
 * inside the type; ONE targeted re-plan answers the pages that failed.
 *
 * The same measurement (`measurePlan`) reads the stored plan, today's plan and
 * the typed plan, so the three arms are counted by one function.
 *
 * Reuses, never copies: castCoverage (targets), planCounters (counting),
 * jevDecisions (call pool, shot assignment, withShot), planGuards (the re-plan
 * merge / duplicate / page-count guards), promptBuilders (the planner template
 * and the one-moment definitions the questions quote).
 */

const J = require('./jevAudit');
const SV = require('./shotVocabulary');
const jev = require('./jevDecisions');
const PB = require('./promptBuilders');
const { typedPlanCounters, countPlanTargets, parseTypedLine, parseTypedWho, whoClassOf, deriveRowType, classifyShot } = require('./planCounters');
const { mergeReplanPages, duplicatePlanLine, pageCountHolds } = require('./planGuards');
const { typedPlanTargets } = require('./castCoverage');
const { castTableBlock } = require('./castCoverage');

// ───────────────────────── the per-page Jev questions ─────────────────────────
//
// One noul per Jev call (owner, 2026-10-05), in the paired form below. `fix` is
// the repair instruction the targeted re-plan is given; which question may flag
// a page, and at what score, is CALIBRATION (measured, below).

/** The neutral midpoint: used only for a metric's "below" count, never as a flag threshold. */
const THRESHOLD = 0.5;

const PLAN_LINE_HEAD = 'A picture plan line (who is in frame — the moment the picture shows — what is true after):';

/** The plan line without field 0 (the type or the shot): the question never sees what it may choose. */
const bareLine = planLine => jev.planParts(planLine).slice(1).join(' — ');

const localState = planLine => `${PLAN_LINE_HEAD}\n${bareLine(planLine)}`;

// Every question is asked in the PAIRED form (owner 2026-10-06, as WHOLE was
// measured): a `virtue` statement and its inverse `fault`, one noul each, and
// the score is the FAULT probability, ((1 - P(virtue)) + P(fault)) / 2, so a
// model that says yes to both is pulled to 0.5 instead of agreeing with
// itself. `scores[id]` everywhere is that fault probability; a page is
// flagged when it is at or above the question's calibrated threshold.

const PLAN_QUESTIONS = {
  SIMPLE: {
    virtue: 'The moment of this plan line is simple to illustrate as one picture: one action, in one place.',
    fault: 'The moment of this plan line is complicated to illustrate as one picture: it holds more than one action, or more than one place.',
    applies: () => true,
    fix: 'Reduce the moment to one action in one place that a single picture can hold.',
  },
  ACTION: {
    virtue: 'The moment is an action being performed by a character, with a verb that moves.',
    fault: 'The moment is only a presence, a position or the state after an action (stands, together, visible, gathered, waits).',
    applies: r => r.names.length > 0,
    fix: 'Name the action being performed, not a presence, a position or the state after an action.',
  },
  DEED: {
    virtue: 'The moment is one action, being performed now. Its effect, and where the effect goes, are not in it.',
    fault: `The moment shows an action and the result of that action together. ${PB.DEED_AND_EFFECT_DEF}`,
    applies: () => true,
    fix: 'Keep the action in the moment and move its result to the last field.',
  },
  HEIGHTS: {
    virtue: 'The figures of the moment stand on at most two height levels in one frame.',
    fault: `The moment puts ${PB.TWO_HEIGHTS_DEF}`,
    applies: r => r.names.length >= 2,
    fix: 'Keep at most two height levels in the frame: stage it on the two levels the event happens on, with the figure on the third level out of the frame (and out of the who column).',
  },
  FELT: {
    virtue: 'The moment is one character showing a strong feeling, and nothing else happens in it: no second actor, no event.',
    fault: 'The moment is not one character alone showing a feeling: a second actor or an event is in it.',
    applies: r => r.type === 'face',
    fix: 'Make this one character alone showing one strong feeling, with nothing else happening.',
  },
  THIRD: {
    virtue: 'The moment gives each of the three characters something of their own that the picture cannot show without them.',
    fault: 'In the moment one of the three characters only repeats the action, names the place or is asserted to be needed; the picture shows nothing of their own.',
    applies: r => r.names.length === 3,
    fix: 'Give the third character an action of their own that the page cannot show without them, or take them out of the page.',
  },
  OBSTACLE: {
    virtue: 'In the moment nothing works against a character, or whatever does is held by a character this plan line names in its who column.',
    fault: 'In the moment something works against what a character is doing — a way blocked, a place kept, a thing taken or withheld, a refusal — and the one holding that obstacle is a character this plan line does not name in its who column.',
    applies: r => r.names.length > 0,
    fix: 'Name the one who holds the obstacle in the who column (keeping the type\'s figure count), or change the moment.',
  },
  WEIGHT: {
    virtue: 'The picture of the page to judge shows something the story has been driving toward: a discovery, an arrival, a payoff.',
    fault: 'The picture of the page to judge shows a place or thing the story has not been driving toward: it carries no story weight.',
    applies: r => r.names.length === 0, arcState: true,
    fix: 'Give this people-free page a subject the story has been driving toward, or give the page a character.',
  },
  // Q17, as measured: the planner's own definition plus its inverse (eval-jev-replan-guard.js, `wholecast`).
  WHOLE: {
    virtue: `The moment gives every character in frame one and the same action, by this rule: ${PB.WHOLE_CAST_DEF}`,
    fault: 'In the moment, the characters in frame only stand, gather or are shown together, or one of them acts while the others look on or do something else.',
    applies: (r, ctx) => ctx.listed.length > 1 && ctx.listed.every(n => r.names.some(x => String(x).toLowerCase() === String(n).toLowerCase())),
    fix: 'Give every character of the cast in frame one shared action, or take some of them out of the page.',
  },
};

/**
 * Which questions flag a page, and where. `at` is the fault-probability
 * threshold (precision >= 0.7 on the calibration set), `noise` the margin a
 * score must clear to count as a CHANGE between two readings (the flip rate of
 * the same question asked twice). A question that is not here — or whose
 * entry has `calibrated: false` — is SCORED and recorded but never flags a
 * page, never sends one back and never counts as a break: an uncalibrated
 * question is a number, not a finding (docs/decisions.md 2026-10-06 "Typed
 * plan: Jev calibration"; evals/results/results.jsonl, dataset typed-plan-jev-v1).
 */
const CALIBRATION = {};

const faultScore = (pVirtue, pFault) => +(((1 - pVirtue) + pFault) / 2).toFixed(3);

/** The ids a page's scores flag under a calibration. */
const flagsOf = (scores, calibration) => Object.entries(scores)
  .filter(([id, v]) => calibration[id] && calibration[id].calibrated && v >= calibration[id].at).map(([id]) => id);

const flaggedOf = pages => {
  const out = {};
  for (const [n, o] of Object.entries(pages)) for (const id of o.flags) (out[id] = out[id] || []).push(Number(n));
  return out;
};

/**
 * Jev, per page, one noul per call (two per question: the paired form).
 *
 * @param {Object} input
 * @param {string} input.arc
 * @param {Array<{pageNumber:number, planLine:string}>} input.pages the whole plan (the arc state of WEIGHT shows it)
 * @param {Array<{pageNumber:number, type:string, names:string[]}>} input.rows
 * @param {string[]} input.listed the commission's character list (WHOLE applies where all are in frame)
 * @param {number[]} [input.only] judge only these pages
 * @param {string[]} [input.questions] ask only these question ids (default: all)
 * @param {{calibration?:Object}} [opts]
 * @returns {Promise<{pages: Object<number,{scores:Object, flags:string[]}>, flagged: Object<string,number[]>, stats:Object}>}
 */
async function judgePlanPages({ arc, pages, rows, listed = [], only = null, questions = null }, opts = {}) {
  const { calibration = CALIBRATION, ...jevOpts } = opts;
  const stats = jev.newStats();
  const want = only ? new Set(only.map(Number)) : null;
  const ids = questions || Object.keys(PLAN_QUESTIONS);
  const byNum = new Map(pages.map(p => [Number(p.pageNumber), p]));
  const reqs = [];
  const plan = []; // {page, id}
  for (const r of rows) {
    if (want && !want.has(r.pageNumber)) continue;
    const page = byNum.get(r.pageNumber);
    for (const id of ids) {
      const q = PLAN_QUESTIONS[id];
      if (!q.applies(r, { listed })) continue;
      const state = q.arcState ? jev.pageState(arc, pages, page) : localState(page.planLine);
      for (const [side, text] of [['V', q.virtue], ['F', q.fault]]) {
        reqs.push({ key: `typed:p${r.pageNumber}:${id}:${side}`, state, questions: { Q: { type: 'noul', instructions: text } } });
      }
      plan.push({ page: r.pageNumber, id });
    }
  }
  const ans = reqs.length ? await jev.runJevRequests(reqs, { ...jevOpts, usageLabel: 'jev_typed_plan', stats }) : new Map();
  const out = {};
  for (const r of rows) if (!want || want.has(r.pageNumber)) out[r.pageNumber] = { scores: {}, flags: [] };
  for (const { page, id } of plan) {
    const get = (side) => {
      const a = ans.get(`typed:p${page}:${id}:${side}`);
      if (!a || !a.length) throw new jev.JevDecisionError(`typed plan: no Jev answer for page ${page} ${id}`);
      return J.yesProb(a[0].Q);
    };
    out[page].scores[id] = faultScore(get('V'), get('F'));
  }
  for (const o of Object.values(out)) o.flags = flagsOf(o.scores, calibration);
  return { pages: out, flagged: flaggedOf(out), stats: jev.summarise(stats) };
}

/** The repair sentence of a Jev question id. */
const fixOf = id => PLAN_QUESTIONS[id].fix;

// ───────────────────────── rows: one reading for every arm ─────────────────────────

/**
 * Rows {pageNumber, type, names, shot} of a plan that was NOT written typed
 * (the stored plan, today's plan). ONE reader for every arm (owner 2026-10-06):
 * the who column (field 1) goes through parseTypedWho exactly as a typed line's
 * does, the shot comes from field 0 and the type is derived. The plan check's
 * head count (`present`, luna) is only a CROSS-CHECK: `lunaNames` rides on the
 * row and `crossCheckRows` lists the pages where the two disagree, never used
 * to count anything.
 *
 * @param {Array<{pageNumber:number, planLine:string}>} pages
 * @param {Map<number,string[]>|null} present luna's head count per page
 * @param {{commissionedNames?:string[], arcNames?:string[]}} [who]
 */
function rowsOfUntypedPlan(pages, present, { commissionedNames = [], arcNames = [] } = {}) {
  return pages.map((p) => {
    const n = Number(p.pageNumber);
    const parts = jev.planParts(p.planLine);
    const read = parseTypedWho(parts[1] || '', commissionedNames, arcNames);
    const lunaNames = (present && present.get(n)) || null;
    const shotId = classifyShot(parts[0] || '');
    const shot = shotId === 'other' ? null : shotId;
    return {
      pageNumber: n, type: deriveRowType(read.names.length, shot), names: read.names, shot, planLine: p.planLine,
      unreadable: read.rejected.map(x => x.entry), lunaNames,
    };
  });
}

/** Pages where the code's who-column reading and luna's head count differ (a cross-check, reported never counted). */
function crossCheckRows(rows) {
  return rows.filter(r => r.lunaNames && (r.lunaNames.length !== r.names.length || r.unreadable.length))
    .map(r => ({ page: r.pageNumber, code: r.names, luna: r.lunaNames, unreadable: r.unreadable }));
}

// ───────────────────────── the camera, inside the type ─────────────────────────

/**
 * The shot of every page of a typed plan: Jev scores each ALLOWED shot's fit
 * (shotFitQuestions, the A1 wording; one question per call, a type with a single
 * shot is not asked), code assigns the best allowed shot per page with the
 * consecutive rule (jevDecisions.assign, `quotas: false` — the floors became the
 * planner's targets) and writes field 0.
 *
 * @returns {Promise<{shots:string[], pages:Array, unmet:string[]|null, stats:Object, beats:Array}>}
 */
async function decideTypedShots({ arc, pages, rows }, opts = {}) {
  const stats = jev.newStats();
  const ids = SV.SHOT_TYPES;
  const questions = jev.shotFitQuestions();
  const statePages = pages.map(p => ({ ...p, planLine: jev.withShot(p.planLine, jev.PLAN_SHOT_PLACEHOLDER) }));
  const asked = [];
  const allowedOf = new Map();
  for (const r of rows) {
    const roster = r.names;
    const typeShots = (SV.PLAN_TYPES[r.type] && SV.PLAN_TYPES[r.type].shots) || null;
    let allow = typeShots ? typeShots.filter(s => jev.allowedShot({ roster, allow: null }, s)) : null;
    if (allow && !allow.length) allow = null; // the cast breaks the type; reported by the counters, any shot the group rule allows
    allowedOf.set(r.pageNumber, allow);
  }
  const reqs = [];
  for (const r of rows) {
    const allow = allowedOf.get(r.pageNumber) || ids.filter(s => jev.allowedShot({ roster: r.names, allow: null }, s));
    if (allow.length <= 1) continue;
    const page = statePages.find(p => Number(p.pageNumber) === r.pageNumber);
    for (const s of allow) {
      const k = ids.indexOf(s);
      reqs.push({ key: `shot:p${r.pageNumber}:${s}`, state: jev.pageState(arc, statePages, page), questions: { [`S${k}`]: questions[`S${k}`] } });
      asked.push({ page: r.pageNumber, shot: s, k });
    }
  }
  const ans = reqs.length ? await jev.runJevRequests(reqs, { ...opts, usageLabel: 'jev_typed_shot', stats }) : new Map();
  const S = rows.map(() => Object.fromEntries(ids.map(id => [id, 0])));
  rows.forEach((r, i) => {
    const allow = allowedOf.get(r.pageNumber) || ids.filter(s => jev.allowedShot({ roster: r.names, allow: null }, s));
    if (allow.length === 1) S[i][allow[0]] = 1;
  });
  for (const { page, shot, k } of asked) {
    const a = ans.get(`shot:p${page}:${shot}`);
    S[rows.findIndex(r => r.pageNumber === page)][shot] = J.yesProb(a[0][`S${k}`]);
  }
  const assignRows = rows.map(r => ({ page: r.pageNumber, roster: r.names, allow: allowedOf.get(r.pageNumber) || null }));
  const shots = jev.assign(assignRows, S, { quotas: false });
  const beats = jev.applyShots(pages, shots);
  return {
    shots: [...shots],
    unmet: shots.unmet || null,
    pages: rows.map((r, i) => ({ pageNumber: r.pageNumber, type: r.type, shot: shots[i], scores: Object.fromEntries(ids.filter(id => S[i][id]).map(id => [id, +S[i][id].toFixed(3)])) })),
    stats: jev.summarise(stats),
    beats,
  };
}

// ───────────────────────── the measurement, one function for every arm ─────────────────────────

const HIST_EDGES = [0.3, 0.5, 0.7, 0.9];

function histogram(values) {
  const h = { '<0.3': 0, '0.3-0.5': 0, '0.5-0.7': 0, '0.7-0.9': 0, '>=0.9': 0 };
  for (const v of values) {
    if (v < HIST_EDGES[0]) h['<0.3']++; else if (v < HIST_EDGES[1]) h['0.3-0.5']++; else if (v < HIST_EDGES[2]) h['0.5-0.7']++; else if (v < HIST_EDGES[3]) h['0.7-0.9']++; else h['>=0.9']++;
  }
  return h;
}

/**
 * The metrics every arm is held to: code counts (countPlanTargets) plus the
 * Jev reading (judgePlanPages), as one JSON-safe object. `simplicity` is
 * P(simple) = 1 - the SIMPLE fault score.
 *
 * @param {{rows:Array, jevResult:Object, listed:string[], commissionedNames?:string[], arcNames?:string[], mainName?:string|null, maxCharactersPerScene:number}} args
 */
function measurePlan({ rows, jevResult, listed, commissionedNames = null, arcNames = [], mainName = null, maxCharactersPerScene }) {
  const counted = countPlanTargets({ rows, listedNames: listed, commissionedNames, arcNames, mainName, maxCharactersPerScene });
  const st = counted.stats;
  const simple = Object.values(jevResult.pages).map(p => p.scores.SIMPLE).filter(v => typeof v === 'number').map(v => +(1 - v).toFixed(3));
  const mean = simple.length ? +(simple.reduce((a, b) => a + b, 0) / simple.length).toFixed(3) : null;
  const coverage = {};
  for (const name of listed) coverage[name] = rows.filter(r => r.names.some(n => n.toLowerCase() === name.toLowerCase())).length;
  const classCounts = { commissioned: 0, arc: 0, invented: 0 };
  for (const byName of Object.values(st.whoClasses)) for (const c of Object.values(byName)) classCounts[c]++;
  const cross = crossCheckRows(rows);
  return {
    pageCount: rows.length,
    typeCounts: st.typeCounts,
    shotCounts: st.shotCounts,
    neighbourSameShotCount: st.neighbourSameShotCount.length,
    neighbourSameTypeCast: st.neighbourSameTypeCast.length,
    faceCloseUps: st.facePages.length,
    faceCloseUpsAnyone: st.facePagesAll.length,
    sceneryPages: st.sceneryPages.length,
    closeUpsOnMultiFigurePages: st.closeUpOnMultiFigurePages.length,
    simplicity: { n: simple.length, mean, min: simple.length ? Math.min(...simple) : null, histogram: histogram(simple), below: simple.filter(v => v < THRESHOLD).length },
    flagsByQuestion: Object.fromEntries(Object.entries(jevResult.flagged).map(([id, pgs]) => [id, pgs])),
    flagCount: Object.values(jevResult.flagged).reduce((n, pgs) => n + pgs.length, 0),
    coverage,
    coverageTarget: st.targets.appearancesMin,
    mainShare: st.mainCharacter ? { name: st.mainCharacter.name, pages: st.mainCharacter.pages.length, target: st.mainCharacter.target } : null,
    groupPages: st.groupPages.length,
    groupBudget: st.groupBudget,
    peopledPages: rows.filter(r => r.names.length > 0).length,
    noCommissionedPages: st.noCommissionedPages.length,
    inventedFigurePages: st.inventedPages,
    figuresByClass: classCounts,
    codeFindings: counted.findings.map(f => f.code),
    luna: cross.length ? { disagreePages: cross.length, pages: cross } : null,
  };
}

// ───────────────────────── the targeted re-plan ─────────────────────────

const PAGE_LEVEL_CODES = new Set(['PLAN_LINE_INCOMPLETE', 'TYPED_TYPE_UNKNOWN', 'TYPED_WHO_COLLECTIVE', 'TYPE_CAST_MISMATCH']);

/** At most this many Jev flags go back to the planner, the largest margins first (owner 2026-10-06). */
const REPLAN_JEV_MAX = 4;

/** k pages spread evenly over a sorted list. */
function spread(list, k) {
  if (list.length <= k) return [...list];
  const out = [];
  for (let i = 0; i < k; i++) out.push(list[Math.floor(((i + 0.5) * list.length) / k)]);
  return [...new Set(out)];
}

/** The pages a re-plan never rewrites for a book-level need or a Jev flag: first, last, CAST-promised, the sole face and the sole scenery page. */
function protectedPages({ rows, castTable = null, targets, classOf }) {
  const P = rows.length;
  const prot = new Set([1, P]);
  if (castTable) {
    for (const c of castTable.characters || []) { prot.add(Number(c.deedPage)); (c.alsoOn || []).forEach(n => prot.add(Number(n))); }
    if (castTable.ending) prot.add(Number(castTable.ending.page));
  }
  const faces = rows.filter(r => r.type === 'face' && r.names.some(n => classOf(n) === 'commissioned'));
  if (faces.length <= targets.faceMin) faces.forEach(r => prot.add(r.pageNumber));
  const scenery = rows.filter(r => r.type === 'landscape' || r.type === 'object');
  if (scenery.length <= targets.sceneryMin) scenery.forEach(r => prot.add(r.pageNumber));
  return prot;
}

/** What a rewritten page must keep unless its reason forces a change. */
function keepList(r) {
  const keep = [`type ${r.type}`];
  keep.push(r.names.length ? `in frame: ${r.names.join(', ')}` : 'nobody in frame');
  if (r.after) keep.push(`what is true after: ${r.after}`);
  return keep;
}

/**
 * The pages each failure sends back, and why — SMALL on purpose (owner
 * 2026-10-06; Lab #1662 sent 16 pages and kept 2):
 *   code findings, each to its own pages; a book-level miss (no face page, a
 *   character under the floor, ...) has no page, so code NOMINATES candidates
 *   from NON-PROTECTED pages only (never the first or last page, a page the
 *   CAST block promises, the sole face or sole scenery page, a page already
 *   going back); and at most REPLAN_JEV_MAX Jev flags of CALIBRATED questions,
 *   the largest margin over their threshold first, on non-protected pages.
 * A candidate is only a page the re-plan MAY rewrite; the acceptance decides.
 *
 * @returns {Map<number,{reasons:string[], keep:string[]}>}
 */
function replanScope({ rows, findings, jevPages, castTable = null, targets, calibration = CALIBRATION, commissionedNames = [], arcNames = [], jevMax = REPLAN_JEV_MAX }) {
  const out = new Map();
  const give = (page, why) => {
    if (!out.has(page)) { const r = rows.find(x => x.pageNumber === page); out.set(page, { reasons: [], keep: r ? keepList(r) : [] }); }
    if (!out.get(page).reasons.includes(why)) out.get(page).reasons.push(why);
  };
  const classOf = n => whoClassOf(n, commissionedNames, arcNames);
  const prot = protectedPages({ rows, castTable, targets, classOf });
  // Calibrated Jev flags, on pages that may be rewritten, biggest margin first.
  const jevPicks = [];
  for (const [page, o] of Object.entries(jevPages || {})) {
    if (prot.has(Number(page))) continue;
    for (const id of o.flags || []) jevPicks.push({ page: Number(page), id, margin: o.scores[id] - calibration[id].at });
  }
  jevPicks.sort((a, b) => b.margin - a.margin);
  const picked = jevPicks.slice(0, jevMax);
  const flaggedPages = new Set(Object.entries(jevPages || {}).filter(([, o]) => (o.flags || []).length).map(([n]) => Number(n)));
  const free = rows.filter(r => !prot.has(r.pageNumber) && !flaggedPages.has(r.pageNumber));
  const has = (r, name) => r.names.some(n => n.toLowerCase() === name.toLowerCase());
  const commissionedIn = r => r.names.some(n => classOf(n) === 'commissioned');
  const findingsFirst = [...findings].sort((a, b) => (a.code === 'TYPED_INVENTED_FIGURE' ? -1 : 0) - (b.code === 'TYPED_INVENTED_FIGURE' ? -1 : 0));
  for (const f of findingsFirst) {
    if (PAGE_LEVEL_CODES.has(f.code)) { for (const n of f.pages) give(n, f.detail); continue; }
    if (f.code === 'TYPED_INVENTED_FIGURE') { for (const n of f.pages) give(n, `${f.detail}. Name a listed character or a figure of the story logic instead, or take the figure out of the page`); continue; }
    if (f.code === 'CONSECUTIVE_SAME_TYPE_CAST') { give(f.pages[1], `${f.detail} (pages ${f.pages.join(' and ')}): change this page's type or cast`); continue; }
    if (f.code === 'GROUP_PAGES_OVER_BUDGET') {
      const excess = f.pages.length - targets.groupMax;
      const ranked = f.pages.filter(n => !prot.has(n));
      for (const n of ranked.slice(0, Math.max(1, excess))) give(n, `${f.detail}: cut this group page down to one to three characters`);
      continue;
    }
    if (f.code === 'TYPED_NO_COMMISSIONED_OVER') {
      const excess = f.pages.length - targets.noCommissionedMax;
      for (const n of f.pages.filter(x => !out.has(x)).slice(-Math.max(1, excess))) give(n, `${f.detail}: put a listed character in frame on this page`);
      continue;
    }
    let pool; let k = 2; let what;
    if (f.code === 'TYPED_NO_FACE_PAGE') {
      pool = free.filter(r => r.type === 'medium' && r.names.length === 1 && commissionedIn(r));
      if (!pool.length) pool = free.filter(r => r.names.length <= 2 && r.type !== 'face' && commissionedIn(r));
      k = 1; what = 'make this a face page (one listed character, a close-up of their face)';
    } else if (f.code === 'TYPED_NO_SCENERY_PAGE') { pool = free.filter(r => r.names.length <= 2); k = 1; what = 'make this a landscape or object page'; }
    else if (f.code === 'UNDER_COVERED_CHARACTER' || f.code === 'NO_FOCAL_PAGE') {
      const name = (f.detail.match(/^(.+?) (?:is in frame|never has)/) || [])[1];
      pool = free.filter(r => r.names.length <= 2 && name && !has(r, name)); k = 2;
      what = `${name ? `put ${name} in frame here` : 'put the character in frame here'}, with their own action`;
    } else if (f.code === 'MAIN_UNDER_HALF') {
      const need = targets.mainMin - f.pages.length;
      pool = free.filter(r => r.names.length <= 2 && !f.pages.includes(r.pageNumber)); k = Math.max(1, need);
      what = 'put the main character in frame here';
    } else continue;
    for (const r of spread(pool.map(x => x.pageNumber), k)) give(r, `${f.detail} — ${what}`);
  }
  for (const { page, id } of picked) give(page, fixOf(id));
  return out;
}

/**
 * The RE-DIVIDE section the planner is given: the plan that stands, the CAST
 * block, and for each page that goes back its reasons and what it keeps. One
 * round, one call, the lines of those pages only; no generic text repeated.
 */
function typedReplanSection({ pagePlanText, scope, castTable }) {
  const block = castTableBlock(castTable);
  const pageLines = [...scope.entries()].sort((a, b) => a[0] - b[0])
    .map(([page, o]) => `Page ${page}\nChange: ${o.reasons.join(' ')}\nKeep: ${o.keep.join('; ')}`).join('\n\n');
  return [
    '# RE-DIVIDE — one round',
    '',
    'Rewrite ONLY the pages under PAGES TO REWRITE, each answering its Change and keeping its Keep, in the same line format (type — who — moment — after). Every other page stands as written, and a page you rewrite never breaks a target that held.',
    '',
    '## THE PLAN THAT STANDS',
    pagePlanText,
    block ? `\n${block}` : '',
    '',
    '## PAGES TO REWRITE',
    pageLines,
  ].filter(x => x !== null).join('\n');
}

/**
 * Keep a returned page only if it fixes something and breaks nothing.
 *  fixes  = a code finding that stood is gone (or smaller), or a CALIBRATED
 *           question's fault score fell below its threshold by more than its noise;
 *  breaks = a code finding that was not there appears (or grows), or a
 *           CALIBRATED question's fault score rose above its threshold by more
 *           than its noise. An uncalibrated question, or a move inside the noise,
 *           is neither (owner 2026-10-06).
 * Pages are tried in order against the plan as it stands then.
 *
 * @returns {{rows:Array, decisions:Array, jevPages:Object}}
 */
function acceptReplanPages({ rows, returned, countOf, jevBefore, jevAfter, targets, calibration = CALIBRATION }) {
  // A finding's size: how far over (or under) its target the book is, so a page
  // that moves the count closer FIXES part of it and one that moves it away BREAKS.
  const sizeOf = (f) => {
    switch (f.code) {
      case 'GROUP_PAGES_OVER_BUDGET': return f.pages.length - targets.groupMax;
      case 'TYPED_NO_COMMISSIONED_OVER': return f.pages.length - targets.noCommissionedMax;
      case 'TYPED_INVENTED_FIGURE': return f.pages.length;
      case 'MAIN_UNDER_HALF': return targets.mainMin - f.pages.length;
      case 'UNDER_COVERED_CHARACTER': return targets.appearancesMin - f.pages.length;
      default: return 1;
    }
  };
  const keyOf = (f) => {
    const name = (f.detail.match(/^(.+?) (?:is in frame|never has)/) || [])[1];
    return (PAGE_LEVEL_CODES.has(f.code) || f.code === 'CONSECUTIVE_SAME_TYPE_CAST') ? `${f.code}:${(f.pages || []).join('-')}` : `${f.code}${name ? `:${name}` : ''}`;
  };
  const tally = (fs) => { const m = new Map(); for (const f of fs) m.set(keyOf(f), (m.get(keyOf(f)) || 0) + sizeOf(f)); return m; };
  let cur = rows;
  let curTally = tally(countOf(cur));
  const decisions = [];
  const jevNow = { ...jevBefore };
  for (const ret of returned) {
    const idx = cur.findIndex(r => r.pageNumber === ret.pageNumber);
    const cand = cur.map((r, i) => (i === idx ? ret : r));
    const candTally = tally(countOf(cand));
    const removed = []; const added = [];
    for (const k of new Set([...curTally.keys(), ...candTally.keys()])) {
      const d = (candTally.get(k) || 0) - (curTally.get(k) || 0);
      if (d < 0) removed.push(k); else if (d > 0) added.push(k);
    }
    const before = (jevNow[ret.pageNumber] && jevNow[ret.pageNumber].scores) || {};
    const after = (jevAfter[ret.pageNumber] && jevAfter[ret.pageNumber].scores) || {};
    const lostFlags = []; const newFlags = [];
    for (const [id, c] of Object.entries(calibration)) {
      if (!c.calibrated) continue;
      const b = id in before ? before[id] : 0; // a question the new who column makes applicable had no score before
      const a = id in after ? after[id] : 0;
      const noise = c.noise || 0;
      if (b >= c.at && a < c.at - noise) lostFlags.push(id);
      else if (b < c.at && a >= c.at + noise) newFlags.push(id);
    }
    const fixes = removed.length + lostFlags.length;
    const breaks = added.length + newFlags.length;
    const keep = fixes > 0 && breaks === 0;
    decisions.push({ pageNumber: ret.pageNumber, keep, fixes: [...removed, ...lostFlags], breaks: [...added, ...newFlags], reason: keep ? 'fixes something, breaks nothing' : (fixes === 0 ? 'fixes nothing' : 'breaks something') });
    if (keep) { cur = cand; curTally = candTally; jevNow[ret.pageNumber] = jevAfter[ret.pageNumber]; }
  }
  return { rows: cur, decisions, jevPages: jevNow };
}

// ───────────────────────── the whole typed flow ─────────────────────────

const flagsOfPages = pages => Object.fromEntries(Object.entries(pages).map(([n, o]) => [Number(n), o.flags]));
const sumStats = (...ss) => ({ calls: ss.reduce((a, x) => a + (x ? x.calls : 0), 0), costUsd: +ss.reduce((a, x) => a + (x ? x.costUsd : 0), 0).toFixed(6), failed: ss.reduce((a, x) => a + (x ? x.failed : 0), 0) });

/**
 * Plan -> count -> judge -> ONE targeted re-plan -> recount -> shots.
 *
 * `callModel(prompt, usageLabel, {effort})` makes the planner calls (the Lab
 * passes the run's text-model call on claude-sonnet-5-5, records each reply's
 * usage and cost, and passes `planEffort` through the existing effort
 * mechanism); `readPlan` is beatsPipeline.makePlanReader — passed in so this
 * module never requires the pipeline. Fails loudly: a planner reply with
 * missing pages throws (a book planned short is not a result), as production
 * does. `firstOnly` stops after the first plan and its code count (the effort
 * sweep: no Jev, no re-plan, no shots).
 *
 * @returns {Promise<Object>} the report the Lab stores (see the return below)
 */
async function runTypedPlan({ inputData, pageCount, approvedArc, arcHints, arcStoryLogic, arcCentralFigure, commission, maxCast, mainName, arcNames = [], readPlan, callModel, parseCastTable, labPromptOptions = {}, planEffort = null, firstOnly = false, calibration = CALIBRATION }) {
  const t0 = Date.now();
  const listed = commission.listed;
  const known = commission.all;
  const targets = typedPlanTargets({ pageCount, listed, maxCharactersPerScene: maxCast });
  const count = pages => typedPlanCounters({ pages, listedNames: listed, commissionedNames: known, arcNames, mainName, maxCharactersPerScene: maxCast });
  const metricsOf = (rows, jevResult) => measurePlan({ rows, jevResult, listed, commissionedNames: known, arcNames, mainName, maxCharactersPerScene: maxCast });
  const callOpts = planEffort ? { effort: planEffort } : {};

  // 1. THE PLAN: one call, the typed variant of story-beats.txt.
  const prompt = PB.buildBeatsPrompt(inputData, pageCount, { finalArc: approvedArc, arcHints, storyLogic: arcStoryLogic, centralFigure: arcCentralFigure, typedPlan: true, ...labPromptOptions });
  if (!prompt) throw new Error('story-beats template unavailable');
  const planRes = await callModel(prompt, 'typed_plan', callOpts);
  const reply = String(planRes.text || '');
  if (!reply.trim()) throw new Error('the typed planner returned an empty response — provider failure, not a result');
  const first = readPlan(reply).parsed;
  if (first.missing.length) throw new Error(`the typed planner omitted page(s) ${first.missing.join(', ')} of ${pageCount}`);
  const castTable = parseCastTable(reply);
  const firstPlanMs = Date.now() - t0;

  // 2. COUNT in code, JUDGE with Jev.
  const c1 = count(first.pages);
  if (firstOnly) {
    return {
      planModelId: planRes.modelId, firstOnly: true, firstPlan: { prompt, reply: reply.slice(0, 40000), ms: firstPlanMs }, castTable,
      first: { plan: first.pages.map(p => ({ pageNumber: p.pageNumber, planLine: p.planLine })), findings: c1.lines, codes: c1.findings.map(f => f.code), stats: c1.stats },
      jev: { calls: 0, costUsd: 0, failed: 0 }, elapsedMs: Date.now() - t0,
    };
  }
  const j1 = await judgePlanPages({ arc: approvedArc, pages: first.pages, rows: c1.rows, listed }, { calibration });
  const firstMetrics = metricsOf(c1.rows, j1);

  // 3. ONE TARGETED RE-PLAN.
  let standing = first.pages;
  let standingRows = c1.rows;
  let jevPages = j1.pages;
  let replan = null;
  let replanJevStats = null;
  const scope = replanScope({ rows: c1.rows, findings: c1.findings, jevPages: j1.pages, castTable, targets, calibration, commissionedNames: known, arcNames });
  if (scope.size) {
    const t1 = Date.now();
    const section = typedReplanSection({ pagePlanText: standing.map(p => `Page ${p.pageNumber}: ${p.planLine}`).join('\n'), scope, castTable });
    const rp = PB.buildBeatsPrompt(inputData, pageCount, { finalArc: approvedArc, arcHints, storyLogic: arcStoryLogic, centralFigure: arcCentralFigure, castTable, typedPlan: true, replan: section, ...labPromptOptions });
    const rpRes = await callModel(rp, 'typed_replan', callOpts);
    const rpReply = String(rpRes.text || '');
    const returned = readPlan(rpReply).parsed.pages;
    const guards = { dropped: [] };
    // The production guards, on the merged division.
    const { pages: merged, overridden } = mergeReplanPages(returned, standing, { inScope: n => scope.has(Number(n)), scopeAll: false });
    guards.restoredUnnamed = overridden;
    replan = { prompt: rp, reply: rpReply, scope: Object.fromEntries([...scope.entries()].sort((a, b) => a[0] - b[0])), returnedPages: returned.map(p => p.pageNumber), guards, ms: Date.now() - t1 };
    const dupe = duplicatePlanLine(merged);
    if (dupe) { guards.discarded = `two pages share the line "${dupe.slice(0, 80)}"`; }
    else if (!pageCountHolds(merged, pageCount)) { guards.discarded = `${merged.length} pages for a ${pageCount}-page book`; }
    else {
      const byStanding = new Map(standing.map(p => [p.pageNumber, p.planLine]));
      const changed = merged.filter(p => p.planLine !== byStanding.get(p.pageNumber)).map(p => p.pageNumber);
      const cm = count(merged);
      const judgeAfter = changed.length ? await judgePlanPages({ arc: approvedArc, pages: merged, rows: cm.rows, listed, only: changed }, { calibration }) : { pages: {}, stats: null };
      replanJevStats = judgeAfter.stats;
      const returnedRows = cm.rows.filter(r => changed.includes(r.pageNumber));
      const acc = acceptReplanPages({
        rows: standingRows,
        returned: returnedRows,
        countOf: rows => count(rows.map(r => ({ pageNumber: r.pageNumber, planLine: r.planLine }))).findings,
        jevBefore: jevPages,
        jevAfter: judgeAfter.pages,
        targets,
        calibration,
      });
      replan.decisions = acc.decisions;
      standingRows = acc.rows;
      jevPages = acc.jevPages;
      standing = standingRows.map(r => ({ pageNumber: r.pageNumber, planLine: r.planLine }));
    }
  }

  // 4. RECOUNT the shipped division; what is still unmet ships as a warning.
  const cFinal = count(standing);
  const jevFinal = { pages: jevPages, flagged: flaggedOf(jevPages) };
  const unmet = [...cFinal.lines, ...Object.entries(jevFinal.flagged).map(([id, pgs]) => `JEV[${id}] page ${pgs.join(', ')}`)];

  // 5. THE CAMERA inside each type.
  const shots = await decideTypedShots({ arc: approvedArc, pages: standing, rows: cFinal.rows });
  const shotByPage = new Map(shots.pages.map(p => [p.pageNumber, p.shot]));
  const finalRows = cFinal.rows.map(r => ({ ...r, shot: shotByPage.get(r.pageNumber) || null }));
  const finalMetrics = metricsOf(finalRows, jevFinal);

  return {
    planModelId: planRes.modelId,
    firstPlan: { prompt, reply: reply.slice(0, 40000), ms: firstPlanMs },
    castTable,
    first: { plan: first.pages.map(p => ({ pageNumber: p.pageNumber, planLine: p.planLine })), findings: c1.lines, jev: j1.pages, metrics: firstMetrics },
    replan,
    final: { plan: shots.beats.map(p => ({ pageNumber: p.pageNumber, planLine: p.planLine })), findings: cFinal.lines, jev: jevFinal.pages, metrics: finalMetrics, unmet, shots: shots.pages, shotsUnmet: shots.unmet },
    pagesReplanned: replan && replan.decisions ? replan.decisions.filter(d => d.keep).length : 0,
    pagesReturned: replan ? replan.returnedPages.length : 0,
    jev: sumStats(j1.stats, replanJevStats, shots.stats),
    pages: shots.beats,
    rows: finalRows,
    elapsedMs: Date.now() - t0,
  };
}

module.exports = {
  THRESHOLD,
  PLAN_QUESTIONS,
  CALIBRATION,
  REPLAN_JEV_MAX,
  PLAN_LINE_HEAD,
  judgePlanPages,
  faultScore,
  flagsOf,
  fixOf,
  rowsOfUntypedPlan,
  crossCheckRows,
  decideTypedShots,
  measurePlan,
  protectedPages,
  replanScope,
  typedReplanSection,
  acceptReplanPages,
  runTypedPlan,
  mergeReplanPages,
  duplicatePlanLine,
  pageCountHolds,
  typedPlanCounters,
  parseTypedLine,
  parseTypedWho,
  typedPlanTargets,
  spread,
};
