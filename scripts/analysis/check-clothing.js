require('dotenv').config();
const { Pool } = require('pg');
(async () => {
  const storyId = process.argv[2] || 'job_1776628044048_sqmael4kp';
  const name = process.argv[3] || 'Roger';
  const pool = new Pool({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const r = await pool.query(
    `SELECT c->'clothing' AS clothing, c->'structuredClothing' AS sc
     FROM stories, jsonb_array_elements(data::jsonb->'characters') AS c
     WHERE id=$1 AND c->>'name'=$2`,
    [storyId, name]
  );
  for (const row of r.rows) {
    console.log('clothing:', JSON.stringify(row.clothing, null, 2));
    console.log('\nstructuredClothing:', JSON.stringify(row.sc, null, 2));
  }
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
