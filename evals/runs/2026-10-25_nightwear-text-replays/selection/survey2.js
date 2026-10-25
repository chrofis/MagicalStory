require('dotenv').config();
const { Pool } = require('pg');
(async () => {
  const out = [];
  for (const [env, url] of [['staging', process.env.STAGING_DATABASE_URL], ['prod', process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL]]) {
    const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
    const r = await pool.query(`SELECT id, created_at, data->>'title' AS title, data->>'language' AS lang, data->>'storyTopic' AS topic,
      data->'beatsReviewReport'->'briefsIn' AS bi, jsonb_array_length(data->'sceneImages') AS np,
      (SELECT count(*) FROM jsonb_object_keys(coalesce(data->'clothingRequirements','{}'::jsonb))) AS ncr
      FROM stories WHERE data->'beatsReviewReport'->'briefsIn' IS NOT NULL ORDER BY created_at DESC LIMIT 400`);
    for (const x of r.rows) {
      const plans = (x.bi || []).map(b => ({ p: b.pageNumber, t: ((String(b.brief||'').match(/PLAN:\s*([\s\S]*)$/i)||[])[1]||'').trim() }));
      const re = /\b(bed|beds|bett|betten|pyjama|pajama|schlafanzug|sleepover|sleeps|sleeping|schl[aä]ft|schlafen|lit|dors|dort|cama)\b|ins bett|unter(?:\s+der)?\s+decke|tucked|gute nacht|good night|nightgown|nachthemd/i;
      const hits = plans.filter(p => re.test(p.t)).map(p => p.p);
      out.push({ env, id: x.id, created: x.created_at, title: x.title, lang: x.lang, topic: x.topic, np: x.np, ncr: +x.ncr, bedPages: hits });
    }
    await pool.end();
  }
  require('fs').writeFileSync(__dirname + '/survey2.json', JSON.stringify(out, null, 1));
  const pos = out.filter(o => o.bedPages.length && o.ncr);
  console.log('with bed hits', pos.length, 'of', out.length);
  pos.forEach(o => console.log(o.env, o.id, o.topic, o.lang, o.np, 'bed:', o.bedPages.join(','), '|', o.title));
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
