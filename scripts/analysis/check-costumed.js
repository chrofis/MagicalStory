require('dotenv').config();
const { Pool } = require('pg');
(async () => {
  const storyId = process.argv[2] || 'job_1776628044048_sqmael4kp';
  const name = process.argv[3] || 'Roger';
  const pool = new Pool({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const r = await pool.query(
    `SELECT (SELECT jsonb_agg(k) FROM jsonb_object_keys(c) k) AS top_keys,
            (SELECT jsonb_agg(k) FROM jsonb_object_keys(c->'structuredClothing') k) AS sc_keys,
            c->'structuredClothing'->'costumed' AS costumed,
            (SELECT jsonb_agg(k) FROM jsonb_object_keys(c->'avatars') k) AS avatar_keys
     FROM stories, jsonb_array_elements(data::jsonb->'characters') AS c
     WHERE id=$1 AND c->>'name'=$2`,
    [storyId, name]
  );
  for (const row of r.rows) {
    console.log('top keys:', row.top_keys);
    console.log('structuredClothing keys:', row.sc_keys);
    console.log('costumed:', JSON.stringify(row.costumed, null, 2));
    console.log('avatar keys:', row.avatar_keys);
  }
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
