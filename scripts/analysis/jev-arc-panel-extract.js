#!/usr/bin/env node
// Extract stored arc-panel reports from staging into the run folder (gitignored story text).
require('dotenv').config();
const fs = require('fs'), path = require('path');
const { Pool } = require('pg');
const OUT = path.join(__dirname, '../../evals/runs/2026-10-09_jev-arc-panel');
(async () => {
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const { rows } = await pool.query(`select id, data->'arcReviewReport' as r, data->'inputData' as inp from stories where data->'arcReviewReport'->'rounds' is not null and jsonb_array_length(data->'arcReviewReport'->'rounds')>0 order by created_at desc limit 40`);
  fs.mkdirSync(OUT, { recursive: true });
  const books = rows.map(x => ({ id: x.id, report: x.r, inputData: x.inp }));
  fs.writeFileSync(path.join(OUT, 'books.json'), JSON.stringify(books));
  console.log(rows.length, 'books; with panel:', books.filter(b => b.report.rounds.some(r => (r.panel || []).length)).length);
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
