require('dotenv').config();
const { Pool } = require('pg');
(async () => {
 for (const [env,url] of [['staging',process.env.STAGING_DATABASE_URL],['prod',process.env.DATABASE_PUBLIC_URL||process.env.DATABASE_URL]]){
  const pool=new Pool({connectionString:url,ssl:{rejectUnauthorized:false}});
  const r=await pool.query(`SELECT id, created_at::date d, data->>'title' t, data->>'storyTopic' tp, (data->'beatsReviewReport'->'briefsIn') IS NOT NULL bi,
    (data->>'storyText') ~* '(pyjama|pajama|schlafanzug|nachthemd|im bett|ins bett|in bed|in his bed|in her bed|dans son lit|au lit|pyjama|nel letto|a letto|sleepover|übernachtung|pillow|kissen|oreiller)' hit
    FROM stories WHERE data->>'storyText' ~* '(pyjama|pajama|schlafanzug|nachthemd|im bett|ins bett|in bed|in his bed|in her bed|dans son lit|au lit|nel letto|a letto|sleepover|übernachtung|pillow|kissen|oreiller)' ORDER BY created_at DESC`);
  console.log(env, r.rows.length, 'with briefsIn:', r.rows.filter(x=>x.bi).length);
  r.rows.forEach(x=>console.log(' ',x.id,x.d.toISOString().slice(0,10),x.bi?'BI':'--',x.tp||'',x.t));
  await pool.end();
 }
})();
