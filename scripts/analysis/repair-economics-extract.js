// Read-only extract for the repair-economics analysis. Usage: node repair-economics-extract.js staging|prod out.json
require('dotenv').config();
const {Pool}=require('pg');
const env=process.argv[2]||'staging';
const cs=env==='prod'?process.env.DATABASE_URL:process.env.STAGING_DATABASE_URL;
const p=new Pool({connectionString:cs,ssl:{rejectUnauthorized:false}});
const slim=(f)=>({n:f.name||null,t:f.type,s:f.severity,src:f.sources||f.source,d:(f.description||'').slice(0,200),cf:!!f.chargedFromChild,ap:!!f.alsoInParent});
function vslim(v,i){
  const dd=v.deductions||{};const buckets={};
  for(const k of Object.keys(dd)) if(Array.isArray(dd[k])) buckets[k]=dd[k].map(slim);
  return {i,src:v.source,type:v.type,fs:v.finalScore,ev:v.evalScore,ne:false,neR:(Array.isArray(v.notEvaluated)?v.notEvaluated:[]).map(x=>x.reason),parent:v.parentSource,b:buckets,
    plan:v.repairPlan?{req:v.repairPlan.scene_fix&&v.repairPlan.scene_fix.requires_regeneration,sf:v.repairPlan.scene_fix?{types:v.repairPlan.scene_fix.types,sev:v.repairPlan.scene_fix.severity}:null,
      dropped:(v.repairPlan.dropped_issues||[]).map(x=>x.reason||x).slice(0,10)}:null,
    ft:(v.fixTargets||[]).map(x=>({t:x.type,s:x.severity,m:x.matchMethod})),
    sb:v.scoreBreakdown?Object.fromEntries(Object.entries(v.scoreBreakdown).map(([k,x])=>[k,x&&x.score])):null,
    pen:v.entityPenalty,model:v.modelId,method:v.method,inst:(v.inpaintInstruction||'').slice(0,300)};
}
(async()=>{
 const r=await p.query(`select id, created_at::text ca, data->>'title' title, data from stories where created_at> now()-interval '50 days' and (data->>'isPartial') is distinct from 'true' and jsonb_array_length(coalesce(data->'sceneImages','[]'::jsonb))>=8 order by created_at`);
 const out=[];
 for(const row of r.rows){const d=row.data;
  const pages=(d.sceneImages||[]).map(si=>({pn:si.pageNumber,best:si.bestSource,fs:si.finalScore,unrep:si.unrepairedCritical,v:(si.imageVersions||[]).map(vslim)}));
  const covers={};for(const [k,c] of Object.entries(d.coverImages||{})){if(c&&c.imageVersions)covers[k]={best:c.bestSource,fs:c.finalScore,v:c.imageVersions.map(vslim)};}
  const tu=d.tokenUsage||{};
  out.push({id:row.id,ca:row.ca,title:row.title,tier:d.trialMode?'trial':'full',lang:d.language,pages,covers,byFn:tu.byFunction||{},tot:{grok:tu.grok&&tu.grok.cost,an:tu.anthropic&&tu.anthropic.cost,gem:(tu.gemini_image||tu.gemini||{}).cost,total:tu.totalCost||tu.total},tuKeys:Object.keys(tu),rm:d.runMetrics});
 }
 require('fs').writeFileSync(process.argv[3],JSON.stringify(out));
 console.log(env,out.length,'stories');await p.end();})().catch(e=>{console.error(e.message);process.exit(1)});
