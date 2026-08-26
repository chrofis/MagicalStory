const fs=require('fs');
const SP=process.env.SP;
for (const f of ['staging','prod']) {
  const j=JSON.parse(fs.readFileSync(`${SP}/${f}.json`,'utf8'));
  const r=j.data.sceneReviewReport||{};
  console.log(`\n########## ${f} — ${j.title}`);
  console.log('model:', r.model, '| changedPages:', JSON.stringify(r.changedPages));
  const bf=r.briefFindings;
  console.log('briefFindings type:', typeof bf, Array.isArray(bf)?`array[${bf.length}]`:'');
  console.log(typeof bf==='string' ? (bf||'(EMPTY STRING)') : JSON.stringify(bf,null,1));
}
