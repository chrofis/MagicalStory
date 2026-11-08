// Free replay of the stored Jev group-cut decisions of test G (Lab exps 1838/1839): the stored NEEDED / TOGETHER scores are fed back
// through the real decideGroupCuts of git HEAD (before) and of the working tree (after) via an injected stub; no model call.
const S = __dirname; // __dirname/before = the tree before the change: git archive a28dc8bff server | tar -x -C evals/runs/2026-11-08_deed-source-replay/before ; run with NODE_PATH=<repo>/node_modules
const R = 'C:/Users/roger/MagicalStory';
const JD = { before: require(S + '/before/server/lib/jevDecisions'), after: require(R + '/server/lib/jevDecisions') };
const A = R + '/evals/runs/2026-11-08_quality-tests-A', G = R + '/evals/runs/2026-11-08_quality-tests-G';
const mains = require(A + '/data/mains.json'), stories = require(A + '/data/stories.json');
const rs = [...require(G + '/exp1838.json').results, ...require(G + '/exp1839.json').results];
(async () => {
  let n = 0, mainCutBefore = 0, mainCutAfter = 0, changed = 0;
  for (const r of rs) {
    const s = stories.find(x => x.id.endsWith('_' + r.storyId.split('_').pop())); const mm = mains[s.env + ':' + s.id];
    const PC = require(R + '/server/lib/planCounters');
    const castAll = [...mm.chars];
    for (const cc of (r.jevDecisions.castCuts || [])) {
      const plan = r.standingPlan.map(p => ({ pageNumber: p.pageNumber, planLine: p.planLine }));
      const present = new Map(plan.map(p => { const who = PC.whoColumn(p.planLine) || ''; return [p.pageNumber, /^s*(nobody|no one|none)/i.test(who) ? [] : PC.namesIn(who, castAll)]; }));
      const byPage = new Map(cc.decisions.map(d => [d.pageNumber, d]));
      for (const d of cc.decisions) if (d.keepsGroup === false && d.cast) present.set(d.pageNumber, d.cast);  // the stored cast of each reduced page
      const stub = async ({ state, questions }) => {
        const page = Number((state.match(/PAGE TO JUDGE: Page (\d+)/) || [])[1]);
        const d = byPage.get(page);
        const answers = {};
        for (const [id, q] of Object.entries(questions)) {
          const who = (q.instructions.match(/^(.+?) is needed in the picture/) || [])[1];
          answers[id] = { noul: /brings the whole group together/.test(q.instructions) ? (d ? d.together : 0) : ((d && d.scores && d.scores[who]) ?? 0.5) };
        }
        return { answers, cost: 0, model: 'stub', usage: {} };
      };
      const castTable = r.report.castTable;
      const out = {};
      for (const v of ['before', 'after']) {
        const res = await JD[v].decideGroupCuts({ arc: 'A', pages: plan, present, groupPages: cc.decisions.map(d => d.pageNumber), budget: cc.budget, mainNames: mm.main, castTable, listed: mm.chars, floor: 3 }, { callImpl: stub });
        out[v] = res.decisions.filter(d => !d.keepsGroup).map(d => ({ p: d.pageNumber, removed: d.remove || [], unsat: !!d.unsatisfiable }));
      }
      for (const d of cc.decisions.filter(x => !x.keepsGroup)) {
        n++;
        const bef = out.before.find(x => x.p === d.pageNumber), aft = out.after.find(x => x.p === d.pageNumber);
        mainCutBefore += bef.removed.filter(x => mm.main.includes(x)).length; mainCutAfter += aft.removed.filter(x => mm.main.includes(x)).length;
        if (JSON.stringify(bef) !== JSON.stringify(aft)) changed++;
        console.log(`${r.storyId.slice(-9)} p${d.pageNumber} cast=${d.cast.join(',')} main=${mm.main.join('/')} stored remove=[${(d.remove || []).join(',')}] | before remove=[${bef.removed}] | after remove=[${aft.removed}]${aft.unsat ? ' (page keeps its group)' : ''}`);
      }
    }
  }
  console.log(`reduced pages ${n}; main characters cut: before ${mainCutBefore}, after ${mainCutAfter}; pages whose decision changed ${changed}`);
})();
