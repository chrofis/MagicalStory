require('dotenv').config();
const { Pool } = require('pg');
(async () => {
  const storyId = process.argv[2] || 'job_1776613729106_a9fpjw3cy';
  const pool = new Pool({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const r = await pool.query(
    `SELECT c->>'name' AS name,
            c->>'age' AS age,
            c->'physical'->>'description' AS phys_desc,
            c->>'description' AS top_desc,
            (SELECT jsonb_agg(k) FROM jsonb_object_keys(c) k) AS keys,
            (SELECT jsonb_agg(k) FROM jsonb_object_keys(c->'physical') k) AS phys_keys
     FROM stories, jsonb_array_elements(data::jsonb->'characters') AS c
     WHERE id=$1`,
    [storyId]
  );
  for (const row of r.rows) {
    console.log(`\n=== ${row.name} ===`);
    console.log(`age: ${row.age}`);
    console.log(`physical.description: ${row.phys_desc}`);
    console.log(`top description: ${row.top_desc}`);
    console.log(`character keys: ${row.keys}`);
    console.log(`physical keys: ${row.phys_keys}`);
  }
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
