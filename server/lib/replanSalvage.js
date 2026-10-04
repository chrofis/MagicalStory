/**
 * A DISCARDED RE-PLAN ROUND KEEPS ITS GOOD PAGES (owner, 2026-09-28).
 *
 * The never-regress guard (promptBuilders.replanRoundRegressed) judges a round
 * whole: one page that mints a cast/focal must-fix finding throws away every
 * page the round fixed. Staging job_1790539784661_6mjcny1c7 round 1 cast Levin
 * into p4 (answering CAST_NOT_IN_WHO_COLUMN) and p7 (CHECK[18]), and also cast
 * all four boys into p12 — a fourth group page over a budget of three
 * (GROUP_PAGES_OVER_BUDGET). The count went 6 → 8, the whole round was
 * discarded, and p4 / p7 shipped without Levin.
 *
 * THE DESIGN: page by page, never whole-round. When the guard discards a
 * round, code searches for the smallest set of the round's changed pages to
 * put back to the division that stands, such that what remains no longer
 * regresses. Each candidate division is judged WITHOUT a model call, from
 * facts the two checks already hold: every plan line in a candidate is either
 * the round's version (judged by the recheck) or the standing version (judged
 * by the check the round was given), so each page's roster, obstacle, central
 * membership and model verdict are taken from the check that saw that exact
 * line, and the counters — arithmetic over those per-page facts — are re-run
 * on the mix (planCheckRunner.compose). The search is greedy: each step puts
 * back the one page whose return lowers the cast/focal must-fix count most.
 *
 * The composite only CHOOSES the pages. The division it picks then gets one
 * real plan check (the caller's runCheck), and the same guard decides on that
 * — a composite is never shipped as a verdict. A model finding that spans a
 * kept and a returned page is the one fact no single check saw; the real
 * recheck is what covers it.
 *
 * Why not the other shape the owner named — letting decideGroupCuts resolve
 * the round's group overflow before the guard counts it: that answers one
 * finding code (GROUP_PAGES_OVER_BUDGET) and needs another planner call to
 * re-word each cut page (a cut writes only the who column; code never patches
 * the planner's instant), while the dragon round also minted CAST_PROMISE_BROKEN
 * p10 and three CHECK[17] lines. Putting pages back answers every minted
 * finding the same way, with no new planner text.
 *
 * see docs/decisions.md 2026-09-28 "A discarded re-plan round keeps its good pages"
 */
const { replanRoundRegressed, findingPages } = require('./promptBuilders');

/**
 * The parsed check facts of a division mixing two checks' pages.
 *
 * @param {Object} p
 * @param {Object} p.given     the check of the standing division (has `.parsed`, `.modelFindings`)
 * @param {Object} p.recheck   the check of the round's division
 * @param {Set<number>} p.reverted  pages put back to the standing version
 * @param {Set<number>} p.changed   pages the round changed
 * @returns {{parsed: Object, modelFindings: Array}}
 */
