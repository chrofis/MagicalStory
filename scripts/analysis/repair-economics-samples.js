// Pick ~5 pages per top failure type (seeded), print finding text, download original scene image for visual review.
// Read-only. Usage: node repair-economics-samples.js stg.json outDir samples.json
require('dotenv').config();
const fs=require('fs'),path=require('path'),https=require('https');
const {Pool}=require('pg');
const [,, stgF,outDir,outJson]=process.argv;
const stg=JSON.parse(fs.readFileSync(stgF));
let seed=20261009;const rnd=()=>{seed=(seed*1664525+1013904223)%4294967296;return seed/4294967296;};
const shuffle=a=>{for(let i=a.length-1;i>0;i--){const j=Math.floor(rnd()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;};
const cls=d=>/gaze|look|eye|stare|glanc|watch|facing|face |faces|turn/i.test(d)?'gaze/facing':/hold|grip|carry|hand|grasp|clutch|lift|reach|touch|pull|push/i.test(d)?'hold/hands':'posture/other';
const TYPES=[['action_interaction','gaze/facing'],['action_interaction','hold/hands'],['action_interaction','posture/other'],['object_presence'],['clothing'],['character_identity'],['setting'],['missing_element']];
const cand={};
for(const s of stg){for(const p of s.pages){const v=p.v[0];if(!v||v.src!=='original')continue;const repaired=p.v.some(x=>/^(iterate|inpaint|char-fix)/.test(x.src||''));if(!repaired)continue;
 for(const f of v.b.consolidated||[]){if(!['major','critical'].includes(f.s))continue;let key=f.t;if(f.t==='action_interaction')key+='|'+cls(f.d);(cand[key]=cand[key]||[]).push({story:s.id,pn:p.pn,t:f.t,sev:f.s,name:f.n,d:f.d,src:f.src,best:p.best,fs0:v.fs,nv:p.v.length,sub:key.split('|')[1]||null});}}}
const pool=new Pool({connectionString:process.env.STAGING_DATABASE_URL,ssl:{rejectUnauthorized:false}});
const get=(u,f)=>new Promise((res,rej)=>https.get(u,r=>{if(r.statusCode!==200){rej(new Error(u+' '+r.statusCode));return;}const w=fs.createWriteStream(f);r.pipe(w);w.on('finish',()=>res());}).on('error',rej));
(async()=>{
 fs.mkdirSync(outDir,{recursive:true});const out=[];
 for(const T of TYPES){const key=T.length>1?T.join('|'):T[0];const list=shuffle([...(cand[key]||[])]);const used=new Set();const pick=[];
  for(const c of list){if(used.has(c.story))continue;used.add(c.story);pick.push(c);if(pick.length>=(T.length>1?4:5))break;}
  for(const c of pick){const r=await pool.query(`select image_url from story_images where story_id=$1 and image_type='scene' and page_number=$2 and version_index=0 limit 1`,[c.story,c.pn]);
   if(!r.rows.length){c.file=null;out.push(c);continue;}c.url=r.rows[0].image_url;c.file=path.join(outDir,`${key.replace(/[^a-z]/gi,'_')}_${c.story.slice(-9)}_p${c.pn}.jpg`);
   try{await get(c.url,c.file);}catch(e){c.file=null;c.err=e.message;}out.push({...c,key});}}
 fs.writeFileSync(outJson,JSON.stringify(out,null,1));
 for(const c of out)console.log(c.key,'|',c.sev,c.story.slice(-9),'p'+c.pn,'|',c.d,'|',c.file||c.err);
 await pool.end();})().catch(e=>{console.error(e.message);process.exit(1)});
