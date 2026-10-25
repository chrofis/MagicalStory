// Read-only survey of stored stories for the nightwear text replays (SELECT only).
require('dotenv').config();
const { Pool } = require('pg');
(async () => {
  const out = [];
  for (const [env, url] of [['staging', process.env.STAGING_DATABASE_URL], ['prod', process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL]]) {
    if (!url) { console.log('no url', env); continue; }
    const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
    const r = await pool.query(`SELECT id, created_at, length(data::text) AS len,
      data->>'title' AS title, data->>'language' AS lang, data->>'storyCategory' AS cat, data->>'storyTopic' AS topic,
      jsonb_typeof(data->'clothingRequirements') AS cr, jsonb_typeof(data->'beatsReviewReport'->'briefsIn') AS bi,
      data->>'pages' AS pages, (data->'replayInputsStored') AS rip
      FROM stories WHERE data->'beatsReviewReport'->'briefsIn' IS NOT NULL ORDER BY created_at DESC LIMIT 400`);
    for (const x of r.rows) out.push({ env, ...x });
    await pool.end();
  }
  require('fs').writeFileSync(__dirname + '/survey.json', JSON.stringify(out, null, 1));
  console.log(out.length);
  const cnt = {}; out.forEach(o => { const k = o.env + '/' + o.cat + '/' + o.topic; cnt[k] = (cnt[k] || 0) + 1; });
  console.log(cnt);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
