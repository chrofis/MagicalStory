const fs = require('fs'); const path = require('path');
const dir = path.join(__dirname, 'stage3');
for (const f of fs.readdirSync(dir).sort()) {
  const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  let nwPages = 0, total = 0;
  console.log(`\n## ${r.kind} ${r.id} "${r.title}" covers=${JSON.stringify(r.covers)} pages=${r.pages.length}`);
  for (const p of r.pages) {
    total++;
    const m = String(p.text).split('---METADATA---')[1] || '';
    let meta = null;
    try { meta = JSON.parse(m.trim()); } catch (e) { const mm = m.match(/\{[\s\S]*\}/); try { meta = JSON.parse(mm[0]); } catch (e2) { meta = null; } }
    const cl = meta ? (meta.characters || []).map(c => `${c.name}:${c.clothing}`).join(', ') : 'META-PARSE-FAIL';
    const hasNw = /nightwear/.test(cl);
    if (hasNw) nwPages++;
    const prose = String(p.text).split('---METADATA---')[0];
    const pj = (prose.match(/[^.]*\b(pyjama|pajama|slippers|nightgown|nightshirt)[^.]*\./gi) || []).map(s => s.trim().slice(0, 260));
    const cover = r.covers.includes(p.pageNumber) ? ' [COVER]' : '';
    if (r.kind === 'positive' || hasNw || cover) console.log(` p${p.pageNumber}${cover} ${cl}${pj.length ? '\n     PROSE: ' + pj.join(' | ') : ''}`);
  }
  console.log(` -> pages with nightwear: ${nwPages} / ${total}`);
}
