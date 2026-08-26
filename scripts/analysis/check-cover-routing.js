#!/usr/bin/env node
require('dotenv').config();
const { Pool } = require('pg');
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const jobId = process.argv[2];
  const { rows } = await pool.query(`SELECT data FROM stories WHERE id = $1`, [jobId]);
  const d = rows[0].data;
  console.log('coverHints keys:', d.coverHints && Object.keys(d.coverHints));
  console.log('coverHints:', JSON.stringify(d.coverHints, null, 2).slice(0, 4000));
  console.log('\n--- generationLog (filter cover) ---');
  const log = (d.generationLog || []).filter(l => /cover|COVER|Cover/.test(JSON.stringify(l)));
  log.slice(0, 30).forEach(l => console.log(JSON.stringify(l).slice(0, 400)));
  await pool.end();
})();
