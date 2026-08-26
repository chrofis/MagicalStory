require('dotenv').config();
const {Pool}=require('pg');const sharp=require('sharp');
const OUT='C:/Users/roger/AppData/Local/Temp/claude/C--Users-roger-MagicalStory/53ca16ce-9e51-4b2f-a36b-c324ee59638f/scratchpad';
const SID='job_1787250416967_9owpz1j3b';
(async()=>{
const p=new Pool({connectionString:process.env.STAGING_DATABASE_URL,ssl:{rejectUnauthorized:false}});
const r=await p.query('select data from stories where id=$1',[SID]);
const u=await p.query(`select image_type,page_number,version_index,image_url from story_images
  where story_id=$1 and is_test=false order by image_type,page_number,version_index`,[SID]);
await p.end();
const d=r.rows[0].data;
console.log('title:',d.title);
console.log('\n=== PAGES ===');
for(const s of (d.sceneImages||[])){
  const b=s.bboxDetection||{};
  const vs=(s.imageVersions||[]);
  console.log(`p${s.pageNumber}: backend=${b.detectionBackend} identity=${b.gdinoDiag?.identity?.method} versions=${vs.length} score=${s.finalScore}`);
  for(const f of (b.figures||[])) console.log(`   ${String(f.name).padEnd(7)} seeds=${f.garmentSeeds??'-'} maskPx=${f.maskPx??'-'} fp=${b.sourceImageFp?'set':'MISSING'}`);
  vs.forEach((v,i)=>{
    const vb=v.bboxDetection||{};
    const carried=vb.gdinoDiag?.recolourCarried;
    console.log(`   v${i} ${v.source||v.type}: det=${vb.detectionBackend||'none'} fp=${vb.sourceImageFp?vb.sourceImageFp.slice(0,8):'MISSING'}${carried?' CARRIED-from-'+String(carried.fromFp||'?').slice(0,8):''}`);
  });
}
console.log('\n=== COVERS ===');
for(const [k,v] of Object.entries(d.coverImages||{})){
  const b=v.bboxDetection||{};
  console.log(`${k}: backend=${b.detectionBackend} figures=${(b.figures||[]).map(f=>`${f.name}:${f.garmentSeeds??'-'}`).join(', ')}`);
}
// final images
const finals=u.rows.filter(x=>x.image_type==='scene');
const covers=u.rows.filter(x=>['frontCover','initialPage','backCover'].includes(x.image_type));
const latest={};
for(const x of finals){latest[x.page_number]=x;}
const tiles=[];
for(const x of [...covers.filter(c=>c.version_index===Math.max(...covers.filter(y=>y.image_type===c.image_type).map(y=>y.version_index))), ...Object.values(latest)]){
  try{
    const b=Buffer.from(await (await fetch(x.image_url)).arrayBuffer());
    const t=await sharp(b).resize({height:420}).jpeg({quality:85}).toBuffer();
    tiles.push({t,w:(await sharp(t).metadata()).width,label:x.image_type==='scene'?`p${x.page_number} v${x.version_index}`:`${x.image_type} v${x.version_index}`});
  }catch(e){console.log('fetch fail',x.image_url.slice(-40),e.message);}
}
const GAP=8,H=470,W=tiles.reduce((s,x)=>s+x.w,0)+GAP*(tiles.length+1);
const svg=[`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><rect width="${W}" height="${H}" fill="#14161a"/>`];
let c=GAP;const comps=[];
for(const x of tiles){comps.push({input:x.t,left:c,top:GAP});svg.push(`<text x="${c+4}" y="${H-14}" font-family="Arial" font-size="18" font-weight="bold" fill="#fff">${x.label}</text>`);c+=x.w+GAP;}
svg.push('</svg>');
const canvas=await sharp(Buffer.from(svg.join(''))).png().toBuffer();
await sharp(canvas).composite(comps).jpeg({quality:86}).toFile(`${OUT}/smoke_all.jpg`);
console.log('\nsaved smoke_all.jpg ('+tiles.length+' tiles)');
process.exit(0);
})().catch(e=>{console.error(e.stack);process.exit(1)});
