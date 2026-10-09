// Repair economics: why first renders fail, which repair works when, wasted spend.
// Input: JSON from repair-economics-extract.js (staging + prod, read-only). Output: JSON result.
// Usage: node repair-economics.js stg.json prod.json out.json
const fs = require('fs');
const [, , stgF, prodF, outF] = process.argv;
const stg = JSON.parse(fs.readFileSync(stgF)), prod = JSON.parse(fs.readFileSync(prodF));
const ids = new Set(stg.map(s => s.id));
const stories = [...stg.map(s => ({ ...s, env: 'stg' })), ...prod.filter(s => !ids.has(s.id)).map(s => ({ ...s, env: 'prod' }))];
const ONLY = process.argv[5]; // optional period prefix filter, e.g. 'C'
const SEV = { catastrophic: 4, critical: 3, major: 2, moderate: 1, minor: 0 };
const sevr = s => SEV[String(s || '').toLowerCase()] ?? 0;
const ZERO = new Set(['garment_colour', 'garment_color', 'cutout_artifact']);
const METHOD_RE = /^(iterate|inpaint|char-fix|garment-recolour)-round-(\d+)$/;
const SIDE = ['style-repair', 'text-space'];
const methodOf = src => {
  if (!src || src === 'original') return null;
  const m = METHOD_RE.exec(src); if (m) return { method: m[1], round: +m[2] };
  if (src === 'scale-repair') return { method: 'scale-repair', round: 0 };
  if (/^style-repair/.test(src)) return { method: 'style-repair', round: 0 };
  if (/^text-space-repair/.test(src)) return { method: 'text-space', round: 0 };
  return null;
};
const GROK_IMG = 0.02;
// effective findings of a version: page judges (consolidated) + entity judge (E: prefix)
const eff = v => {
  const out = [];
  for (const f of (v.b.consolidated || [])) out.push({ k: f.t, n: (f.n || '').toLowerCase(), s: f.s, src: 'page' });
  for (const f of (v.b.entity || [])) out.push({ k: 'E:' + f.t, n: (f.n || '').toLowerCase(), s: f.s, src: 'entity' });
  if (!(v.b.consolidated || []).length) for (const b of ['quality', 'semantic', 'compliance']) for (const f of (v.b[b] || [])) out.push({ k: f.t, n: (f.n || '').toLowerCase(), s: f.s, src: 'page' });
  return out;
};
const has = (list, f) => list.some(g => g.k === f.k && (!f.n || !g.n || g.n === f.n));
const period = ca => ca < '2026-09-06' ? 'A pre-09-06' : ca < '2026-09-19' ? 'B 09-06..09-18' : 'C 09-19+ (compliance judge off)';
if (ONLY) { for (let i = stories.length - 1; i >= 0; i--) if (!period(stories[i].ca).startsWith(ONLY)) stories.splice(i, 1); }
const sum = (a, f) => a.reduce((x, y) => x + f(y), 0);

