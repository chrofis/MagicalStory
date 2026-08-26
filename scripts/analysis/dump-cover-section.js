#!/usr/bin/env node
require('dotenv').config();
const { Pool } = require('pg');
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const jobId = process.argv[2];
  const { rows } = await pool.query(`SELECT data FROM stories WHERE id = $1`, [jobId]);
  const o = rows[0].data.outline || '';
  const m = o.match(/---COVER SCENE HINTS---([\s\S]*?)(?=---STORY PAGES---|---SCENE PLAN---|$)/i);
  console.log(m ? m[0] : '(no COVER SCENE HINTS section found in outline)');
  await pool.end();
})();
