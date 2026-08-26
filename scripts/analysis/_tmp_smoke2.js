require('dotenv').config();
const {Pool}=require('pg');const sharp=require('sharp');
const OUT='C:/Users/roger/AppData/Local/Temp/claude/C--Users-roger-MagicalStory/53ca16ce-9e51-4b2f-a36b-c324ee59638f/scratchpad';
const SID='job_1787252581387_6sn8z0nh2';
(async()=>{
const p=new Pool({connectionString:process.env.STAGING_DATABASE_URL,ssl:{rejectUnauthorized:false}});
const r=await p.query('select data from stories where id=$1',[SID]);
const u=await p.query(`select image_type,page_number,version_index,image_url from story_images
  where story_id=$1 and is_test=false and image_type in ('scene','frontCover','initialPage','backCover') order by image_type,page_number,version_index`,[SID]);
await p.end();
const d=r.rows[0].data;
console.log('title:',d.title,' | runMetrics:',JSON.stringify(d.runMetrics));
console.log('\n=== PAGES ===');
for(const s of (d.sceneImages||[])){
  const b=s.bboxDetection||{};
  const id=b.gdinoDiag?.identity||{};
  console.log(`p${s.pageNumber}: det=${b.detectionBackend||'NULL'} fp=${b.sourceImageFp?b.sourceImageFp.slice(0,8):'MISSING'} identity=${id.method||'-'}${id.somFailure?' FAIL:'+String(id.somFailure).slice(0,60):''} score=${s.finalScore} versions=${(s.imageVersions||[]).length}`);
  for(const f of (b.figures||[])) console.log(`    ${String(f.name).padEnd(7)} seeds=${f.garmentSeeds??'-'} maskPx=${f.maskPx??'-'}`);
}
console.log('\n=== COVERS ===');
for(const [k,v] of Object.entries(d.coverImages||{})){
  const b=v.bboxDetection||{};
  const id=b.gdinoDiag?.identity||{};
  console.log(`${k}: det=${b.detectionBackend||'NULL'} fp=${b.sourceImageFp?'set':'MISSING'} identity=${id.method||'-'}${id.somFailure?' FAIL:'+String(id.somFailure).slice(0,50):''} figures=${(b.figures||[]).map(f=>`${f.name}:${f.garmentSeeds??'-'}`).join(', ')}`);
}
// final images strip
const latest={};
for(const x of u.rows){const k=x.image_type==='scene'?`p${x.page_number}`:x.image_type;
  if(!latest[k]||x.version_index>latest[k].version_index) latest[k]=x;}
const order=['frontCover','initialPage','p1','p2','p3','p4','backCover'];
const tiles=[];
for(const k of order){const x=latest[k];if(!x)continue;
  try{const b=Buffer.from(await (await fetch(x.image_url)).arrayBuffer());
  const t=await sharp(b).resize({height:400}).jpeg({quality:85}).toBuffer();
  tiles.push({t,w:(await sharp(t).metadata()).width,label:k+' v'+x.version_index});}catch(e){console.log('fetch fail',k);}}
const GAP=8,H=448,W=tiles.reduce((s,x)=>s+x.w,0)+GAP*(tiles.length+1);
const svg=[`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><rect width="${W}" height="${H}" fill="#14161a"/>`];
let c=GAP;const comps=[];
for(const x of tiles){comps.push({input:x.t,left:c,top:GAP});svg.push(`<text x="${c+4}" y="${H-12}" font-family="Arial" font-size="17" font-weight="bold" fill="#fff">${x.label}</text>`);c+=x.w+GAP;}
svg.push('</svg>');
await sharp(await sharp(Buffer.from(svg.join(''))).png().toBuffer()).composite(comps).jpeg({quality:86}).toFile(`${OUT}/smoke2_all.jpg`);
console.log('\nsaved smoke2_all.jpg');
process.exit(0);
})().catch(e=>{console.error(e.stack);process.exit(1)});
