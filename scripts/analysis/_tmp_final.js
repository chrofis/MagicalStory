require('dotenv').config();
const {Pool}=require('pg');const sharp=require('sharp');
const OUT='C:/Users/roger/AppData/Local/Temp/claude/C--Users-roger-MagicalStory/53ca16ce-9e51-4b2f-a36b-c324ee59638f/scratchpad';
(async()=>{
const p=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});
const e=await p.query(`select id,targets,results from testlab_experiments where label like 'FINAL VERIFY%' order by id desc limit 1`);
await p.end();
console.log('exp #'+e.rows[0].id);
const tiles=[];
for(let i=0;i<e.rows[0].targets.length;i++){
  const t=e.rows[0].targets[i], L=e.rows[0].results[i];
  const short=t.storyId.slice(-9);
  console.log(`\n=== ${short} p${t.pageNumber}`);
  console.log('  loadedFrom:',JSON.stringify(L.loadedFrom),' backend:',L.detectionBackend);
  const id=L.identity||{};
  console.log('  identity:',id.method,JSON.stringify(id.answers||{}),id.somFailure?('FAIL:'+id.somFailure):'');
  for(const f of (L.figures||[])) console.log(`    ${String(f.name).padEnd(9)} seeds=${f.garmentSeeds??'-'} maskPx=${f.maskPx??'-'}`);
  const lines=(L.logLines||[]).concat(L.logWarnings||[]);
  for(const l of lines) if(/MERGE|second opinion|FELL BACK|loaded active/i.test(l)) console.log('    LOG:',String(l).slice(0,130));
  const st=(L.steps||[]).find(s=>/CUT-OUTS/.test(s.label));
  if(st){
    const key=t.pageNumber<0?({'-1':'frontCover','-2':'initialPage','-3':'backCover'})[String(t.pageNumber)]:null;
    const url=`https://images.magicalstory.ch/stories/${t.storyId}/tl_step/p${t.pageNumber}/v${st.versionIndex}.jpg`;
    try{
      const b=Buffer.from(await (await fetch(url)).arrayBuffer());
      const tl=await sharp(b).resize({height:300}).jpeg({quality:84}).toBuffer();
      tiles.push({t:tl,w:(await sharp(tl).metadata()).width,label:`${short} p${t.pageNumber}`});
    }catch(err){console.log('    (cutout fetch failed)');}
  }
}
if(tiles.length){
  const GAP=8,H=344,W=tiles.reduce((s,x)=>s+x.w,0)+GAP*(tiles.length+1);
  const svg=[`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><rect width="${W}" height="${H}" fill="#14161a"/>`];
  let c=GAP;const comps=[];
  for(const x of tiles){comps.push({input:x.t,left:c,top:GAP});svg.push(`<text x="${c+4}" y="${H-10}" font-family="Arial" font-size="16" font-weight="bold" fill="#fff">${x.label}</text>`);c+=x.w+GAP;}
  svg.push('</svg>');
  await sharp(await sharp(Buffer.from(svg.join(''))).png().toBuffer()).composite(comps).jpeg({quality:85}).toFile(`${OUT}/final_cutouts.jpg`);
  console.log('\nsaved final_cutouts.jpg');
}
process.exit(0);
})().catch(e=>{console.error(e.stack);process.exit(1)});
