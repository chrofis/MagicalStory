#!/usr/bin/env node
require('dotenv').config();
const { Pool } = require('pg');
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const { rows } = await pool.query(`SELECT data->>'outline' as outline FROM stories WHERE id = $1`, [process.argv[2]]);
  if (!rows[0]?.outline) { console.error('no outline'); process.exit(1); }
  process.stdout.write(rows[0].outline);
  await pool.end();
})();
