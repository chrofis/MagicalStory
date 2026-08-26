const fs=require('fs');
const SP=process.env.SP;
const { checkPage } = require('../../server/lib/sceneBriefCheck');
const { extractSceneMetadata } = require('../../server/lib/sceneMetadata');

for (const f of ['staging','prod']) {
  const j = JSON.parse(fs.readFileSync(`${SP}/${f}.json`,'utf8'));
  const d=j.data; const pages=d.sceneImages||[];
  const cast=(d.characters||[]).map(c=>c.name).filter(Boolean);
  console.log(`\n================ ${f.toUpperCase()} — ${j.title} (${pages.length} pages) cast=[${cast.join(', ')}]`);
  console.log('page | fin  qual sem  | #int actions(non-passive)                       | handsRows | storyRel | findings');
  const rows=[];
  for (const p of pages) {
    const md = p.sceneMetadata || extractSceneMetadata(p.sceneDescription||'');
    const ints = (md && Array.isArray(md.interactions)) ? md.interactions : [];
    const acts=[...new Set(ints.map(i=>String(i.action||'').trim().toLowerCase()).filter(a=>a&&!['watching','standing'].includes(a)))];
    const noLabel = ints.filter(i=>!String(i.action||'').trim()).length;
    const hands = ints.filter(i=>i.hands===true);
    const sr = ints.filter(i=>i.storyRelevant===true).length;
    const fnd = checkPage({pageNumber:p.pageNumber, brief:p.sceneDescription||'', metadata:md}, cast, d.visualBible)
      .map(x=>x.type);
    rows.push({p:p.pageNumber, fin:p.finalScore, q:p.qualityScore, s:p.semanticScore, n:ints.length, acts, noLabel, hands:hands.length, sr, fnd, ints, md});
    console.log(
      String(p.pageNumber).padStart(4)+' | '+
      String(p.finalScore??'-').padStart(4)+' '+String(p.qualityScore??'-').padStart(4)+' '+String(p.semanticScore??'-').padStart(4)+' | '+
      String(ints.length).padStart(4)+' '+ (acts.join(' | ')+(noLabel?`  [${noLabel} UNLABELLED]`:'')).padEnd(48).slice(0,48)+' | '+
      String(hands.length).padStart(9)+' | '+String(sr).padStart(8)+' | '+fnd.join(',')
    );
  }
  fs.writeFileSync(`${SP}/${f}.rows.json`, JSON.stringify(rows.map(r=>({...r, ints:r.ints, md:undefined}))));
}
