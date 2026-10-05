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
const { typedPlanCounters, countPlanTargets, parseTypedLine, parseTypedWho, deriveRowType, classifyShot } = require('./planCounters');
const { mergeReplanPages, duplicatePlanLine, pageCountHolds } = require('./planGuards');
const { typedPlanTargets } = require('./castCoverage');
const { castTableBlock } = require('./castCoverage');

// ───────────────────────── the per-page Jev questions ─────────────────────────
//
// ONE question per Jev call (owner, 2026-10-05). `bad` says which side of `at`
// is the fault: 'low' = P(yes) below `at` is a fault (the question states a
// virtue), 'high' = P(yes) at or above `at` is a fault. `at` is 0.5 everywhere:
// only WHOLE has a measurement (docs/decisions.md 2026-09-27 "Jev for the
// re-plan guard": Q17, AUC 0.95, 0.5 = recall 23/25 at precision 23/28); the
// other thresholds are the neutral midpoint, chosen, not measured, and the
// experiment reports the raw score distribution so a better one can be read
// off it. `fix` is the repair instruction the targeted re-plan is given.

const THRESHOLD = 0.5;

const PLAN_LINE_HEAD = 'A picture plan line (who is in frame — the moment the picture shows — what is true after):';

/** The plan line without field 0 (the type or the shot): the question never sees what it may choose. */
const bareLine = planLine => jev.planParts(planLine).slice(1).join(' — ');

const localState = planLine => `${PLAN_LINE_HEAD}\n${bareLine(planLine)}`;

const PLAN_QUESTIONS = {
  SIMPLE: {
    text: 'The moment of this plan line is simple to illustrate as one picture: one action, in one place.',
    bad: 'low', at: THRESHOLD, applies: () => true,
    fix: 'The moment is not simple to illustrate. Reduce it to one action in one place that a single picture can hold.',
  },
  ACTION: {
    text: 'The moment is an action being performed — not only a presence or a position (stands, together, visible, gathered, waits), and not the state after an action.',
    bad: 'low', at: THRESHOLD, applies: r => r.names.length > 0,
    fix: 'The moment states a presence, a position or the state after an action. Name the action being performed.',
  },
  DEED: {
    text: `The moment shows an action and the result of that action together. ${PB.DEED_AND_EFFECT_DEF}`,
    bad: 'high', at: THRESHOLD, applies: () => true,
    fix: `The moment holds an action and its result. ${PB.DEED_AND_EFFECT_DEF} Keep the action in the moment and move the result to the last field.`,
  },
  HEIGHTS: {
    text: `The moment puts ${PB.TWO_HEIGHTS_DEF}`,
    bad: 'high', at: THRESHOLD, applies: r => r.names.length >= 2,
    fix: 'The moment puts two characters at different heights in one frame. Stage it from the level the event happens on, with the other character out of the frame (and out of the who column).',
  },
  FELT: {
    text: 'The moment is one character showing a strong feeling, and nothing else happens in it: no second actor, no event.',
    bad: 'low', at: THRESHOLD, applies: r => r.type === 'face',
    fix: 'The face page is not one character\'s felt moment. Make it that character alone showing one strong feeling, with nothing else happening.',
  },
  THIRD: {
    text: 'The moment gives each of the three characters something of their own that the picture cannot show without them; it does not only repeat the action, name the place or assert that they are needed.',
    bad: 'low', at: THRESHOLD, applies: r => r.names.length === 3,
    fix: 'The third character does nothing the picture needs. Give them an action of their own that the page cannot show without them, or take them out of the page.',
  },
  OBSTACLE: {
    text: 'In the moment, something works against what a character is doing — a way blocked, a place kept, a thing taken or withheld, a refusal — and the one holding that obstacle is a character this plan line does not name in its who column.',
    bad: 'high', at: THRESHOLD, applies: r => r.names.length > 0,
    fix: 'Something works against a character\'s action, held by someone this line does not name. Name them in the who column (keeping the type\'s figure count), or change the moment.',
  },
  WEIGHT: {
    text: 'The picture of the page to judge shows something the story has been driving toward: a discovery, an arrival, a payoff.',
    bad: 'low', at: THRESHOLD, applies: r => r.names.length === 0, arcState: true,
    fix: 'This page has no one in frame and its subject carries no story weight. Give it a subject the story has been driving toward, or give the page a character.',
  },
};

