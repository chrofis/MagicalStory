// Build named-figure rows from raw.json (jev-blind-extract.js output).
// node scripts/analysis/jev-blind-rows.js <raw.json> <rows.json> [nStories]
const fs = require('fs');
const raw = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const esc = t => t.split('').map(ch => '.*+?^${}()|[]\\'.includes(ch) ? '\\' + ch : ch).join('');
const maxStories = Number(process.argv[4] || 12);
const zc = z => { const [c, r] = String(z || '').split('-'); return [{ left: 0, center: 1, right: 2 }[c] ?? 1, { foreground: 0, midground: 1, background: 2 }[r] ?? 1]; };
const dist = (a, b) => { const x = zc(a), y = zc(b); return Math.abs(x[0] - y[0]) * 2 + Math.abs(x[1] - y[1]); };
const byStory = {};
for (const v of raw) (byStory[v.story] ||= []).push(v);
// stories newest-first as extracted; keep those with >=8 named rows
const rows = [];
let used = 0;
for (const [sid, vs] of Object.entries(byStory)) {
  if (used >= maxStories) break;
  const firstByPage = {};
  for (const v of vs) if (!(v.page in firstByPage) || v.ver < firstByPage[v.page].ver) firstByPage[v.page] = v;
  const srows = [];
  for (const v of Object.values(firstByPage)) {
    if (typeof v.page !== 'number' || v.page < 1) continue;
    const named = v.qmatch.filter(m => m.reference && m.reference !== 'unmatched' && !/^\(?animal/.test(m.reference));
    const taken = new Set();
    for (const m of named) {
      const qf = v.qfig.find(f => f.id === m.figure); if (!qf) continue;
      let best = null, bd = 99;
      v.figures.forEach((f, i) => { if (taken.has(i)) return; const d = dist(f.zone, qf.zone); if (d < bd) { bd = d; best = i; } });
      if (best == null || bd > 2) continue;
      taken.add(best);
      const f = v.figures[best];
      const c = v.contract.find(c => c.name === m.reference);
      const cast = v.cast.find(c => c.name === m.reference);
      const pm = v.prompt.match(new RegExp(esc(m.reference) + ' \\(([^)]{20,400})\\)'));
      srows.push({
        id: `${sid.slice(-6)}-p${v.page}-v${v.ver}-${m.reference}`, story: sid, page: v.page, ver: v.ver, name: m.reference,
        outfit: c?.outfit || null, inv: f, expAge: cast ? Number(cast.age) : null, promptDesc: pm ? pm[1] : null,
        nFig: v.figures.length, blind: v.blind.filter(b => b.ch === m.reference).map(b => ({ type: b.type, sev: b.sev, d: b.d })),
        blindPage: v.blind.filter(b => !b.ch || !v.cast.some(c => c.name === b.ch)).map(b => ({ type: b.type, sev: b.sev, d: b.d })),
        others: v.fixableIssues.filter(i => i.ch === m.reference && !JSON.stringify(i.src || '').match(/compliance|three-stage/)).map(i => ({ type: i.type, sev: i.sev, src: i.src, d: i.d })),
      });
    }
  }
  if (process.env.DBG) console.error(sid, srows.length, srows.filter(r => r.outfit).length);
  if (srows.filter(r => r.outfit).length >= 8) { rows.push(...srows); used++; }
}
fs.writeFileSync(process.argv[3], JSON.stringify(rows));
console.log('stories', used, 'rows', rows.length, 'with outfit', rows.filter(r => r.outfit).length);
