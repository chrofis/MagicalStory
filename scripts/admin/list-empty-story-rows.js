#!/usr/bin/env node
/**
 * READ-ONLY. Lists story rows that hold no story content (metadata has no id, i.e. upsertStory never
 * ran) together with their job status and image count. These are the rows ensureStoryRow created at
 * job start for jobs that ended cancelled/failed (hidden from the library by storyLibraryFilter.js);
 * cleanup of existing rows is the owner's call.
 *
 * Usage: node scripts/admin/list-empty-story-rows.js [--env=prod|staging]   (default: DATABASE_URL)
 *   prod    -> process.env.DATABASE_URL
 *   staging -> process.env.STAGING_DATABASE_URL
 */
require('dotenv').config();
const pg = require('pg');
const { ch, fromPgNaive } = require('../lib/chTime');
const arg = (process.argv.find(a => a.startsWith('--env=')) || '--env=prod').slice(6);
const url = arg === 'staging' ? process.env.STAGING_DATABASE_URL : process.env.DATABASE_URL;
if (!url) { console.error(`No database URL for env "${arg}"`); process.exit(1); }

(async () => {
  const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 1 });
  try {
    const { rows } = await pool.query(`
      SELECT s.id, s.user_id, s.created_at, j.status AS job_status,
             (SELECT COUNT(*) FROM story_images si WHERE si.story_id = s.id) AS images
      FROM stories s LEFT JOIN story_jobs j ON j.id = s.id
      WHERE s.metadata->>'id' IS NULL
      ORDER BY s.created_at DESC`);
    const by = {};
    for (const r of rows) by[r.job_status || 'no-job'] = (by[r.job_status || 'no-job'] || 0) + 1;
    console.log(`[${arg}] ${rows.length} story rows without saved content; by job status:`, JSON.stringify(by));
    for (const r of rows) console.log(`${r.id}  user=${r.user_id}  job=${r.job_status || '-'}  images=${r.images}  ${ch(fromPgNaive(r.created_at))}`);
  } finally { await pool.end(); }
})().catch(e => { console.error(e.message); process.exit(1); });
