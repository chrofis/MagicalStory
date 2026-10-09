// Measurement 2026-10-09 (docs/decisions.md 'prose-meaning sites measured'). Paid: Jev ~USD 0.002. Reads stored staging data.
const PATH_ = require('path'); const R = PATH_.join(__dirname, '../..') + '/';
require('../../node_modules/dotenv').config({path:R+'.env'});
const {Pool}=require('../../node_modules/pg');const C=require(R+'server/lib/clothingCheck');const J=require(R+'server/lib/jevDecisions');
const COL=['red','blue','green','yellow','orange','purple','brown','black','white','grey'];
(async()=>{
 const pool=new Pool({connectionString:process.env.STAGING_DATABASE_URL,ssl:{rejectUnauthorized:false}});
 const rows=(await pool.query("select id, data->'clothingRequirements' as cr from stories where data ? 'clothingRequirements' order by created_at desc limit 300")).rows;
 const cases=[];
 for(const r of rows){const cr=r.cr||{};for(const [who,v] of Object.entries(cr)){for(const cat of Object.keys(v||{})){const t=v[cat]&&(v[cat].signature&&v[cat].signature!=='none'?v[cat].signature:v[cat].description);if(typeof t!=='string')continue;
  const w=t.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  for(let i=0;i<w.length;i++){if(!C.GARMENT_NOUNS.has(w[i]))continue;cases.push({sid:r.id,who,text:t,noun:w[i],code:C.colourBefore(w,i)});}}}}
 // sample every k-th for ~90 cases
 const step=Math.max(1,Math.floor(cases.length/90));const s=cases.filter((_,i)=>i%step===0).slice(0,90);
 const reqs=s.map((c,i)=>({key:'c'+i,state:c.text,questions:{Q:{type:'choice',instructions:`The colour of the ${c.noun} in this outfit.`,criteria:Object.fromEntries([...COL.map((x,k)=>['s'+k,x]),['s'+COL.length,'no colour is stated for it']])}}}));
 const stats={calls:0,cost:0,ms:[],retries:0,failed:0,errors:[]};
 const ans=await J.runJevRequests(reqs,{stats,usageLabel:'jev_colour_measure'});
 const opts=[...COL,null];let agree=0;const dis=[];
 s.forEach((c,i)=>{const pr=(((ans.get('c'+i)||[])[0]||{}).Q||{}).probabilities||{};let b=null,bp=-1;for(const k in pr)if(pr[k]>bp){bp=pr[k];b=k;}c.jev=b?opts[Number(b.slice(1))]:'?';if(c.jev===c.code)agree++;else dis.push(c);});
 console.log('total garment mentions',cases.length,'sampled',s.length,'agree',agree,'cost',stats.cost);
 dis.forEach((c,k)=>console.log(`${k} noun=${c.noun} code=${c.code} jev=${c.jev} :: ${c.text.slice(0,200)}`));
 await pool.end();
})().catch(e=>{console.error(e);process.exit(1)});
