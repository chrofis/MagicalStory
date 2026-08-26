require('dotenv').config();
const {Pool}=require('pg');const sharp=require('sharp');
const OUT='C:/Users/roger/AppData/Local/Temp/claude/C--Users-roger-MagicalStory/53ca16ce-9e51-4b2f-a36b-c324ee59638f/scratchpad';
(async()=>{
const p=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});
const e=await p.query(`select id,label,results from testlab_experiments where label like 'P-2 REDO%' order by id desc limit 1`);
await p.end();
const L=e.rows[0].results[0];
console.log('exp #'+e.rows[0].id);
console.log('loadedFrom:',JSON.stringify(L.loadedFrom));
console.log('backend:',L.detectionBackend);
console.log('identity:',JSON.stringify(L.identity?.answers),' method:',L.identity?.method);
console.log('figures:');
for(const f of (L.figures||[])) console.log(`  ${String(f.name).padEnd(8)} seeds=${f.garmentSeeds??'-'} maskPx=${f.maskPx??'-'} ${(f.seedTrace||[]).map(x=>x.at?`${x.colour}@${x.at}`:`${x.colour||''}:${(x.none||'').slice(0,28)}`).join(' | ')}`);
const st=(L.steps||[]).find(s=>/CUT-OUTS/.test(s.label));
if(st){
  const url=`https://images.magicalstory.ch/stories/job_1787120984020_pg71z58ba9/tl_step/p-2/v${st.versionIndex}.jpg`;
  const b=Buffer.from(await (await fetch(url)).arrayBuffer());
  await sharp(b).resize({width:1400}).jpeg({quality:88}).toFile(`${OUT}/p2_redo_cutouts.jpg`);
  console.log('saved p2_redo_cutouts.jpg');
}
process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1)});
