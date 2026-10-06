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

const PLAN_LINE_HEAD = 'A picture plan line (who is in frame — the instant the picture shows — what is true after):';

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
    virtue: 'The instant of this plan line is simple to illustrate as one picture: one action, in one place.',
    fault: 'The instant of this plan line is complicated to illustrate as one picture: it holds more than one action, or more than one place.',
    applies: () => true,
    fix: 'Reduce the instant to one action in one place that a single picture can hold.',
    relax: {},
  },
  ACTION: {
    virtue: 'The instant is an action being performed by a character, with a verb that moves.',
    fault: 'The instant is only a presence, a position or the state after an action (stands, together, visible, gathered, waits).',
    // Not on a face page: a pure face is a presence by design, and FELT asks that page its own question (calibration v2).
    applies: r => r.names.length > 0 && r.type !== 'face',
    fix: 'Name the action being performed, not a presence, a position or the state after an action.',
    relax: {},
  },
  DEED: {
    virtue: 'The instant is one action, being performed now. Its effect, and where the effect goes, are not in it.',
    fault: `The instant shows an action and the result of that action together. ${PB.DEED_AND_EFFECT_DEF}`,
    applies: () => true,
    fix: 'Keep the action in the instant and move its result to the last field.',
    relax: {},
  },
  HEIGHTS: {
    virtue: 'The figures of the instant stand on at most two height levels in one frame.',
    fault: `The instant puts ${PB.TWO_HEIGHTS_DEF}`,
    applies: r => r.names.length >= 2,
    fix: PB.TWO_HEIGHTS_REMEDY,
    relax: { who: true },
  },
  // FELT2 (calibration v2, 2026-10-06): what the character reacts to may be NAMED when it is outside the picture
  // (owner 2026-10-06: a face close-up may react to something outside the frame; the plan line names it).
  FELT: {
    virtue: 'The instant is one character whose face shows a strong feeling. What they react to may be named, as long as it is outside the picture.',
    fault: 'The instant is not a face showing a feeling: a second character or creature acts inside the picture, or the character is busy with a task of the hands.',
    applies: r => r.type === 'face',
    fix: 'Make this one character alone showing one strong feeling; what they react to may be named, outside the picture.',
    relax: { after: true },
  },
  THIRD: {
    virtue: "In the instant the third of the three characters shares the page's one action: they take part in it.",
    fault: "In the instant one of the three characters only watches or stands by, or does something other than the page's one action.",
    applies: r => r.names.length === 3,
    fix: "Have the third character share the page's one action, or take them out of the page.",
    relax: { who: true },
  },
  OBSTACLE: {
    virtue: 'In the instant nothing works against a character, or whatever does is held by a character this plan line names in its who column.',
    fault: 'In the instant something works against what a character is doing — a way blocked, a place kept, a thing taken or withheld, a refusal — and the one holding that obstacle is a character this plan line does not name in its who column.',
    applies: r => r.names.length > 0,
    fix: 'Name the one who holds the obstacle in the who column (keeping the type\'s figure count), or change the instant.',
    relax: { who: true },
  },
  // WEIGHT2 (calibration v2): the SAME definition the planner's question 2 and the plan check's question 6 read
  // (promptBuilders.PEOPLELESS_WEIGHT_DEF): a danger or obstacle with nobody in the picture is story weight.
  WEIGHT: {
    virtue: `The picture of the page to judge has story weight. ${PB.PEOPLELESS_WEIGHT_DEF}`,
    fault: 'The picture of the page to judge shows a place or thing that plays no part in what happens at this point of the story: scenery only.',
    applies: r => r.names.length === 0, arcState: true,
    fix: 'Give this people-free page a subject with story weight (a discovery, an arrival, a payoff, or the danger or obstacle faced now), or give the page a character.',
    relax: { who: true },
  },
  // Q17, as measured: the planner's own definition plus its inverse (eval-jev-replan-guard.js, `wholecast`).
  WHOLE: {
    virtue: `The instant gives every character in frame one and the same action, by this rule: ${PB.WHOLE_CAST_DEF}`,
    fault: 'In the instant, the characters in frame only stand, gather or are shown together, or one of them acts while the others look on or do something else.',
    applies: (r, ctx) => ctx.listed.length > 1 && ctx.listed.every(n => r.names.some(x => String(x).toLowerCase() === String(n).toLowerCase())),
    fix: 'Give every character of the cast in frame one shared action, or take some of them out of the page.',
    relax: { who: true },
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
const CALIBRATION = {
  // CALIBRATION v2, 2026-10-06 (evals/runs/2026-10-06_typed-plan-jev-v2/calibration.json, dataset typed-plan-jev-v2:
  // 127 typed first-plan lines + 30 stored face / 32 stored people-free pages, paired scores, two blind rater
  // labels, a label = the raters agree, 41 disagreements dropped). A question flags only where its precision on
  // TYPED-format lines is >= 0.8 over >= 4 flags; the flag level is `at` + `noise` (flagLevel). `noise` = 0.05, the
  // largest repeat difference seen across 10,956 calls (mean 0.01).
  SIMPLE: { at: 0.605, noise: 0.05, calibrated: true },   // AUC 0.894, flag level 0.655: 11 of 13 flags real (0.85, CI 0.58-0.96)
  FELT: { at: 0.295, noise: 0.05, calibrated: true },     // FELT2 wording; AUC 0.942, flag level 0.345: 21 of 26 (0.81, CI 0.62-0.91), 22 of 40 labelled faulty
  OBSTACLE: { at: 0.47, noise: 0.05, calibrated: true },  // AUC 0.966, flag level 0.52: 4 of 4; THIN (10 positives in 113)
  // SCORED, never flag (no level reached precision 0.8 on typed lines, or too few positives to find one):
  DEED: { at: 1, noise: 0.05, calibrated: false },        // v1 AUC 0.56 on typed lines (review 2026-10-06): noise; SIMPLE and the planner after-field carry it
  ACTION: { at: 1, noise: 0.05, calibrated: false },      // 2 positives in 101 typed non-face lines (AUC 0.99): no level to calibrate
  WEIGHT: { at: 1, noise: 0.05, calibrated: false },      // WEIGHT2 wording; 2 positives in 42 (AUC 0.975): no level to calibrate
  WHOLE: { at: 1, noise: 0.05, calibrated: false },       // only 4 typed pages hold the whole cast; v1 precision was 0.70
  HEIGHTS: { at: 1, noise: 0.05, calibrated: false },     // v1: AUC 0.658 with 3 positives in 40
  THIRD: { at: 1, noise: 0.05, calibrated: false, guardsAdded: 0.5 }, // scored; guards a rewrite that adds a figure (acceptReplanPages)
};

const faultScore = (pVirtue, pFault) => +(((1 - pVirtue) + pFault) / 2).toFixed(3);

/**
 * The fault score at which a question flags a page: its calibrated threshold plus the repeat noise, so a flag is
 * always a score BEYOND the margin. The same level counts for the bar, sends a page back and decides whether a
 * rewrite fixed or broke it (review 2026-10-06: a fix used to need `at - noise` while the bar counted `at + noise`).
 */
const flagLevel = c => +(c.at + (c.noise || 0)).toFixed(3);

/** The ids a page's scores flag under a calibration. */
const flagsOf = (scores, calibration) => Object.entries(scores)
  .filter(([id, v]) => calibration[id] && calibration[id].calibrated && v >= flagLevel(calibration[id])).map(([id]) => id);

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

/** Which fields of a page the repair of a question lets the re-plan change (the keep list never contradicts it). */
const relaxOf = id => PLAN_QUESTIONS[id].relax || {};

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
    neighbourSameShotCast: st.neighbourSameShotCast.length,
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

const PAGE_LEVEL_CODES = new Set(['PLAN_LINE_INCOMPLETE', 'TYPED_TYPE_UNKNOWN', 'TYPED_WHO_COLLECTIVE', 'TYPE_CAST_MISMATCH', 'PLAN_INSTANT_TOO_LONG']);

/** At most this many Jev flags go back to the planner, the largest margins first (owner 2026-10-06). */
const REPLAN_JEV_MAX = 4;

/** Re-plan rounds: the first answers code findings and Jev flags, the second only the code findings still unmet (decisions.md 2026-10-06 "Typed plan: second re-plan round"). */
const MAX_REPLAN_ROUNDS = 2;

/** k pages spread evenly over a sorted list. */
function spread(list, k) {
  if (list.length <= k) return [...list];
  const out = [];
  for (let i = 0; i < k; i++) out.push(list[Math.floor(((i + 0.5) * list.length) / k)]);
  return [...new Set(out)];
}

/**
 * The CAST block's promises the plan actually KEEPS: the deed pages whose character is in frame, and every page a
 * character is promised on (deed or "also on") that names them. A promise the plan does not keep protects nothing
 * (review 2026-10-06: CAST said "Julian also on 9" while page 9 was nobody, and the page stayed locked).
 *
 * @returns {{deed:Set<number>, stay:Map<number,string[]>}} `stay`: page -> the promised names the page keeps in frame
 */
function heldPromises(castTable, rows) {
  const out = { deed: new Set(), stay: new Map() };
  if (!castTable) return out;
  const spell = (page, name) => {
    const r = rows.find(x => x.pageNumber === Number(page));
    return r ? r.names.find(n => n.toLowerCase() === String(name).toLowerCase()) || null : null;
  };
  const add = (page, name) => {
    const n = spell(page, name);
    if (!n) return false;
    const list = out.stay.get(Number(page)) || [];
    if (!list.includes(n)) list.push(n);
    out.stay.set(Number(page), list);
    return true;
  };
  for (const c of castTable.characters || []) {
    if (add(c.deedPage, c.name)) out.deed.add(Number(c.deedPage));
    (c.alsoOn || []).forEach(n => add(n, c.name));
  }
  return out;
}

/**
 * The pages a re-plan never rewrites for a book-level need or a Jev flag: first, last, the ending page, a deed page
 * whose promise the plan keeps, the sole face and the sole scenery page. A page the CAST block only promises a
 * character "also on" may be rewritten — its promised character stays in frame (replanScope's keep list).
 */
function protectedPages({ rows, castTable = null, targets, classOf }) {
  const P = rows.length;
  const prot = new Set([1, P]);
  heldPromises(castTable, rows).deed.forEach(n => prot.add(n));
  if (castTable && castTable.ending) prot.add(Number(castTable.ending.page));
  const faces = rows.filter(r => r.type === 'face' && r.names.some(n => classOf(n) === 'commissioned'));
  if (faces.length <= targets.faceMin) faces.forEach(r => prot.add(r.pageNumber));
  const scenery = rows.filter(r => r.type === 'landscape' || r.type === 'object');
  if (scenery.length <= targets.sceneryMin) scenery.forEach(r => prot.add(r.pageNumber));
  return prot;
}

/**
 * What a rewritten page must keep unless its reasons force a change — never contradicting a Change (review
 * 2026-10-06: Keep said "nobody in frame" beside "or give the page a character", "the cast" beside "change the
 * cast", an after-field anchor beside a face that must be alone).
 *   relax.type / relax.who / relax.after: the reasons let that field change; `stay`: names that stay in frame
 *   either way (the main character under his floor, a CAST promise); `adds`: names the page gains.
 */
function keepList(r, { relax = {}, stay = [], adds = [] } = {}) {
  const keep = [];
  if (!relax.type) keep.push(relax.who ? `type ${r.type}, or the type the figures left in frame call for` : `type ${r.type}`);
  if (!relax.who) {
    keep.push(r.names.length
      ? `in frame: ${r.names.join(', ')}${adds.length ? ` (and ${adds.join(', ')} joins them, taking part in the page's one action)` : ''}`
      : (adds.length ? `nobody now in frame (${adds.join(', ')} joins)` : 'nobody in frame'));
  } else if (stay.length) keep.push(`stay in frame: ${stay.join(', ')}`);
  if (!relax.after && r.after) keep.push(`what is true after: ${r.after}`);
  return keep;
}

/**
 * The pages each failure sends back, and why — SMALL on purpose (owner
 * 2026-10-06; Lab #1662 sent 16 pages and kept 2):
 *   code findings, each to its own pages; a book-level miss (no face page, a
 *   character under the floor, ...) has no page, so code NOMINATES candidates;
 *   and at most REPLAN_JEV_MAX Jev flags of CALIBRATED questions, the largest
 *   margin over their flag level first, on non-protected pages.
 * The candidate pool of a character's shortfall (the main character's floor,
 * a character under the coverage floor) is every interior MEDIUM page with at
 * most two figures that is not a kept deed page — flagged pages included, so a
 * page already going back can carry the extra figure (review 2026-10-06: the
 * old pool, unprotected and unflagged pages only, held ONE page, and the
 * main floor was unreachable). It asks for the shortfall plus one. A candidate
 * is only a page the re-plan MAY rewrite; the acceptance decides.
 *
 * @returns {Map<number,{reasons:string[], keep:string[], relax:Object, adds:string[], stay:string[]}>}
 */
function replanScope({ rows, findings, jevPages, castTable = null, targets, calibration = CALIBRATION, commissionedNames = [], arcNames = [], jevMax = REPLAN_JEV_MAX }) {
  const out = new Map();
  const P = rows.length;
  const rowOf = page => rows.find(x => x.pageNumber === page);
  const give = (page, why, { relax = {}, add = [] } = {}) => {
    if (!out.has(page)) out.set(page, { reasons: [], keep: [], relax: {}, adds: [], stay: [] });
    const o = out.get(page);
    if (!o.reasons.includes(why)) o.reasons.push(why);
    Object.assign(o.relax, Object.fromEntries(Object.entries(relax).filter(([, v]) => v)));
    for (const a of add) if (!o.adds.includes(a)) o.adds.push(a);
  };
  const classOf = n => whoClassOf(n, commissionedNames, arcNames);
  const prot = protectedPages({ rows, castTable, targets, classOf });
  const promised = heldPromises(castTable, rows);
  // Calibrated Jev flags, on pages that may be rewritten, biggest margin first.
  const jevPicks = [];
  for (const [page, o] of Object.entries(jevPages || {})) {
    if (prot.has(Number(page))) continue;
    for (const id of o.flags || []) jevPicks.push({ page: Number(page), id, margin: o.scores[id] - flagLevel(calibration[id]) });
  }
  jevPicks.sort((a, b) => b.margin - a.margin);
  const picked = jevPicks.slice(0, jevMax);
  const flaggedPages = new Set(Object.entries(jevPages || {}).filter(([, o]) => (o.flags || []).length).map(([n]) => Number(n)));
  const free = rows.filter(r => !prot.has(r.pageNumber) && !flaggedPages.has(r.pageNumber));
  // The wide pool of a character's shortfall: interior medium pages with <= 2 figures, not a kept deed page.
  const wide = rows.filter(r => r.pageNumber !== 1 && r.pageNumber !== P && !promised.deed.has(r.pageNumber) && r.type === 'medium' && r.names.length <= 2);
  const has = (r, name) => r.names.some(n => n.toLowerCase() === name.toLowerCase());
  // A page that is a commissioned character's ONLY focal page (at most two in frame) cannot take a third figure: the add
  // would take that focal page away (round 2 of a short five-character book offered the page round 1 had just made focal).
  const focalCount = new Map();
  for (const r of rows) if (r.names.length <= 2) for (const n of r.names) if (classOf(n) === 'commissioned') focalCount.set(n.toLowerCase(), (focalCount.get(n.toLowerCase()) || 0) + 1);
  const soleFocalFull = r => r.names.length >= 2 && r.names.some(n => focalCount.get(n.toLowerCase()) === 1);
  const commissionedIn = r => r.names.some(n => classOf(n) === 'commissioned');
  const nameOf = f => (f.detail.match(/^(.+?) (?:is in frame|never has)/) || [])[1];
  const mainFinding = findings.find(f => f.code === 'MAIN_UNDER_HALF');
  const mainName = mainFinding ? nameOf(mainFinding) : null;
  // Scarce pages first: an invented figure leaves its page, then a focal page (it needs a page holding at most one figure, which a coverage add would take).
  const urgency = f => (f.code === 'TYPED_INVENTED_FIGURE' ? 0 : f.code === 'TYPED_NO_FACE_PAGE' ? 0.5 : f.code === 'NO_FOCAL_PAGE' ? 1 : 2);
  const facePagesTaken = new Set(); // the page a face nomination took: no figure is added to it (a face page is one figure)
  const findingsFirst = [...findings].sort((a, b) => urgency(a) - urgency(b));
  for (const f of findingsFirst) {
    if (f.code === 'TYPE_CAST_MISMATCH') { for (const n of f.pages) give(n, f.detail, { relax: { type: true, who: true } }); continue; }
    if (f.code === 'TYPED_WHO_COLLECTIVE') { for (const n of f.pages) give(n, f.detail, { relax: { who: true } }); continue; }
    if (PAGE_LEVEL_CODES.has(f.code)) { for (const n of f.pages) give(n, f.detail); continue; }
    if (f.code === 'TYPED_INVENTED_FIGURE') { for (const n of f.pages) give(n, `${f.detail}. Name a listed character or a figure of the story logic instead, or take the figure out of the page`, { relax: { who: true } }); continue; }
    if (f.code === 'GROUP_PAGES_OVER_BUDGET') {
      const excess = f.pages.length - targets.groupMax;
      const ranked = f.pages.filter(n => !prot.has(n));
      for (const n of ranked.slice(0, Math.max(1, excess))) give(n, `${f.detail}: cut this group page down to one to three characters`, { relax: { type: true, who: true } });
      continue;
    }
    if (f.code === 'TYPED_NO_COMMISSIONED_OVER') {
      const excess = f.pages.length - targets.noCommissionedMax;
      for (const n of f.pages.filter(x => !out.has(x)).slice(-Math.max(1, excess))) give(n, `${f.detail}: put a listed character in frame on this page`, { relax: { who: true } });
      continue;
    }
    let pool; let k = 2; let what; let relax = {}; let add = [];
    if (f.code === 'TYPED_NO_FACE_PAGE') {
      // The nomination names WHO takes the close-up (Lab #1686, story 50osg2osm: offered only a page, the planner ignored it
      // twice). A face page is one commissioned figure alone, so it is also that figure's focal page: a character the findings
      // say has no focal page or too few pages takes it; otherwise the commissioned figure with the most pages. A page that
      // already carries another add, or must keep a figure the face would drop, cannot take it. docs/decisions.md 2026-10-06.
      const appears = n => rows.filter(r => has(r, n)).length;
      const lacking = findings.filter(x => (x.code === 'NO_FOCAL_PAGE' || x.code === 'UNDER_COVERED_CHARACTER') && nameOf(x) && classOf(nameOf(x)) === 'commissioned').map(nameOf);
      const taken = r => (out.get(r.pageNumber) || { adds: [] }).adds.length > 0;
      const stays = r => promised.stay.get(r.pageNumber) || [];
      const candidates = [...lacking, ...[...new Set(rows.flatMap(r => r.names).filter(n => classOf(n) === 'commissioned'))].sort((a, b) => appears(b) - appears(a))];
      let faceName = null;
      pool = [];
      for (const name of [...new Set(candidates)]) {
        const fits = free.filter(r => r.type === 'medium' && !taken(r) && r.names.length <= 2 && (has(r, name) || lacking.includes(name)) && stays(r).every(n => n.toLowerCase() === name.toLowerCase()) && !soleFocalFull(r));
        const solo = fits.filter(r => r.names.length === 1 && has(r, name));
        const found = solo.length ? solo : fits;
        if (found.length) { faceName = name; pool = found; add = solo.length ? [] : [name]; break; }
      }
      k = 1; relax = { type: true, who: true };
      what = faceName ? `make this a face page of ${faceName}: ${faceName} alone, a close-up of ${faceName}'s face` : 'make this a face page';
    } else if (f.code === 'TYPED_NO_SCENERY_PAGE') { pool = free.filter(r => r.names.length <= 2); k = 1; what = 'make this a landscape or object page'; relax = { type: true, who: true }; }
    else if (f.code === 'UNDER_COVERED_CHARACTER' || f.code === 'NO_FOCAL_PAGE') {
      const name = nameOf(f);
      // a page takes ONE added figure (two more on a two-figure page break the medium type), and a focal page holds at most two
      pool = wide.filter(r => name && !has(r, name) && !soleFocalFull(r) && !(out.get(r.pageNumber) || { adds: [] }).adds.length && !facePagesTaken.has(r.pageNumber) && (f.code === 'NO_FOCAL_PAGE' ? r.names.length <= 1 : true));
      k = f.code === 'UNDER_COVERED_CHARACTER' ? Math.max(1, targets.appearancesMin - f.pages.length) + 1 : 2;
      what = `${name ? `put ${name} in frame here` : 'put the character in frame here'}, taking part in the page's one action`;
      if (name) add = [name];
    } else if (f.code === 'MAIN_UNDER_HALF') {
      pool = wide.filter(r => !f.pages.includes(r.pageNumber) && !soleFocalFull(r) && !(out.get(r.pageNumber) || { adds: [] }).adds.length && !facePagesTaken.has(r.pageNumber));
      k = Math.max(1, targets.mainMin - f.pages.length) + 1; // the shortfall plus one: a page may fail the acceptance
      what = `put ${mainName || 'the main character'} in frame here, taking part in the page's one action`;
      if (mainName) add = [mainName];
    } else continue;
    const chosen = spread(pool.map(x => x.pageNumber), k);
    if (f.code === 'TYPED_NO_FACE_PAGE') for (const n of chosen) facePagesTaken.add(n);
    for (const r of chosen) give(r, `${f.detail} — ${what}`, { relax, add });
    if (f.code === 'NO_FOCAL_PAGE' && add.length && chosen.length < k) {
      // Too few pages hold a single figure (a short book where two characters each need a focal page): the character may
      // TAKE a two-figure page, one of its figures leaving. The acceptance refuses a swap that costs a coverage or a focal page.
      // Only a figure the book can spare may leave: one above its coverage floor (the main character above his), or one that is not commissioned.
      const appears = n => rows.filter(r => has(r, n)).length;
      const leavers = r => r.names.filter(n => classOf(n) !== 'commissioned' || appears(n) > (mainName && n.toLowerCase() === mainName.toLowerCase() ? targets.mainMin : targets.appearancesMin));
      const swap = wide.filter(r => r.names.length === 2 && !has(r, add[0]) && !soleFocalFull(r) && leavers(r).length && !(out.get(r.pageNumber) || { adds: [] }).adds.length && !facePagesTaken.has(r.pageNumber) && !chosen.includes(r.pageNumber));
      for (const r of spread(swap.map(x => x.pageNumber), k - chosen.length)) give(r, `${f.detail} — give ${add[0]} a focal page here: ${add[0]}'s own action is the page's subject, ${add[0]} alone or with one companion (${leavers(rowOf(r)).join(' or ')} may leave the page)`, { relax: { type: true, who: true }, add });
    }
  }
  for (const { page, id } of picked) give(page, fixOf(id), { relax: relaxOf(id) });
  // Keep lists, last: they read every reason a page carries, and the figures that stay either way.
  for (const [page, o] of out) {
    const r = rowOf(page);
    if (!r) continue;
    const stay = [...(promised.stay.get(page) || [])];
    if (mainName && has(r, mainName) && !stay.includes(mainName)) stay.push(mainName);
    o.stay = stay;
    o.keep = keepList(r, { relax: o.relax, stay, adds: o.adds });
  }
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
    'Rewrite ONLY the pages under PAGES TO REWRITE, each answering its Change and keeping its Keep, in the same line format (type — who — instant — after). Every other page stands as written, and a page you rewrite never breaks a target that held.',
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
 *           question leaves its flag level (threshold + noise, the level the bar counts);
 *  breaks = a code finding that was not there appears (or grows), a CALIBRATED
 *           question reaches its flag level, or a question already flagged gets
 *           worse by more than its noise; and a rewrite that ADDS a figure may not
 *           leave the third-character question (guardsAdded) above its guard.
 *           Any other uncalibrated question is neither (owner 2026-10-06).
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
    const prevRow = cur[idx];
    const lostFlags = []; const newFlags = [];
    for (const [id, c] of Object.entries(calibration)) {
      const b = id in before ? before[id] : 0; // a question the new who column makes applicable had no score before
      const a = id in after ? after[id] : 0;
      if (!c.calibrated) {
        // THIRD: scored, never flagged, but a rewrite that ADDS a figure may not leave it a bystander (review 2026-10-06:
        // probe pages that added the main character "beside" the action were accepted).
        if (c.guardsAdded != null && ret.names.length > prevRow.names.length && a >= c.guardsAdded && a >= b + (c.noise || 0)) newFlags.push(id);
        continue;
      }
      const level = flagLevel(c);
      // A fix is leaving a flag, a break is gaining one — the SAME level the bar counts. A flagged question that gets
      // worse beyond the repeat noise is a break too: the page ships with a bigger fault than it had.
      if (b >= level && a < level) lostFlags.push(id);
      else if (b < level && a >= level) newFlags.push(id);
      else if (b >= level && a >= b + (c.noise || 0)) newFlags.push(id);
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

  // 3. TARGETED RE-PLAN ROUNDS. Round 1 answers the code findings and the calibrated Jev flags; each later round is
  // CODE-triggered only (a book-level target is still unmet: two characters that each need a focal page cannot both
  // be placed by one round — 50osg2osm, Lab 1675-1685) and answers the code findings alone, against the plan as it
  // stands. The loop ends when no code finding has a page to send back or MAX_REPLAN_ROUNDS is spent.
  let standing = first.pages;
  let standingRows = c1.rows;
  let jevPages = j1.pages;
  const rounds = [];
  let replanJevStats = null;
  for (let round = 1; round <= MAX_REPLAN_ROUNDS; round++) {
    const cNow = round === 1 ? c1 : count(standing);
    const scope = replanScope({ rows: cNow.rows, findings: cNow.findings, jevPages, castTable, targets, calibration, commissionedNames: known, arcNames, jevMax: round === 1 ? REPLAN_JEV_MAX : 0 });
    if (!scope.size) break;
    const t1 = Date.now();
    const section = typedReplanSection({ pagePlanText: standing.map(p => `Page ${p.pageNumber}: ${p.planLine}`).join('\n'), scope, castTable });
    const rp = PB.buildBeatsPrompt(inputData, pageCount, { finalArc: approvedArc, arcHints, storyLogic: arcStoryLogic, centralFigure: arcCentralFigure, castTable, typedPlan: true, replan: section, ...labPromptOptions });
    const rpRes = await callModel(rp, round === 1 ? 'typed_replan' : `typed_replan_${round}`, callOpts);
    const rpReply = String(rpRes.text || '');
    const returned = readPlan(rpReply).parsed.pages;
    const guards = { dropped: [] };
    // The production guards, on the merged division.
    const { pages: merged, overridden } = mergeReplanPages(returned, standing, { inScope: n => scope.has(Number(n)), scopeAll: false });
    guards.restoredUnnamed = overridden;
    const replan = { round, prompt: rp, reply: rpReply, scope: Object.fromEntries([...scope.entries()].sort((a, b) => a[0] - b[0])), returnedPages: returned.map(p => p.pageNumber), guards, ms: Date.now() - t1 };
    rounds.push(replan);
    const dupe = duplicatePlanLine(merged);
    if (dupe) { guards.discarded = `two pages share the line "${dupe.slice(0, 80)}"`; continue; }
    if (!pageCountHolds(merged, pageCount)) { guards.discarded = `${merged.length} pages for a ${pageCount}-page book`; continue; }
    const byStanding = new Map(standing.map(p => [p.pageNumber, p.planLine]));
    const changed = merged.filter(p => p.planLine !== byStanding.get(p.pageNumber)).map(p => p.pageNumber);
    const cm = count(merged);
    const judgeAfter = changed.length ? await judgePlanPages({ arc: approvedArc, pages: merged, rows: cm.rows, listed, only: changed }, { calibration }) : { pages: {}, stats: null };
    replanJevStats = sumStats(replanJevStats, judgeAfter.stats);
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
  const replan = rounds[0] || null;

  // 4. RECOUNT the shipped division; what is still unmet ships as a warning.
  const cFinal = count(standing);
  const jevFinal = { pages: jevPages, flagged: flaggedOf(jevPages) };
  const unmet = [...cFinal.lines, ...Object.entries(jevFinal.flagged).map(([id, pgs]) => `JEV[${id}] page ${pgs.join(', ')}`)];

  // 5. THE CAMERA inside each type.
  const shots = await decideTypedShots({ arc: approvedArc, pages: standing, rows: cFinal.rows });
  const shotByPage = new Map(shots.pages.map(p => [p.pageNumber, p.shot]));
  const finalRows = cFinal.rows.map(r => ({ ...r, shot: shotByPage.get(r.pageNumber) || null }));
  const finalMetrics = metricsOf(finalRows, jevFinal);
  // The neighbour rule (owner 2026-10-06): no two neighbouring pages the same SHOT with the same CAST — known only
  // now that Jev has picked the shots, so it is reported here (never a re-plan reason).
  const shotFindings = countPlanTargets({ rows: finalRows, listedNames: listed, commissionedNames: known, arcNames, mainName, maxCharactersPerScene: maxCast })
    .lines.filter(l => l.startsWith('PLAN[CONSECUTIVE_SAME_SHOT_CAST]'));
  unmet.push(...shotFindings);

  return {
    planModelId: planRes.modelId,
    firstPlan: { prompt, reply: reply.slice(0, 40000), ms: firstPlanMs },
    castTable,
    first: { plan: first.pages.map(p => ({ pageNumber: p.pageNumber, planLine: p.planLine })), findings: c1.lines, jev: j1.pages, metrics: firstMetrics },
    replan,
    final: { plan: shots.beats.map(p => ({ pageNumber: p.pageNumber, planLine: p.planLine })), findings: [...cFinal.lines, ...shotFindings], jev: jevFinal.pages, metrics: finalMetrics, unmet, shots: shots.pages, shotsUnmet: shots.unmet },
    replanRounds: rounds,
    pagesReplanned: rounds.reduce((n, r) => n + (r.decisions ? r.decisions.filter(d => d.keep).length : 0), 0),
    pagesReturned: rounds.reduce((n, r) => n + r.returnedPages.length, 0),
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
  flagLevel,
  heldPromises,
  keepList,
  relaxOf,
  REPLAN_JEV_MAX,
  MAX_REPLAN_ROUNDS,
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
