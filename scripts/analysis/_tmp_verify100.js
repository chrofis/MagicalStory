require('dotenv').config();
const {Pool}=require('pg');
const SID='job_1787262655143_s9zb960muni';
(async()=>{
const p=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});
const r=await p.query('select data from stories where id=$1',[SID]);
await p.end();
const d=r.rows[0].data;
let pass=0,warn=0,fail=0;
const judge=(label,b)=>{
  if(!b||!b.detectionBackend){console.log(`${label}: FAIL no detection`);fail++;return;}
  const id=b.gdinoDiag?.identity||{};
  const figs=b.figures||[];
  const named=figs.filter(f=>f.name&&f.name!=='UNKNOWN'&&!/^ANI/.test(f.name));
  const sam=named.filter(f=>f.samApplied).length;
  const seeded=named.filter(f=>(f.garmentSeeds??0)>0).length;
  const okBackend=/dino/.test(b.detectionBackend);
  const okId=id.method==='som-gemini';
  const okSam=sam===named.length&&named.length>0;
  const verdict=(okBackend&&okId&&okSam)?(seeded>0?'PASS':'PASS(0-seed)') : 'FAIL';
  if(verdict.startsWith('PASS')){pass++; if(seeded===0)warn++;} else fail++;
  console.log(`${label}: ${verdict}  backend=${b.detectionBackend} id=${id.method}${id.somFailure?'/FAIL':''} sam=${sam}/${named.length} seeded=${seeded}/${named.length}  ${figs.map(f=>`${f.name}:${f.garmentSeeds??'-'}`).join(' ')}`);
};
for(const s of (d.sceneImages||[])) judge(`p${String(s.pageNumber).padStart(3)}`,s.bboxDetection);
for(const [k,v] of Object.entries(d.coverImages||{})) judge(k.padStart(11),v.bboxDetection);
console.log(`\n=== ${pass} PASS (${warn} with zero seeds) / ${fail} FAIL of ${pass+fail} ===`);
process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1)});
