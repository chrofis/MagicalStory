// Pick the labelled sample from rows.json and print it compactly for hand labelling.
const fs = require('fs');
const dir = 'evals/runs/2026-10-09_jev-blind-eval/';
const rows = JSON.parse(fs.readFileSync(dir + 'rows.json', 'utf8')).filter(r => r.outfit && r.inv);
const by = {}; rows.forEach(r => (by[r.story] ||= []).push(r));
const pick = [];
for (const [s, rs] of Object.entries(by)) { const step = Math.max(1, Math.floor(rs.length / 16)); rs.filter((_, i) => i % step === 0).slice(0, 16).forEach(r => pick.push(r)); }
pick.forEach((r, i) => r.n = i);
fs.writeFileSync(dir + 'sample.json', JSON.stringify(pick));
const [a, b] = [Number(process.argv[2] || 0), Number(process.argv[3] || 60)];
for (const r of pick.slice(a, b)) {
  const ph = (r.promptDesc || '').replace(/\s+/g, ' ');
  console.log(`#${r.n} ${r.name} exp${r.expAge}\n C: ${r.outfit.slice(0, 170)}\n I: ${(r.inv.clothing || '').slice(0, 170)} | hd:${(r.inv.headwear || '').slice(0, 30)} | face:${r.inv.facing}\n H: ${(r.inv.hair || '').slice(0, 60)} || P: ${ph.slice(0, 160)} || age ${r.inv.age_group}/${r.inv.apparent_age}\n B: ${r.blind.map(b => b.type + (b.sev || '')[0]).join(',')}`);
}
console.error('picked', pick.length, 'stories', Object.keys(by).length);
