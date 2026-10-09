#!/usr/bin/env node
// Extract stored staging TRIAL stories (trialMode) for the Jev review (2026-10-09) into evals/runs/2026-10-09_jev-review/trials.json
require('dotenv').config({path:require('path').join(__dirname,'../../.env')});
const {Pool}=require('pg'),fs=require('fs'),path=require('path');
const OUT=path.join(__dirname,'../../evals/runs/2026-10-09_jev-review');
(async()=>{
const pool=new Pool({connectionString:process.env.STAGING_DATABASE_URL,ssl:{rejectUnauthorized:false}});
const r=await pool.query(`SELECT id, created_at, data->>'language' lang, data->'trialMode' tm, data->'characters' ch, data->'pages' pages, data->'storyText' st, data->'sceneDescriptions' sd, data->'languageLevel' ll, data->'storyDetails' det, data->'mainCharacters' mc, data->'textRefineReport' t FROM stories WHERE data->>'trialMode' IN ('true') OR data->>'trialMode' = 'trial' ORDER BY created_at desc LIMIT 80`);
console.log(r.rows.length);
fs.writeFileSync(path.join(OUT,'trials_raw.json'),JSON.stringify(r.rows));
const x=r.rows[0];console.log(x&&x.id,x&&x.tm,typeof (x&&x.pages),JSON.stringify(x&&x.pages).slice(0,300),JSON.stringify(x&&x.ll),JSON.stringify(x&&x.mc).slice(0,400),JSON.stringify(x&&x.ch).slice(0,300));
await pool.end();})();
