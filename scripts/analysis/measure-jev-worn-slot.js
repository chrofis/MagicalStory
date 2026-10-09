// Measurement 2026-10-09 (docs/decisions.md 'prose-meaning sites measured'). Paid: Jev ~USD 0.002. Reads stored staging data.
const PATH_ = require('path'); const R = PATH_.join(__dirname, '../..') + '/';
require('../../node_modules/dotenv').config({path:R+'.env'});
const {Pool}=require('../../node_modules/pg');const W=require(R+'server/lib/wornItems');const J=require(R+'server/lib/jevDecisions');
(async()=>{
 const pool=new Pool({connectionString:process.env.STAGING_DATABASE_URL,ssl:{rejectUnauthorized:false}});
 const rows=(await pool.query("select id, data->'visualBible' as vb from stories where data ? 'visualBible' order by created_at desc limit 300")).rows;
 const seen=new Map();
 for(const r of rows){const vb=r.vb||{};for(const s of ['artifacts','clothing','animals','secondaryCharacters','locations','vehicles'])for(const e of (Array.isArray(vb[s])?vb[s]:[])){
  const link=W.parseWornAs(e.wornAs);if(link&&link.slotKnown)continue;if(W.slotFromType(e.type))continue;const g=W.deriveSlotFromName(e.label||e.name);if(!g)continue;
  const nm=e.label||e.name;if(!seen.has(nm))seen.set(nm,{name:nm,section:s,type:e.type,desc:String(e.description||e.extractedDescription||'').slice(0,160),code:g});}}
 const items=[...seen.values()];
 const slots=W.WORN_SLOTS;
 const reqs=items.map((it,i)=>({key:'i'+i,state:`${it.name}: ${it.desc}`,questions:{Q:{type:'choice',instructions:`Which part of the body's outfit is "${it.name}" worn on, in the story?`,criteria:Object.fromEntries([...slots.map((s,k)=>['s'+k,s==='accessories'?'accessories (a scarf, gloves, glasses, jewellery, a bag or backpack worn on the body)':s]),['s'+slots.length,'not worn on the body: a prop, a tool, a rope, or an object that only hangs or lies somewhere']])}}}));
 const stats={calls:0,cost:0,ms:[],retries:0,failed:0,errors:[]};
 const ans=await J.runJevRequests(reqs,{stats,usageLabel:'jev_slot_measure'});
 const opts=[...slots,'NOT WORN'];
 items.forEach((it,i)=>{const q=((ans.get('i'+i)||[])[0]||{}).Q;const pr=q&&q.probabilities||{};let best=null,bp=-1;for(const k in pr)if(pr[k]>bp){bp=pr[k];best=k;}it.jev=best?opts[Number(best.slice(1))]:null;});
 console.log('cost',stats.cost,'items',items.length);
 for(const it of items)console.log(`${it.code===it.jev?'=':'X'} ${it.name} [${it.section}/${it.type}] code=${it.code} jev=${it.jev} :: ${it.desc.slice(0,70)}`);
 await pool.end();
})().catch(e=>{console.error(e);process.exit(1)});
