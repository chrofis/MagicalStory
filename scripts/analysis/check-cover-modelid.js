#!/usr/bin/env node
require('dotenv').config();
const { Pool } = require('pg');
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const jobId = process.argv[2];
  const { rows } = await pool.query(`SELECT data FROM stories WHERE id = $1`, [jobId]);
  const d = rows[0].data;
  console.log('=== tokenUsage.byFunction.cover_images ===');
  console.log(JSON.stringify(d.tokenUsage?.byFunction?.cover_images, null, 2));
  console.log('\n=== tokenUsage.grok ===');
  console.log(JSON.stringify(d.tokenUsage?.grok, null, 2));
  console.log('\n=== ALL byFunction keys with cover-related ===');
  Object.entries(d.tokenUsage?.byFunction || {}).forEach(([k, v]) => {
    if (/cover/i.test(k) || (v.calls > 0)) {
      console.log(`${k}: calls=${v.calls} direct_cost=${v.direct_cost} models=${JSON.stringify(v.models)}`);
    }
  });
  await pool.end();
})();