/** Q17, as measured: the planner's own definition plus its inverse, averaged (eval-jev-replan-guard.js, `wholecast`). */
const WHOLE = {
  shared: `The moment gives every character in frame one and the same action, by this rule: ${PB.WHOLE_CAST_DEF}`,
  fault: 'In the moment, the characters in frame only stand, gather or are shown together, or one of them acts while the others look on or do something else.',
  at: THRESHOLD,
  fix: `Every character of the cast is in frame without one shared action. ${PB.WHOLE_CAST_DEF}`,
};

const isFault = (q, p) => (q.bad === 'low' ? p < q.at : p >= q.at);

/**
 * Jev, per page, one question per call.
 *
 * @param {Object} input
 * @param {string} input.arc
 * @param {Array<{pageNumber:number, planLine:string}>} input.pages the whole plan (the arc state of WEIGHT shows it)
 * @param {Array<{pageNumber:number, type:string, names:string[]}>} input.rows
 * @param {string[]} input.listed the commission's character list (WHOLE applies where all are in frame)
 * @param {number[]} [input.only] judge only these pages
 * @returns {Promise<{pages: Object<number,{scores:Object, flags:string[]}>, flagged: Object<string,number[]>, stats:Object}>}
 */
async function judgePlanPages({ arc, pages, rows, listed = [], only = null }, opts = {}) {
  const stats = jev.newStats();
  const want = only ? new Set(only.map(Number)) : null;
  const byNum = new Map(pages.map(p => [Number(p.pageNumber), p]));
  const lc = n => String(n).toLowerCase();
  const reqs = [];
  const plan = []; // {page, id}
  for (const r of rows) {
    if (want && !want.has(r.pageNumber)) continue;
    const page = byNum.get(r.pageNumber);
    for (const [id, q] of Object.entries(PLAN_QUESTIONS)) {
      if (!q.applies(r)) continue;
      const state = q.arcState ? jev.pageState(arc, pages, page) : localState(page.planLine);
      reqs.push({ key: `typed:p${r.pageNumber}:${id}`, state, questions: { Q: { type: 'noul', instructions: q.text } } });
      plan.push({ page: r.pageNumber, id });
    }
    if (listed.length > 1 && listed.every(n => r.names.some(x => lc(x) === lc(n)))) {
      for (const [id, text] of [['WHOLE_SHARED', WHOLE.shared], ['WHOLE_FAULT', WHOLE.fault]]) {
        reqs.push({ key: `typed:p${r.pageNumber}:${id}`, state: localState(page.planLine), questions: { Q: { type: 'noul', instructions: text } } });
        plan.push({ page: r.pageNumber, id });
      }
    }
  }
  const ans = reqs.length ? await jev.runJevRequests(reqs, { ...opts, usageLabel: 'jev_typed_plan', stats }) : new Map();
  const out = {};
  for (const r of rows) if (!want || want.has(r.pageNumber)) out[r.pageNumber] = { scores: {}, flags: [] };
  for (const { page, id } of plan) {
    const a = ans.get(`typed:p${page}:${id}`);
    if (!a || !a.length) throw new jev.JevDecisionError(`typed plan: no Jev answer for page ${page} ${id}`);
    out[page].scores[id] = +J.yesProb(a[0].Q).toFixed(3);
  }
  for (const [page, o] of Object.entries(out)) {
    for (const [id, q] of Object.entries(PLAN_QUESTIONS)) if (id in o.scores && isFault(q, o.scores[id])) o.flags.push(id);
    if ('WHOLE_SHARED' in o.scores) {
      const fault = ((1 - o.scores.WHOLE_SHARED) + o.scores.WHOLE_FAULT) / 2;
      o.scores.WHOLE = +fault.toFixed(3);
      if (fault >= WHOLE.at) o.flags.push('WHOLE');
    }
  }
  const flagged = {};
  for (const [page, o] of Object.entries(out)) for (const id of o.flags) (flagged[id] = flagged[id] || []).push(Number(page));
  return { pages: out, flagged, stats: jev.summarise(stats) };
}

/** The repair sentence of a Jev question id. */
const fixOf = id => (id === 'WHOLE' ? WHOLE.fix : PLAN_QUESTIONS[id].fix);

// ───────────────────────── rows: one reading for every arm ─────────────────────────

/**
 * Rows {pageNumber, type, names, shot} of a plan that was NOT written typed
 * (the stored plan, today's plan): who is in frame comes from the plan check's
 * head count (`present`), the shot from field 0, the type is derived.
 */
