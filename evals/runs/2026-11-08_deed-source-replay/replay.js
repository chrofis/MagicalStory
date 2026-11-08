// Free replay (no model calls): the 12 test-G B plans, counted with the BEFORE code (git HEAD) and the AFTER code (working tree).
// Inputs identical for both: the applied plan, the stored first-division CAST reply (re-parsed by each version's own parser),
// the check's stored ACTION lines, the same synthesised who-column roster as test G's counters.js, every main from mains.json.
const S = __dirname; // __dirname/before = the tree before the change: git archive a28dc8bff server | tar -x -C evals/runs/2026-11-08_deed-source-replay/before ; run with NODE_PATH=<repo>/node_modules
const R = 'C:/Users/roger/MagicalStory';
const load = (root) => ({ PC: require(root + '/server/lib/planCounters'), CC: require(root + '/server/lib/castCoverage') });
const V = { before: load(S + '/before'), after: load(R) };
const A = R + '/evals/runs/2026-11-08_quality-tests-A', F = R + '/evals/runs/2026-11-08_quality-tests-F', G = R + '/evals/runs/2026-11-08_quality-tests-G';
const mains = require(A + '/data/mains.json'), stories = require(A + '/data/stories.json'), man = require(F + '/manifest.json');
const rs = [...require(G + '/exp1838.json').results, ...require(G + '/exp1839.json').results];
const CAST_CODES = new Set(['CAST_PROMISE_BROKEN', 'CAST_PROMISE_FOCAL_BROKEN', 'NO_FOCAL_PAGE', 'UNDER_COVERED_CHARACTER', 'MAIN_UNDER_HALF']);
const tot = { before: {}, after: {} };
const rows = [];
for (const m of man) {
  const s = stories.find(x => x.id.endsWith('_' + m.key)); const mm = mains[s.env + ':' + s.id];
  const chars = mm.chars; const mainNames = mm.main;
  const invented = []; String(s.logic || '').replace(/^- (.+?) \(new\)/gm, (_, a) => invented.push(a.trim()));
  const castAll = [...chars, ...invented];
  const r = rs.find(x => x.storyId.endsWith('_' + m.key));
  const pages = r.appliedPlan.map(p => ({ pageNumber: p.pageNumber, planLine: p.planLine }));
  const row = { key: m.key, P: pages.length, C: chars.length, mains: mainNames.join('/') };
  for (const v of ['before', 'after']) {
    const { PC, CC } = V[v];
    const roster = new Map();
    for (const p of pages) {
      const who = PC.whoColumn(p.planLine) || '';
      const people = /^\s*(nobody|no one|none|no people)\b/i.test(who) ? [] : PC.namesIn(who, castAll);
      roster.set(p.pageNumber, { people, things: [], covers: [], unlisted: [] });
    }
    const cov = CC.castCoverage({ pageCount: pages.length, castCount: chars.length });
    const castTable = CC.parsePlanCastBlock(r.firstPlan.rawResponse, { listed: chars, leadEach: !!cov.leadEach, mains: mainNames });
    const o = PC.runPlanCounters({ pages, commissionedNames: chars, listedNames: chars, roster, mainNames, maxCharactersPerScene: 3, declaredInvented: invented, castTable, actions: r.checkActions });
    const f = o.findings.filter(x => CAST_CODES.has(x.code));
    row[v] = { alsoOnRejected: castTable.rejected.map(x => `${x.name}p${x.page}`), table: o.stats.castTable, cast: f.map(x => x.code + (x.pages && x.pages.length ? '@' + x.pages.join(',') : '')) };
    for (const x of f) tot[v][x.code] = (tot[v][x.code] || 0) + 1;
    tot[v].rejected = (tot[v].rejected || 0) + castTable.rejected.length;
  }
  rows.push(row);
}
for (const r of rows) console.log(`${r.key} P=${r.P} C=${r.C} mains=${r.mains}\n  before: rejected[${r.before.alsoOnRejected}] kept=${r.before.table && r.before.table.kept} broken=${r.before.table && r.before.table.broken} | ${r.before.cast.join(' ') || '-'}\n  after : rejected[${r.after.alsoOnRejected}] kept=${r.after.table && r.after.table.kept} broken=${r.after.table && r.after.table.broken} | ${r.after.cast.join(' ') || '-'}`);
console.log('TOTAL before', JSON.stringify(tot.before)); console.log('TOTAL after ', JSON.stringify(tot.after));
