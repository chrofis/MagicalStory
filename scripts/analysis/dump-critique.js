#!/usr/bin/env node
// Dump the raw outline checkpoint (story-unified.txt output, includes critique)
// Usage: node scripts/analysis/dump-critique.js <jobId>
require('dotenv').config();
const { Pool } = require('pg');

const jobId = process.argv[2];
if (!jobId) { console.error('usage: dump-critique.js <jobId>'); process.exit(1); }

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const { rows } = await pool.query(
    `SELECT step_data FROM story_job_checkpoints WHERE job_id = $1 AND step_name = 'outline'`,
    [jobId]
  );
  await pool.end();
  if (!rows.length) { console.error('no outline checkpoint'); process.exit(1); }
  const outline = rows[0].step_data.outline || '';
  process.stdout.write(outline);
})().catch(e => { console.error(e); process.exit(1); });