// ---- per-story cost buckets
const evalFnRe = /^(unified_pipeline_quality_r\d+.*|unified_pipeline_quality_rescue.*|entity_consistency_r\d+)$/;
const repFnRe = /^(inpaint|unified_pipeline_char_fix|unified_pipeline_recolour_r\d+.*|scene_iterate_correct|scene_iterate_retry|repair_face_check|style_repair)$/;
for (const s of stories) {
  s.total = 0; s.repFn = 0; s.fn = {}; s.nVer = {};
  for (const [k, v] of Object.entries(s.byFn)) { const c = v.cost || 0; s.total += c; s.fn[k] = c; if (repFnRe.test(k) || evalFnRe.test(k)) s.repFn += c; }
  for (const p of s.pages) for (const v of p.v) { const m = methodOf(v.src); if (m) s.nVer[m.method] = (s.nVer[m.method] || 0) + 1; }
  s.period = period(s.ca);
}
const tot = k => sum(stories, s => s.fn[k] || 0);
const sumRe = re => sum(stories, s => Object.entries(s.fn).filter(([k]) => re.test(k)).reduce((x, [, c]) => x + c, 0));
const nV = m => sum(stories, s => s.nVer[m] || 0);
const nAllRepVer = ['iterate', 'inpaint', 'char-fix', 'garment-recolour'].reduce((a, m) => a + nV(m), 0);
const reEvalPerVer = sumRe(evalFnRe) / nAllRepVer;
const UNIT = {
  inpaint: tot('inpaint') / nV('inpaint') + reEvalPerVer,
  'char-fix': (tot('unified_pipeline_char_fix') + tot('repair_face_check')) / nV('char-fix') + reEvalPerVer,
  iterate: GROK_IMG + (tot('scene_iterate_correct') + tot('scene_iterate_retry') + tot('scene_iterate')) / nV('iterate') + reEvalPerVer,
  'garment-recolour': sumRe(/^unified_pipeline_recolour/) / nV('garment-recolour') + reEvalPerVer,
  'style-repair': tot('style_repair') / Math.max(1, nV('style-repair')) || 0.01,
  'text-space': GROK_IMG, 'scale-repair': 0.1,
};
// ---- walk pages
const attempts = []; const pageRows = [];
for (const s of stories) {
  for (const p of s.pages) {
    const vs = p.v; if (!vs.length || vs[0].src !== 'original') continue;
    const orig = vs[0];
    const reps = vs.filter(v => methodOf(v.src));
    const bestV = vs.find(v => v.src === p.best) || orig;
    const row = { story: s.id, env: s.env, period: s.period, pn: p.pn, origFs: orig.fs, origNE: orig.fs == null, eff: eff(orig), nRep: reps.length, best: p.best, bestFs: bestV.fs, cost: 0, vs };
    pageRows.push(row);
    for (const v of reps) {
      const mm = methodOf(v.src);
      const earlier = vs.filter(u => u.i < v.i && (u.src === 'original' || (methodOf(u.src) && (mm.round === 0 || methodOf(u.src).round < mm.round || methodOf(u.src).round === 0))));
      const parent = earlier.length ? earlier.reduce((b, u) => ((u.fs ?? -1e9) > (b.fs ?? -1e9) ? u : b)) : orig;
      const pf = eff(parent), rf = eff(v);
      const targets = pf.filter(f => sevr(f.s) >= 2 && !ZERO.has(f.k));
      const cost = UNIT[mm.method] || 0;
      const newF = rf.filter(f => sevr(f.s) >= 2 && !ZERO.has(f.k) && !has(pf, f));
      attempts.push({
        story: s.id, env: s.env, period: s.period, pn: p.pn, method: mm.method, round: mm.round, src: v.src, parentSrc: parent.src, pfs: parent.fs, rfs: v.fs, ne: v.fs == null,
        shipped: p.best === v.src, targets: targets.map(f => ({ k: f.k, s: f.s, n: f.n, gone: !has(rf, f) })), newF: newF.map(f => f.k), cost,
        critBefore: pf.some(f => sevr(f.s) >= 3), critAfter: rf.some(f => sevr(f.s) >= 3),
      });
      row.cost += cost;
    }
  }
}
const isMain = v => { const m = methodOf(v.src); return m && !SIDE.includes(m.method); };
const R = { meta: { stories: stories.length, pages: pageRows.length, byEnv: { stg: stories.filter(s => s.env === 'stg').length, prod: stories.filter(s => s.env === 'prod').length }, byPeriod: stories.reduce((o, s) => (o[s.period] = (o[s.period] || 0) + 1, o), {}), UNIT, reEvalPerVer, totalCost: sum(stories, s => s.total), repFn: sum(stories, s => s.repFn), first: stories[0].ca, last: stories[stories.length - 1].ca } };
// Q1 failure causes on originals
const evaluated = pageRows.filter(r => !r.origNE);
const repairedPage = r => r.vs.some(isMain);
R.meta.evaluatedPages = evaluated.length; R.meta.pagesRepaired = evaluated.filter(repairedPage).length;
R.meta.pagesWithMajorPlus = evaluated.filter(r => r.eff.some(f => sevr(f.s) >= 2 && !ZERO.has(f.k))).length;
R.meta.pagesWithCritical = evaluated.filter(r => r.eff.some(f => sevr(f.s) >= 3)).length;
const typ = {};
for (const r of evaluated) {
  const trig = [...new Set(r.eff.filter(f => sevr(f.s) >= 2 && !ZERO.has(f.k)).map(f => f.k))];
  const rep = repairedPage(r);
  const pageSpend = sum(r.vs.filter(isMain), v => UNIT[methodOf(v.src).method]);
  for (const f of r.eff) {
    const key = f.k + '|' + String(f.s).toLowerCase(); const t = typ[key] = typ[key] || { k: f.k, s: String(f.s).toLowerCase(), n: 0, pages: new Set(), stories: new Set(), trigPages: 0, spend: 0 };
    t.n++; t.pages.add(r.story + '#' + r.pn); t.stories.add(r.story);
  }
  for (const k of trig) {
    const key = k + '|*'; const t = typ[key] = typ[key] || { k, s: 'major+', n: 0, pages: new Set(), stories: new Set(), trigPages: 0, spend: 0 };
    t.pages.add(r.story + '#' + r.pn); t.stories.add(r.story); if (rep) { t.trigPages++; t.spend += pageSpend / trig.length; }
  }
  if (rep && !trig.length) { const t = typ['(score only: no major+)|*'] = typ['(score only: no major+)|*'] || { k: '(score only: no major+)', s: '-', n: 0, pages: new Set(), stories: new Set(), trigPages: 0, spend: 0 }; t.trigPages++; t.spend += pageSpend; }
}
R.q1 = Object.values(typ).map(t => ({ k: t.k, s: t.s, n: t.n, pages: t.pages.size, pagePct: +(100 * t.pages.size / evaluated.length).toFixed(1), perStory: +(t.n / stories.length).toFixed(2), stories: t.stories.size, trigPages: t.trigPages, trigShareOfRepaired: +(100 * t.trigPages / R.meta.pagesRepaired).toFixed(1), spend: +t.spend.toFixed(3) }));
// first-render failure profile per build period (compliance judge off from 09-19: docs/SETTLED.md)
R.q1ByPeriod = {};
for (const per of ['A pre-09-06', 'B 09-06..09-18', 'C 09-19+ (compliance judge off)']) {
  const pg = evaluated.filter(r => r.period === per); const ss = stories.filter(s => s.period === per);
  const mp = pg.filter(r => r.eff.some(f => sevr(f.s) >= 2 && !ZERO.has(f.k)));
  const cr = pg.filter(r => r.eff.some(f => sevr(f.s) >= 3));
  const tp = {};
  for (const r of pg) for (const k of new Set(r.eff.filter(f => sevr(f.s) >= 2 && !ZERO.has(f.k)).map(f => f.k))) tp[k] = (tp[k] || 0) + 1;
  const at = attempts.filter(a => a.period === per && !SIDE.includes(a.method));
  R.q1ByPeriod[per] = { stories: ss.length, pages: pg.length, majorPlusPct: +(100 * mp.length / pg.length).toFixed(1), critPct: +(100 * cr.length / pg.length).toFixed(1), repairedPct: +(100 * pg.filter(repairedPage).length / pg.length).toFixed(1), repairUsdPerStory: +(sum(at, a => a.cost) / ss.length).toFixed(3), storyUsd: +(sum(ss, s => s.total) / ss.length).toFixed(2), topTypes: Object.entries(tp).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, n]) => [k, +(100 * n / pg.length).toFixed(1)]) };
}
// persistence after full regenerate (iterate) as generator-vs-judge probe
const pers = {};
for (const a of attempts.filter(a => a.method === 'iterate' && !a.ne)) for (const f of a.targets) { const t = pers[f.k] = pers[f.k] || { n: 0, gone: 0 }; t.n++; if (f.gone) t.gone++; }
R.persist = pers;
// Q2 matrix
const M = {};
const cell = (k, m) => { const key = k + '|' + m; return M[key] = M[key] || { k, m, att: new Set(), n: 0, gone: 0, dsum: 0, dn: 0, shipN: 0, shipGone: 0, newMaj: 0, cost: 0, critFix: 0, critN: 0 }; };
for (const a of attempts) {
  if (a.ne || !a.targets.length) continue;
  const nt = a.targets.length; const ks = [...new Set(a.targets.map(t => t.k))];
  for (const k of ks) {
    const c = cell(k, a.method); const ts = a.targets.filter(t => t.k === k);
    c.att.add(a.story + a.pn + a.src); c.n += ts.length; c.gone += ts.filter(t => t.gone).length;
    c.dsum += (a.rfs - a.pfs); c.dn++; if (a.shipped) { c.shipN++; c.shipGone += ts.filter(t => t.gone).length; }
    c.newMaj += a.newF.length / ks.length; c.cost += a.cost * ts.length / nt;
    for (const t of ts) if (sevr(t.s) >= 3) { c.critN++; if (t.gone) c.critFix++; }
  }
}
R.matrix = Object.values(M).map(c => ({ k: c.k, m: c.m, attempts: c.att.size, findings: c.n, goneN: c.gone, gonePct: +(100 * c.gone / c.n).toFixed(1), meanDelta: +(c.dsum / c.dn).toFixed(1), shipGone: c.shipGone, shipPct: +(100 * c.shipN / c.dn).toFixed(1), newMajPerAttempt: +(c.newMaj / c.dn).toFixed(2), cost: +c.cost.toFixed(3), costPerFix: c.gone ? +(c.cost / c.gone).toFixed(3) : null, costPerShippedFix: c.shipGone ? +(c.cost / c.shipGone).toFixed(3) : null, critN: c.critN, critFix: c.critFix }));
// per-method totals
const MT = {};
for (const a of attempts) {
  const m = MT[a.method] = MT[a.method] || { method: a.method, att: 0, ne: 0, ship: 0, cost: 0, shipCost: 0, dsum: 0, dn: 0, improved: 0, worse: 0, newMaj: 0, critBefore: 0, critGone: 0, wasteCost: 0, fixTargets: 0, fixGone: 0, shippedFixGone: 0 };
  m.att++; m.cost += a.cost; if (a.ne) { m.ne++; continue; }
  m.dsum += a.rfs - a.pfs; m.dn++; if (a.rfs > a.pfs) m.improved++; if (a.rfs < a.pfs) m.worse++;
  if (a.shipped) { m.ship++; m.shipCost += a.cost; } else m.wasteCost += a.cost; m.newMaj += a.newF.length;
  if (a.critBefore) { m.critBefore++; if (!a.critAfter) m.critGone++; }
  for (const t of a.targets) { m.fixTargets++; if (t.gone) { m.fixGone++; if (a.shipped) m.shippedFixGone++; } }
}
R.methods = Object.values(MT).map(m => ({ ...m, shipPct: +(100 * m.ship / m.att).toFixed(1), meanDelta: +(m.dsum / Math.max(1, m.dn)).toFixed(1), improvedPct: +(100 * m.improved / Math.max(1, m.dn)).toFixed(1), worsePct: +(100 * m.worse / Math.max(1, m.dn)).toFixed(1), fixGonePct: +(100 * m.fixGone / Math.max(1, m.fixTargets)).toFixed(1), costPerShipped: +(m.cost / Math.max(1, m.ship)).toFixed(3), costPerShippedFix: m.shippedFixGone ? +(m.cost / m.shippedFixGone).toFixed(3) : null, cost: +m.cost.toFixed(2), wasteCost: +m.wasteCost.toFixed(2) }));
// by period
R.byPeriod = {};
for (const per of ['A pre-09-06', 'B 09-06..09-18', 'C 09-19+ (compliance judge off)']) {
  const ss = stories.filter(s => s.period === per); const at = attempts.filter(a => a.period === per && !SIDE.includes(a.method));
  const pg = pageRows.filter(r => r.period === per && !r.origNE);
  R.byPeriod[per] = {
    stories: ss.length, pages: pg.length, repairedPages: pg.filter(repairedPage).length, attempts: at.length, shipped: at.filter(a => a.shipped).length, cost: +sum(at, a => a.cost).toFixed(2), totalCost: +sum(ss, s => s.total).toFixed(2),
    improved: at.filter(a => !a.ne && a.rfs > a.pfs).length,
    byMethod: Object.fromEntries(['iterate', 'inpaint', 'char-fix', 'garment-recolour'].map(m => { const x = at.filter(a => a.method === m); const xe = x.filter(a => !a.ne); return [m, { n: x.length, ship: x.filter(a => a.shipped).length, d: +(sum(xe, a => a.rfs - a.pfs) / Math.max(1, xe.length)).toFixed(1) }]; })),
  };
}
// waste
const mainAtt = attempts.filter(a => !SIDE.includes(a.method));
const W = {};
W.totalRepairCost = sum(mainAtt, a => a.cost); W.neverShipCost = sum(mainAtt.filter(a => !a.shipped), a => a.cost); W.neverShipN = mainAtt.filter(a => !a.shipped).length; W.attempts = mainAtt.length;
W.round2plus = sum(mainAtt.filter(a => a.round >= 2), a => a.cost); W.round2plusN = mainAtt.filter(a => a.round >= 2).length; W.round2plusShipN = mainAtt.filter(a => a.round >= 2 && a.shipped).length;
const r1 = mainAtt.filter(a => a.round === 1); W.r1N = r1.length; W.r1ShipN = r1.filter(a => a.shipped).length; W.r1Cost = sum(r1, a => a.cost);
const nfng = mainAtt.filter(a => !a.ne && a.rfs <= a.pfs && a.targets.length && a.targets.every(t => !t.gone));
W.noFixNoGainN = nfng.length; W.noFixNoGainCost = sum(nfng, a => a.cost);
const multi = pageRows.filter(r => r.vs.filter(isMain).length >= 2); W.multiPages = multi.length; W.multiCost = sum(multi, r => sum(r.vs.filter(isMain), v => UNIT[methodOf(v.src).method]));
const repP = pageRows.filter(repairedPage);
W.repairedPages = repP.length; W.repairedBestOrig = repP.filter(r => r.best === 'original').length;
W.repairedBestOrigCost = sum(repP.filter(r => r.best === 'original'), r => sum(r.vs.filter(isMain), v => UNIT[methodOf(v.src).method]));
W.perStoryRepairCost = W.totalRepairCost / stories.length; W.perStoryWaste = W.neverShipCost / stories.length; W.perStoryTotal = R.meta.totalCost / stories.length;
W.perStoryRepFnBilled = R.meta.repFn / stories.length;
R.waste = W;
R.shipped = { pages: pageRows.length, withCritShipped: pageRows.filter(r => { const b = r.vs.find(v => v.src === r.best) || r.vs[0]; return eff(b).some(f => sevr(f.s) >= 3); }).length };
R.cover = { repairVersions: sum(stories.flatMap(s => Object.values(s.covers)), c => Math.max(0, c.v.length - 1)) };
fs.writeFileSync(outF, JSON.stringify(R, null, 1));
fs.writeFileSync(outF.replace(/\.json$/, '.attempts.json'), JSON.stringify(attempts));
console.log(JSON.stringify(R.meta), '\n', JSON.stringify(R.waste, null, 1), '\n', JSON.stringify(R.methods), '\n', JSON.stringify(R.byPeriod), '\n', JSON.stringify(R.shipped));
