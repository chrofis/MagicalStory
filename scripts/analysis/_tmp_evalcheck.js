require('dotenv').config();
const fs=require('fs');
const SP=process.env.SP;
(async()=>{
  const j=JSON.parse(fs.readFileSync(`${SP}/prod.json`,'utf8'));
  const pn=parseInt(process.env.PAGE||'15',10);
  const page=(j.data.sceneImages||[]).find(p=>p.pageNumber===pn);
  const url=`https://images.magicalstory.ch/stories/${j.id}/scene/p${pn}/v0.jpg`;
  const res=await fetch(url);
  const buf=Buffer.from(await res.arrayBuffer());
  const dataUri=`data:image/jpeg;base64,${buf.toString('base64')}`;
  console.log('page',pn,'bytes',buf.length);
  const { evaluateImageQuality } = require('../../server/lib/evalPipeline');
  const t=Date.now();
  const r=await evaluateImageQuality(dataUri, page.prompt||'', [], 'scene', null, `p${pn}`,
    null, page.outlineExtract||'', page.sceneCharacters||[], {});
  console.log('elapsed', ((Date.now()-t)/1000).toFixed(1)+'s');
  if (r===null) { console.log('RESULT: null  <-- STILL BROKEN'); process.exit(2); }
  console.log('score:', r.score, '| finalScore:', r.finalScore, '| semanticScore:', r.semanticScore);
  console.log('threeStage score:', r.threeStageResult && r.threeStageResult.score);
  const iss=(r.issues||r.fixableIssues||[]);
  console.log('issues:', iss.length);
  for (const i of iss.slice(0,8)) console.log('  -', i.severity||i.type, ':', String(i.description||i.issue||JSON.stringify(i)).slice(0,180));
})().catch(e=>{console.error('THREW:',e&&e.message); process.exit(3);});
