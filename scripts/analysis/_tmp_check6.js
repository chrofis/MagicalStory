const fs=require('fs');
const SP=process.env.SP;
for (const f of ['staging','prod']) {
  const j=JSON.parse(fs.readFileSync(`${SP}/${f}.json`,'utf8'));
  const r=j.data.sceneReviewReport||{};
  console.log(`\n########## ${f} — ${j.title}`);
  console.log('model:', r.model, '| briefsIn:', r.briefsIn, '| changedPages:', JSON.stringify(r.changedPages), '| dur', r.durationMs);
  console.log('--- briefFindings ---');
  console.log(typeof r.briefFindings==='string' ? r.briefFindings : JSON.stringify(r.briefFindings,null,1));
  console.log('--- clothingFindings ---');
  const cf=r.clothingFindings; console.log(typeof cf==='string'?cf.slice(0,600):JSON.stringify(cf).slice(0,600));
  console.log('--- analysis (first 2500) ---');
  console.log(String(r.analysis||'').slice(0,2500));
}
