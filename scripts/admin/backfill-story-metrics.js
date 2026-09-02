/**
 * Backfill story_metrics for recent completed non-test stories.
 * (Stats framework — docs/plans/story-stats-page.md, Task 4.)
 *
 * Usage:
 *   node scripts/admin/backfill-story-metrics.js                 # staging, last 10
 *   node scripts/admin/backfill-story-metrics.js --limit=25
 *   node scripts/admin/backfill-story-metrics.js --env=production
 *
 * --env=staging (default) uses STAGING_DATABASE_URL (falls back DATABASE_URL);
 * --env=production uses DATABASE_PUBLIC_URL || DATABASE_URL.
 * Runs the same collector the server calls at job completion, so C-counters
 * (data.runMetrics) are {} for stories generated before the recorder shipped —
 * expected per the plan.
 */
'use strict';

require('dotenv').config();
const { Pool } = require('pg');
const { collectStoryMetrics } = require('../../server/lib/storyMetrics');
const { ch } = require('../lib/chTime');

const args = process.argv.slice(2);
const getArg = (name, dflt) => {
  const a = args.find(x => x.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : dflt;
};

const env = getArg('env', 'staging');
const limit = Math.max(1, parseInt(getArg('limit', '10'), 10) || 10);

let connectionString;
if (env === 'staging') {
  // No fallback to DATABASE_URL: that would silently write environment='staging'
  // rows into the production database.
  connectionString = process.env.STAGING_DATABASE_URL;
  if (!connectionString) {
    console.error('--env=staging requires STAGING_DATABASE_URL to be set (no fallback to DATABASE_URL)');
    process.exit(1);
  }
} else if (env === 'production' || env === 'prod') {
  connectionString = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
} else {
  console.error(`Unknown --env=${env} (use staging|production)`);
  process.exit(1);
}
if (!connectionString) {
  console.error('No database URL found in .env for the requested environment');
  process.exit(1);
}

const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

async function main() {
  console.log(`[${ch(new Date())}] Backfilling story_metrics: env=${env}, limit=${limit}`);

  // Most recent completed, non-test, non-partial stories. "Completed" = a
  // story_jobs row with status='completed' (storyId === jobId in the unified
  // pipeline) — but story_jobs prunes old rows, so a story with NO job row
  // counts as completed too when it has pages and isn't a partial rescue.
  // A surviving failed/cancelled job row excludes the story.
  const rows = (await pool.query(
    `SELECT s.id, s.created_at, s.metadata->>'title' AS title, sj.status AS job_status
     FROM stories s
     LEFT JOIN story_jobs sj ON sj.id = s.id
     WHERE COALESCE(s.data->>'isTest', s.data->>'is_test', 'false') NOT IN ('true')
       AND COALESCE(s.data->>'isPartial', 'false') <> 'true'
       AND (sj.status = 'completed'
            OR (sj.id IS NULL
                AND jsonb_array_length(COALESCE(s.data->'sceneImages', '[]'::jsonb)) > 0))
     ORDER BY s.created_at DESC
     LIMIT $1`,
    [limit]
  )).rows;

  console.log(`Found ${rows.length} completed non-test stories`);

  let ok = 0, skipped = 0;
  for (const row of rows) {
    const m = await collectStoryMetrics(row.id, { pool, environment: env === 'prod' ? 'production' : env });
    if (m) ok++; else skipped++;
  }

  console.log(`[${ch(new Date())}] Done: ${ok} collected, ${skipped} skipped/failed`);
  await pool.end();
}

main().catch(err => { console.error('Backfill failed:', err); process.exit(1); });
