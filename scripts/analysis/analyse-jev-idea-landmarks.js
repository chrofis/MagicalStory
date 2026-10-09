// Analyse evals/runs/2026-10-09_jev-idea-review/landmarks.json : top-5 stability, per-landmark offer rate, variety.
const fs = require('fs'); const path = require('path');
const R = JSON.parse(fs.readFileSync(path.join(__dirname, '../../evals/runs/2026-10-09_jev-idea-review/landmarks.json')));
const jac = (a, b) => { const A = new Set(a), B = new Set(b); return [...A].filter(x => B.has(x)).length / new Set([...A, ...B]).size; };
for (const [city, d] of Object.entries(R)) {
  console.log(`\n== ${city}: pool ${d.pool.length}: ${d.pool.join(' | ')}`);
  if (!d.setups.length) continue;
  const offer = {}; const top1 = {}; const tops = [];
  let flips = 0, cmp = 0;
  for (const s of d.setups) {
    const avg = d.pool.map((_, i) => s.runs.reduce((a, r) => a + r[i], 0) / s.runs.length);
    const order = d.pool.map((n, i) => ({ n, p: avg[i] })).sort((a, b) => b.p - a.p);
    const top5 = order.slice(0, 5).map(o => o.n); tops.push(top5);
    top1[top5[0]] = (top1[top5[0]] || 0) + 1;
    // offer rate of a place in an idea prompt = P(in top5) * min(n,5)/5 with n=3 (trial); wizard n=2
    for (const t of top5) offer[t] = (offer[t] || 0) + 1;
    if (s.runs.length > 1) { const t = r => d.pool.map((n, i) => ({ n, p: r[i] })).sort((a, b) => b.p - a.p).slice(0, 5).map(o => o.n); cmp++; flips += 1 - jac(t(s.runs[0]), t(s.runs[1])); }
  }
  const k = d.setups.length;
  let js = 0, c = 0; for (let i = 0; i < tops.length; i++) for (let j = i + 1; j < tops.length; j++) { js += jac(tops[i], tops[j]); c++; }
  console.log(`setups ${k}; mean pairwise Jaccard of top-5 across setups ${(js / c).toFixed(2)}; same-setup rerun top-5 instability ${(cmp ? flips / cmp : 0).toFixed(2)}`);
  console.log('top-1 by setup:', JSON.stringify(top1));
  console.log('in top-5 of N setups (then offered with p=0.6 trial / 0.4 wizard):', JSON.stringify(Object.fromEntries(Object.entries(offer).sort((a, b) => b[1] - a[1]))));
  console.log('distinct places ever in a top-5:', Object.keys(offer).length, 'of', d.pool.length);
  const sp = d.setups.map(s => { const avg = d.pool.map((_, i) => s.runs.reduce((a, r) => a + r[i], 0) / s.runs.length); return Math.max(...avg) - Math.min(...avg); });
  console.log('score spread (max-min) per setup:', sp.map(x => x.toFixed(2)).join(' '));
}
