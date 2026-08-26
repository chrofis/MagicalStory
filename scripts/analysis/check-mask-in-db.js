#!/usr/bin/env node
require('dotenv').config();
const { Pool } = require('pg');
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const { rows } = await pool.query(
    `SELECT jsonb_array_elements(data->'sceneImages')->>'pageNumber' as page,
            length(jsonb_array_elements(data->'sceneImages')->>'textAreaMask') as mask_len,
            jsonb_array_elements(data->'sceneImages')->>'emptyScenePrompt' is not null as has_empty_prompt
     FROM stories WHERE id = $1
     ORDER BY (jsonb_array_elements(data->'sceneImages')->>'pageNumber')::int`,
    [process.argv[2]]
  );
  console.table(rows);
  await pool.end();
})();
