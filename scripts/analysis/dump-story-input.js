#!/usr/bin/env node
require('dotenv').config();
const { Pool } = require('pg');
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const { rows } = await pool.query(
    `SELECT
       data->>'storyTopic' as topic,
       data->>'storyDetails' as details,
       data->>'storyType' as type,
       data->>'storyTypeName' as typeName,
       data->>'storyTheme' as theme,
       data->>'storyCategory' as category,
       data->>'title' as title
     FROM stories WHERE id = $1`, [process.argv[2]]
  );
  for (const [k, v] of Object.entries(rows[0] || {})) {
    console.log(`\n=== ${k} ===`);
    console.log(v || '(empty)');
  }
  await pool.end();
})();
