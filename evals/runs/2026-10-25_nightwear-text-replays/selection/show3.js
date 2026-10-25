require('dotenv').config();
const { Pool } = require('pg');
const re=/(pyjama|pajama|schlafanzug|nachthemd|im bett|ins bett|in bed|in his bed|in her bed|dans son lit|au lit|nel letto|a letto|sleepover|übernachtung|pillow|kissen|oreiller)/ig;
(async()=>{for(const [env,url] of [['staging',process.env.STAGING_DATABASE_URL],['prod',process.env.DATABASE_PUBLIC_URL||process.env.DATABASE_URL]]){
 const pool=new Pool({connectionString:url,ssl:{rejectUnauthorized:false}});
 const r=await pool.query(`SELECT id,data->>'title' t,data->>'storyText' s, data->>'language' l, jsonb_array_length(data->'sceneImages') np, jsonb_typeof(data->'clothingRequirements') cr FROM stories WHERE data->>'storyText' ~* '(pyjama|pajama|schlafanzug|nachthemd|im bett|ins bett|in bed|in his bed|in her bed|dans son lit|au lit|nel letto|a letto|sleepover|übernachtung|pillow|kissen|oreiller)' AND data->'beatsReviewReport'->'briefsIn' IS NULL`);
 for(const x of r.rows){ console.log('\n##',env,x.id,x.t,x.l,'pages',x.np,'cr',x.cr); let m,n=0; const s=x.s||''; re.lastIndex=0; while((m=re.exec(s))&&n<3){n++; console.log('   ...'+s.slice(Math.max(0,m.index-120),m.index+120).replace(/\s+/g,' ')+'...');} }
 await pool.end();}})();
