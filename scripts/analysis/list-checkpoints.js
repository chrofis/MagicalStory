#!/usr/bin/env node
require('dotenv').config();
const { Pool } = require('pg');
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const { rows } = await pool.query(
    `SELECT step_name, step_index, length(step_data::text) as bytes FROM story_job_checkpoints WHERE job_id = $1 ORDER BY step_name, step_index`,
    [process.argv[2]]
  );
  console.table(rows);
  await pool.end();
})();
