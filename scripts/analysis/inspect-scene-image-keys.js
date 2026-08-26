#!/usr/bin/env node
require('dotenv').config();
const { Pool } = require('pg');
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const { rows } = await pool.query(
    `SELECT (data->'sceneImages'->0) as p1 FROM stories WHERE id = $1`,
    [process.argv[2]]
  );
  const p1 = rows[0]?.p1 || {};
  const keys = Object.keys(p1).sort();
  console.log(`page 1 keys (${keys.length}):`);
  for (const k of keys) {
    const v = p1[k];
    let preview = '';
    if (v == null) preview = 'null';
    else if (typeof v === 'string') preview = `"${v.slice(0, 40)}${v.length > 40 ? '...' : ''}" (len=${v.length})`;
    else if (Array.isArray(v)) preview = `array (${v.length})`;
    else if (typeof v === 'object') preview = `object (${Object.keys(v).length} keys)`;
    else preview = String(v);
    console.log(`  ${k}: ${preview}`);
  }
  await pool.end();
})();