function rowsOfUntypedPlan(pages, present) {
  return pages.map((p) => {
    const n = Number(p.pageNumber);
    const names = (present && present.get(n)) || [];
    const word = jev.planParts(p.planLine)[0] || '';
    const shotId = classifyShot(word);
    const shot = shotId === 'other' ? null : shotId;
    return { pageNumber: n, type: deriveRowType(names.length, shot), names, shot, planLine: p.planLine };
  });
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
 * Jev reading (judgePlanPages), as one JSON-safe object.
 *
 * @param {{rows:Array, jevResult:Object, listed:string[], commissionedNames?:string[], mainName?:string|null, maxCharactersPerScene:number}} args
 */
function measurePlan({ rows, jevResult, listed, commissionedNames = null, mainName = null, maxCharactersPerScene }) {
  const counted = countPlanTargets({ rows, listedNames: listed, commissionedNames, mainName, maxCharactersPerScene });
  const st = counted.stats;
  const simple = Object.values(jevResult.pages).map(p => p.scores.SIMPLE).filter(v => typeof v === 'number');
  const mean = simple.length ? +(simple.reduce((a, b) => a + b, 0) / simple.length).toFixed(3) : null;
  const coverage = {};
  for (const name of listed) coverage[name] = rows.filter(r => r.names.some(n => n.toLowerCase() === name.toLowerCase())).length;
  return {
    pageCount: rows.length,
    typeCounts: st.typeCounts,
    shotCounts: st.shotCounts,
    neighbourSameShotCount: st.neighbourSameShotCount.length,
    neighbourSameTypeCast: st.neighbourSameTypeCast.length,
    faceCloseUps: st.facePages.length,
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
    noCommissionedPages: st.noCommissionedPages.length,
    codeFindings: counted.findings.map(f => f.code),
  };
}

// ───────────────────────── the targeted re-plan ─────────────────────────

const PAGE_LEVEL_CODES = new Set(['PLAN_LINE_INCOMPLETE', 'TYPED_TYPE_UNKNOWN', 'TYPED_WHO_COLLECTIVE', 'TYPE_CAST_MISMATCH']);

/** k pages spread evenly over a sorted list. */
function spread(list, k) {
  if (list.length <= k) return [...list];
  const out = [];
  for (let i = 0; i < k; i++) out.push(list[Math.floor(((i + 0.5) * list.length) / k)]);
  return [...new Set(out)];
}

/**
 * The pages each failure sends back, and why. A page-level finding or a Jev
 * flag names its own page; a book-level shortfall (no face page, a character
 * under the floor, ...) has no page, so code NOMINATES candidates: pages with at
 * most two figures that are not the book's first or last page and carry no
 * promise the CAST block makes — the cheapest pages to change. A candidate is
 * only a page the re-plan MAY rewrite; the acceptance below decides.
 *
 * @returns {Map<number,string[]>} page → the exact reasons it goes back
 */
function replanScope({ rows, findings, flags, castTable = null, targets }) {
  const reasons = new Map();
  const give = (page, why) => { if (!reasons.has(page)) reasons.set(page, []); if (!reasons.get(page).includes(why)) reasons.get(page).push(why); };
  const P = rows.length;
  const promised = new Set();
  if (castTable) {
    for (const c of castTable.characters || []) { promised.add(Number(c.deedPage)); (c.alsoOn || []).forEach(n => promised.add(Number(n))); }
    if (castTable.ending) promised.add(Number(castTable.ending.page));
  }
  const free = rows.filter(r => r.pageNumber !== 1 && r.pageNumber !== P && !promised.has(r.pageNumber) && !flags[r.pageNumber]?.length);
  const has = (r, name) => r.names.some(n => n.toLowerCase() === name.toLowerCase());
  for (const f of findings) {
    if (PAGE_LEVEL_CODES.has(f.code)) { for (const n of f.pages) give(n, f.detail); continue; }
    if (f.code === 'CONSECUTIVE_SAME_TYPE_CAST') { give(f.pages[1], `${f.detail} (pages ${f.pages.join(' and ')}): change this page's type or cast`); continue; }
    if (f.code === 'GROUP_PAGES_OVER_BUDGET') {
      const excess = f.pages.length - targets.groupMax;
      const ranked = f.pages.filter(n => n !== 1 && n !== P && !promised.has(n)).concat(f.pages.filter(n => n === 1 || n === P || promised.has(n)));
      for (const n of ranked.slice(0, Math.max(1, excess))) give(n, `${f.detail}: cut this group page down to one to three characters`);
      continue;
    }
    if (f.code === 'TYPED_NO_COMMISSIONED_OVER') {
      const excess = f.pages.length - 1;
      for (const n of f.pages.slice(-Math.max(1, excess))) give(n, `${f.detail}: put a listed character in frame on this page`);
      continue;
    }
    let pool; let k = 2; let what;
    if (f.code === 'TYPED_NO_FACE_PAGE') { pool = free.filter(r => r.type === 'medium' && r.names.length === 1); if (!pool.length) pool = free.filter(r => r.names.length <= 2 && r.type !== 'face'); what = 'make this a face page (one character, a close-up of their face)'; }
    else if (f.code === 'TYPED_NO_SCENERY_PAGE') { pool = free.filter(r => r.names.length <= 2); what = 'make this a landscape or object page'; }
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
  for (const [page, ids] of Object.entries(flags)) for (const id of ids) give(Number(page), fixOf(id));
  return reasons;
}

/**
 * The RE-DIVIDE section the planner is given: the plan that stands, the CAST
 * block, and for each page that goes back the exact reasons. One round, one
 * call, the lines of those pages only.
 */
function typedReplanSection({ pagePlanText, reasons, castTable }) {
  const block = castTableBlock(castTable);
  const pageLines = [...reasons.entries()].sort((a, b) => a[0] - b[0])
    .map(([page, why]) => `Page ${page}:\n${why.map(w => `- ${w}`).join('\n')}`).join('\n\n');
  return [
    '# RE-DIVIDE — one round',
    '',
    'The plan below was counted against the targets and judged page by page. Rewrite ONLY the pages listed under PAGES TO REWRITE, each answering its own reasons, in the same line format (type — who — moment — after). Every other page stands as written. Keep the book\'s targets; a page you rewrite never breaks one that held.',
    '',
    '## THE PLAN THAT STANDS',
    pagePlanText,
    block ? `\n${block}` : '',
    '',
    '## PAGES TO REWRITE',
    pageLines,
  ].filter(x => x !== null).join('\n');
}

const flagSet = (jevPages, n) => new Set((jevPages[n] && jevPages[n].flags) || []);

/**
 * Keep a returned page only if it fixes something and breaks nothing:
 * fixes = a code finding that stood is gone, or the page lost a Jev flag;
 * breaks = a code finding that was not there appears, or the page gains a flag.
 * Pages are tried in order against the plan as it stands then, so a page
 * whose fix another page already made is judged against that.
 *
 * @returns {{rows:Array, decisions:Array}}
 */
function acceptReplanPages({ rows, returned, countOf, jevBefore, jevAfter, targets }) {
  // A finding's size: how far over (or under) its target the book is, so a page
  // that moves the count closer FIXES part of it and one that moves it away BREAKS.
  const sizeOf = (f) => {
    switch (f.code) {
      case 'GROUP_PAGES_OVER_BUDGET': return f.pages.length - targets.groupMax;
      case 'TYPED_NO_COMMISSIONED_OVER': return f.pages.length - targets.noCommissionedMax;
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
    const before = flagSet(jevNow, ret.pageNumber);
    const after = flagSet(jevAfter, ret.pageNumber);
    const lostFlags = [...before].filter(f => !after.has(f));
    const newFlags = [...after].filter(f => !before.has(f));
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
const flaggedOf = pages => {
  const out = {};
  for (const [n, o] of Object.entries(pages)) for (const id of o.flags) (out[id] = out[id] || []).push(Number(n));
  return out;
};
const sumStats = (...ss) => ({ calls: ss.reduce((a, x) => a + (x ? x.calls : 0), 0), costUsd: +ss.reduce((a, x) => a + (x ? x.costUsd : 0), 0).toFixed(6), failed: ss.reduce((a, x) => a + (x ? x.failed : 0), 0) });

/**
 * Plan -> count -> judge -> ONE targeted re-plan -> recount -> shots.
 *
 * `callModel(prompt, usageLabel)` makes the planner calls (the Lab passes the
 * run's text-model call on claude-sonnet-5-5, and records each reply's cost);
 * `readPlan` is beatsPipeline.makePlanReader — passed in so this module never
 * requires the pipeline. Fails loudly: a planner reply with missing pages
 * throws (a book planned short is not a result), as production does.
 *
 * @returns {Promise<Object>} the report the Lab stores (see the return below)
 */
async function runTypedPlan({ inputData, pageCount, approvedArc, arcHints, arcStoryLogic, arcCentralFigure, commission, maxCast, mainName, readPlan, callModel, parseCastTable, labPromptOptions = {} }) {
  const t0 = Date.now();
  const listed = commission.listed;
  const known = commission.all;
  const targets = typedPlanTargets({ pageCount, listed, maxCharactersPerScene: maxCast });
  const count = pages => typedPlanCounters({ pages, listedNames: listed, commissionedNames: known, mainName, maxCharactersPerScene: maxCast });
  const metricsOf = (rows, jevResult) => measurePlan({ rows, jevResult, listed, commissionedNames: known, mainName, maxCharactersPerScene: maxCast });

  // 1. THE PLAN: one call, the typed variant of story-beats.txt.
  const prompt = PB.buildBeatsPrompt(inputData, pageCount, { finalArc: approvedArc, arcHints, storyLogic: arcStoryLogic, centralFigure: arcCentralFigure, typedPlan: true, ...labPromptOptions });
  if (!prompt) throw new Error('story-beats template unavailable');
  const planRes = await callModel(prompt, 'typed_plan');
  const reply = String(planRes.text || '');
  if (!reply.trim()) throw new Error('the typed planner returned an empty response — provider failure, not a result');
  const first = readPlan(reply).parsed;
  if (first.missing.length) throw new Error(`the typed planner omitted page(s) ${first.missing.join(', ')} of ${pageCount}`);
  const castTable = parseCastTable(reply);
  const firstPlanMs = Date.now() - t0;

  // 2. COUNT in code, JUDGE with Jev.
  const c1 = count(first.pages);
  const j1 = await judgePlanPages({ arc: approvedArc, pages: first.pages, rows: c1.rows, listed });
  const firstMetrics = metricsOf(c1.rows, j1);

  // 3. ONE TARGETED RE-PLAN.
  let standing = first.pages;
  let standingRows = c1.rows;
  let jevPages = j1.pages;
  let replan = null;
  let replanJevStats = null;
  const reasons = replanScope({ rows: c1.rows, findings: c1.findings, flags: flagsOfPages(j1.pages), castTable, targets });
  if (reasons.size) {
    const t1 = Date.now();
    const section = typedReplanSection({ pagePlanText: standing.map(p => `Page ${p.pageNumber}: ${p.planLine}`).join('\n'), reasons, castTable });
    const rp = PB.buildBeatsPrompt(inputData, pageCount, { finalArc: approvedArc, arcHints, storyLogic: arcStoryLogic, centralFigure: arcCentralFigure, castTable, typedPlan: true, replan: section, ...labPromptOptions });
    const rpRes = await callModel(rp, 'typed_replan');
    const rpReply = String(rpRes.text || '');
    const returned = readPlan(rpReply).parsed.pages;
    const guards = { dropped: [] };
    // The production guards, on the merged division.
    const { pages: merged, overridden } = mergeReplanPages(returned, standing, { inScope: n => reasons.has(Number(n)), scopeAll: false });
    guards.restoredUnnamed = overridden;
    replan = { prompt: rp, reply: rpReply, scope: Object.fromEntries([...reasons.entries()].sort((a, b) => a[0] - b[0])), returnedPages: returned.map(p => p.pageNumber), guards, ms: Date.now() - t1 };
    const dupe = duplicatePlanLine(merged);
    if (dupe) { guards.discarded = `two pages share the line "${dupe.slice(0, 80)}"`; }
    else if (!pageCountHolds(merged, pageCount)) { guards.discarded = `${merged.length} pages for a ${pageCount}-page book`; }
    else {
      const byStanding = new Map(standing.map(p => [p.pageNumber, p.planLine]));
      const changed = merged.filter(p => p.planLine !== byStanding.get(p.pageNumber)).map(p => p.pageNumber);
      const cm = count(merged);
      const judgeAfter = changed.length ? await judgePlanPages({ arc: approvedArc, pages: merged, rows: cm.rows, listed, only: changed }) : { pages: {}, stats: null };
      replanJevStats = judgeAfter.stats;
      const returnedRows = cm.rows.filter(r => changed.includes(r.pageNumber));
      const acc = acceptReplanPages({
        rows: standingRows,
        returned: returnedRows,
        countOf: rows => count(rows.map(r => ({ pageNumber: r.pageNumber, planLine: r.planLine }))).findings,
        jevBefore: jevPages,
        jevAfter: judgeAfter.pages,
        targets,
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
  WHOLE,
  PLAN_LINE_HEAD,
  judgePlanPages,
  fixOf,
  rowsOfUntypedPlan,
  decideTypedShots,
  measurePlan,
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