function compositeCheckInputs({ given, recheck, reverted, changed }) {
  const G = given.parsed || {};
  const R = recheck.parsed || {};
  // The check that judged page n's line in the mix.
  const src = n => (reverted.has(Number(n)) ? G : R);
  const pages = new Set([...(R.roster ? R.roster.keys() : []), ...(G.roster ? G.roster.keys() : [])].map(Number));
  const roster = new Map();
  const obstacles = new Map();
  for (const n of pages) {
    const s = src(n);
    if (s.roster && s.roster.has(n)) roster.set(n, s.roster.get(n));
    if (s.obstacles && s.obstacles.has(n)) obstacles.set(n, s.obstacles.get(n));
  }
  // A per-page membership list: page n is central when the check that judged
  // its line said so. null (no CENTRAL line) stays null only when both are null.
  const centralPages = (R.centralPages == null && G.centralPages == null) ? null
    : [...pages].filter(n => (src(n).centralPages || []).map(Number).includes(n)).sort((a, b) => a - b);
  // One nomination per check: the recheck's, unless its page went back; then
  // the given check's, when its page is a standing line in the mix.
  const standingLine = n => reverted.has(Number(n)) || !changed.has(Number(n));
  const peoplelessPick = (R.peoplelessPick && !reverted.has(Number(R.peoplelessPick.page))) ? R.peoplelessPick
    : (G.peoplelessPick && standingLine(G.peoplelessPick.page) ? G.peoplelessPick : null);
  // Anchors (WANTED per act, ACTION per character): per key, the recheck's
  // unless its page went back, then the given check's.
  const anchors = (r = [], g = []) => {
    const keys = [...new Set([...r.map(a => a.key), ...g.map(a => a.key)])];
    return keys.map((k) => {
      const ra = r.find(a => a.key === k);
      const ga = g.find(a => a.key === k);
      if (ra && (ra.page == null || !reverted.has(Number(ra.page)))) return ra;
      if (ga && (ga.page == null || standingLine(ga.page))) return ga;
      return ra || ga;
    });
  };
  // Model verdicts: the recheck's on lines still in the mix; the given check's
  // on the lines that went back (and only those — a verdict on untouched pages
  // is the recheck's, which saw the same lines).
  const touches = (f, set) => findingPages({ line: `CHECK[${f.check}]: ${f.text}` }).some(n => set.has(Number(n)));
  const onlyStanding = f => findingPages({ line: `CHECK[${f.check}]: ${f.text}` }).every(n => standingLine(n));
  const modelFindings = [
    ...(recheck.modelFindings || []).filter(f => !touches(f, reverted)),
    ...(given.modelFindings || []).filter(f => touches(f, reverted) && onlyStanding(f)),
  ];
  return {
    parsed: {
      roster, obstacles, centralPages, peoplelessPick,
      wanted: anchors(R.wanted, G.wanted), actions: anchors(R.actions, G.actions),
    },
    modelFindings,
  };
}

/**
 * Choose the round's pages to put back so the rest no longer regresses.
 *
 * @param {Object} p
 * @param {Array<{pageNumber:number, planLine:string}>} p.standing  the division the round was given
 * @param {Array<{pageNumber:number, planLine:string}>} p.returned  the round's division
 * @param {number[]} p.changedPages   pages whose line the round changed
 * @param {Object} p.given            the check of `standing`
 * @param {Object} p.recheck          the check of `returned`
 * @param {Function} p.compose        (pages, parsed, modelFindings) → a check object (planCheckRunner.compose)
 * @param {number} p.round
 * @returns {null|{pages:Array, kept:number[], reverted:number[], verdict:Object, steps:Array}}
 *   null when no page can be kept: every changed page had to go back, or no
 *   step lowered the count.
 */
function salvageReplanRound({ standing, returned, changedPages, given, recheck, compose, round }) {
  if (typeof compose !== 'function' || !given || !recheck || !given.parsed || !recheck.parsed) return null;
  const changed = new Set((changedPages || []).map(Number));
  const standingBy = new Map((standing || []).map(p => [Number(p.pageNumber), p]));
  const mix = reverted => (returned || []).map(p => (reverted.has(Number(p.pageNumber)) && standingBy.has(Number(p.pageNumber)) ? standingBy.get(Number(p.pageNumber)) : p));
  const judge = (reverted) => {
    const pages = mix(reverted);
    const { parsed, modelFindings } = compositeCheckInputs({ given, recheck, reverted, changed });
    const check = compose(pages, parsed, modelFindings);
    const kept = [...changed].filter(n => !reverted.has(n));
    return { pages, check, verdict: replanRoundRegressed(given, check, kept, { round }) };
  };
  let reverted = new Set();
  let cur = judge(reverted);
  const steps = [];
  while (cur.verdict.discard) {
    let best = null;
    for (const n of [...changed].filter(x => !reverted.has(x)).sort((a, b) => a - b)) {
      const trial = judge(new Set([...reverted, n]));
      if (!best || trial.verdict.after < best.res.verdict.after) best = { n, res: trial };
    }
    if (!best || best.res.verdict.after >= cur.verdict.after) return null;
    reverted = new Set([...reverted, best.n]);
    steps.push({ reverted: best.n, after: best.res.verdict.after });
    cur = best.res;
  }
  const kept = [...changed].filter(n => !reverted.has(n)).sort((a, b) => a - b);
  if (!kept.length || !reverted.size) return null;
  return { pages: cur.pages, kept, reverted: [...reverted].sort((a, b) => a - b), verdict: cur.verdict, steps, check: cur.check };
}

module.exports = { compositeCheckInputs, salvageReplanRound };
