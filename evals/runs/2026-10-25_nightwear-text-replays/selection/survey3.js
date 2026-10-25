require('dotenv').config();
const { Pool } = require('pg');
(async () => {
 for (const [env,url] of [['staging',process.env.STAGING_DATABASE_URL],['prod',process.env.DATABASE_PUBLIC_URL||process.env.DATABASE_URL]]){
  const pool=new Pool({connectionString:url,ssl:{rejectUnauthorized:false}});
  const t=await pool.query(`SELECT data->>'storyTopic' AS topic, (data->'beatsReviewReport'->'briefsIn') IS NOT NULL AS hasbi, count(*) FROM stories WHERE data->>'storyTopic' ~* 'bed|sleep|night|schlaf' GROUP BY 1,2`);
  console.log(env,'topics',JSON.stringify(t.rows));
  const r=await pool.query(`SELECT id, data->>'title' AS title, data->>'storyTopic' AS topic, data->'beatsReviewReport'->'briefsIn' AS bi, jsonb_typeof(data->'clothingRequirements') cr FROM stories WHERE data->'beatsReviewReport'->'briefsIn' IS NOT NULL`);
  const re=/\b(duvet|pillow|bedroom|sleepover|pyjama|pajama|nightgown|nachthemd|schlafanzug|schlafzimmer|kopfkissen|bettdecke|ins bett|im bett|in bed|in her bed|in his bed|chambre|couette|oreiller|au lit|dans son lit|dans son lit|lies in|asleep|schl[aä]ft|eingeschlafen|endormi|dort|tucked in|zugedeckt|camera da letto|a letto|letto)\b/i;
  for(const x of r.rows){ const hits=(x.bi||[]).filter(b=>re.test(((String(b.brief||'').match(/PLAN:\s*([\s\S]*)$/i)||[])[1]||''))).map(b=>b.pageNumber); if(hits.length) console.log(env,x.id,x.topic,x.title,hits.join(',')); }
  await pool.end();
 }
})();
