require('dotenv').config();
const {Pool}=require('pg');
const SID='job_1787262655143_s9zb960muni';
(async()=>{
const p=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});
const r=await p.query('select data,created_at from stories where id=$1',[SID]);
if(!r.rows.length){console.log('not on prod');process.exit(0);}
const d=r.rows[0].data;
console.log('created:',r.rows[0].created_at.toISOString(),'| title:',d.title,'| style:',d.artStyle);
console.log('runMetrics:',JSON.stringify(d.runMetrics||null));
console.log('characters:',(d.characters||[]).map(c=>c.name).join(', '));
console.log('VB animals:',(d.visualBible?.animals||[]).map(a=>a.name).join(', ')||'(none)');
console.log('\nclothing (used):');
for(const [n,v] of Object.entries(d.clothingRequirements||{})){
  const u=Object.entries(v).find(([,x])=>x&&x.used);
  console.log(`  ${n}: ${u?String(u[1].description).slice(0,70):'?'}`);
}
console.log('\npage | backend | identity | figures(seeds) | maskVerdicts');
for(const s of (d.sceneImages||[])){
  const b=s.bboxDetection||{};
  const id=b.gdinoDiag?.identity||{};
  const figs=(b.figures||[]).map(f=>`${f.name}:${f.garmentSeeds??'-'}${f.samApplied?'':'/NOSAM'}`).join(' ');
  const verd=(b.figures||[]).map(f=>f.maskVerdict||'-').join(',');
  console.log(`${String(s.pageNumber).padStart(4)} | ${String(b.detectionBackend||'NULL').padEnd(19)} | ${String(id.method||'-').padEnd(11)}${id.somFailure?' FAIL':''} | ${figs}`);
  if(/rejected|no-mask/.test(verd)) console.log(`       verdicts: ${verd}`);
}
await p.end();
})().catch(e=>{console.error(e.message);process.exit(1)});
