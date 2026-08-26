#!/usr/bin/env node
require('dotenv').config();
const { Pool } = require('pg');
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const jobId = process.argv[2];
  const which = process.argv[3] || 'all'; // 'fc'|'ip'|'bc'|'p1'|'all'
  const { rows } = await pool.query(`SELECT data FROM stories WHERE id = $1`, [jobId]);
  if (!rows.length) { console.log('NOT FOUND'); process.exit(1); }
  const d = rows[0].data;

  function dump(label, obj) {
    if (!obj) return;
    console.log(`\n========== ${label} ==========`);
    console.log('modelId:', obj.modelId, '| qualityScore:', obj.qualityScore, '| semanticScore:', obj.semanticScore);
    console.log('versions:', obj.imageVersions?.length, '| activeVersion:', obj.activeVersion ?? obj.activeVersionIndex);
    console.log('--- FULL PROMPT ---');
    console.log(obj.prompt);
    console.log('--- END PROMPT ---');
  }

  if (which === 'all' || which === 'fc') dump('frontCover', d.coverImages?.frontCover);
  if (which === 'all' || which === 'ip') dump('initialPage', d.coverImages?.initialPage);
  if (which === 'all' || which === 'bc') dump('backCover', d.coverImages?.backCover);
  if (which === 'all' || which === 'p1') dump('sceneImages[0] (page 1)', (d.sceneImages || [])[0]);

  await pool.end();
})();
