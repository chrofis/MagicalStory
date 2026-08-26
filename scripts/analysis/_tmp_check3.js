const fs=require('fs');
const SP=process.env.SP;
for (const f of ['staging','prod']) {
  const j=JSON.parse(fs.readFileSync(`${SP}/${f}.json`,'utf8'));
  const p=(j.data.sceneImages||[])[0];
  console.log(`\n===== ${f} page1 =====`);
  for (const k of ['finalScore','qualityScore','semanticScore','semanticResult','threeStageResult','issuesSummary','fixableIssues','fixTargets','entityReport','retryHistory','wasRegenerated','imageVersions']) {
    let v=p[k];
    if (k==='imageVersions') v = Array.isArray(v)? v.map(x=>({src:x.source,score:x.finalScore,q:x.qualityScore,sem:x.semanticScore})) : v;
    if (k==='retryHistory') v = Array.isArray(v)? v.map(x=>Object.keys(x)) : v;
    let s=JSON.stringify(v);
    console.log(k+':', s && s.length>1400 ? s.slice(0,1400)+'…' : s);
  }
}
