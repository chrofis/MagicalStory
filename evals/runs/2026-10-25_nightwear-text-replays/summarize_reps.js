const fs = require('fs'); const path = require('path');
// writer: nightwear.used per person per sample (positives)
for (const id of ['job_1792859316244_6429d0n83', 'job_1791918618204_ssjxzvmp4', 'job_1788725396265_p3dh87hsv', 'job_1778881997472_2plcswn7d']) {
  for (const suf of ['', '.r2', '.r3']) {
    const r = JSON.parse(fs.readFileSync(path.join(__dirname, 'stage1', id + suf + '.json'), 'utf8'));
    const used = r.characters.filter(c => r.clothing && r.clothing[c.name] && r.clothing[c.name].nightwear && r.clothing[c.name].nightwear.used).map(c => c.name);
    const keys = r.characters.every(c => r.clothing[c.name] && r.clothing[c.name].nightwear);
    console.log(`writer ${id} ${suf || '.r1'} nightwear.used=[${used.join(',')}] keyOnAll=${keys}`);
  }
}
// AD: bed pages
const bed = { job_1792859316244_6429d0n83: [10], job_1791918618204_ssjxzvmp4: [14] };
for (const [id, pgs] of Object.entries(bed)) {
  for (const suf of ['', '.r2', '.r3']) {
    const r = JSON.parse(fs.readFileSync(path.join(__dirname, 'stage3', id + suf + '.json'), 'utf8'));
    for (const p of r.pages) {
      const [prose, m] = String(p.text).split('---METADATA---');
      let meta = null; try { meta = JSON.parse(m.trim()); } catch (e) { try { meta = JSON.parse(m.match(/\{[\s\S]*\}/)[0]); } catch (e2) {} }
      const cl = meta ? (meta.characters || []).map(c => `${c.name}:${c.clothing}`).join(',') : 'PARSEFAIL';
      const isCover = p.pageNumber < 0;
      const nwCover = isCover && /nightwear/.test(cl);
      if (pgs.includes(p.pageNumber)) {
        const pj = (prose.match(/[^.]*\b(pyjama|pajama)[^.]*\./gi) || []).map(s => s.trim().slice(0, 200));
        console.log(`AD ${id} ${suf || '.r1'} BED p${p.pageNumber}: ${cl} | pyjama prose: ${pj.length ? pj.join(' || ') : '(none)'}`);
      }
      if (nwCover) console.log(`AD ${id} ${suf || '.r1'} COVER ${p.pageNumber} NIGHTWEAR!`);
    }
    // day pages: pages BEFORE bedtime with nightwear or after
    const nwPages = r.pages.filter(p => /"clothing":"nightwear"/.test(String(p.text))).map(p => p.pageNumber);
    console.log(`AD ${id} ${suf || '.r1'} nightwear pages: ${nwPages.join(',')}`);
  }
}
