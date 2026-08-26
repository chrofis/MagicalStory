#!/usr/bin/env node
require('dotenv').config();
const { Pool } = require('pg');
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const jobId = process.argv[2];
  const { rows } = await pool.query(
    `SELECT jsonb_object_keys(data) as key FROM stories WHERE id = $1`, [jobId]
  );
  console.log('top-level data keys:', rows.map(r => r.key).sort());
  const { rows: r2 } = await pool.query(
    `SELECT data->>'outline' as outline, data->>'rawOutline' as "rawOutline", data->>'unifiedOutput' as unified, data->>'storyDraft' as draft FROM stories WHERE id = $1`, [jobId]
  );
  for (const [k, v] of Object.entries(r2[0] || {})) {
    console.log(`\n[${k}] len=${(v||'').length}`);
    if (v) console.log(v.slice(0, 500));
  }
  await pool.end();
})();
