#!/usr/bin/env node
/**
 * Shipped-defect markers — the reader the fields were written for.
 *
 * Three fields on `stories.data` record a defect the run decided to SHIP
 * rather than fail on. Each was added with a comment promising a reader
 * ("the admin/audit surfaces and any future check can read", "visible in
 * rating") and none existed, so the markers were written for nobody:
 *
 *   missingImages            pages persisted with no image bytes  (2026-08-29)
 *   missingCovers            covers persisted with no image bytes (2026-08-29)
 *   landmarkMinimumShortfall real landmarks staged, when below 2  (2026-09-05)
 *
 * They are DIAGNOSTICS, not leftovers: each is the queryable form of a
 * generationLog alert the run already wrote, and each is `null` on a clean
 * story, so they cost 4 bytes when there is nothing to say. This script is
 * what makes them answerable without opening the DB by hand.
 *
 * Usage:
 *   node scripts/analysis/shipped-defects.js                 # staging, 30 days
 *   node scripts/analysis/shipped-defects.js --prod --days=7
 *   node scripts/analysis/shipped-defects.js --story=<id>    # one story
 *
 * Read-only. No model calls, no cost.
 */

'use strict';

require('dotenv').config();
const { Pool } = require('pg');
const { ch } = require('../lib/chTime');

const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const useProd = args.includes('--prod');
const days = parseInt(arg('days', '30'), 10);
const oneStory = arg('story', null);

const connectionString = useProd ? process.env.DATABASE_URL : process.env.STAGING_DATABASE_URL;
if (!connectionString) {
  console.error(`Missing ${useProd ? 'DATABASE_URL' : 'STAGING_DATABASE_URL'} in .env`);
  process.exit(1);
}

const MARKERS = [
  ['missingImages', 'pages shipped with no image'],
  ['missingCovers', 'covers shipped with no image'],
  ['landmarkMinimumShortfall', 'real landmarks staged (guideline is 2)'],
];

(async () => {
  const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
  try {
    const where = oneStory
      ? { sql: 'WHERE id = $1', params: [oneStory] }
      : { sql: `WHERE created_at > NOW() - INTERVAL '${days} days'`, params: [] };

    // Pull only the three markers out of the JSONB — never the whole blob.
    const { rows } = await pool.query(`
      SELECT id, title, created_at,
             data::jsonb->'missingImages'            AS missing_images,
             data::jsonb->'missingCovers'            AS missing_covers,
             data::jsonb->'landmarkMinimumShortfall' AS landmark_shortfall
      FROM stories
      ${where.sql}
      ORDER BY created_at DESC
    `, where.params);

    const flagged = rows.filter(r =>
      r.missing_images !== null || r.missing_covers !== null || r.landmark_shortfall !== null);

    console.log(`${useProd ? 'PRODUCTION' : 'staging'} — ${rows.length} stor(ies)${oneStory ? '' : ` in the last ${days} days`}, ${flagged.length} carrying a shipped-defect marker\n`);

    for (const r of flagged) {
      console.log(`${r.id}  ${ch(r.created_at)}  ${r.title || '(untitled)'}`);
      if (r.missing_images !== null) console.log(`   missingImages            page(s) ${JSON.stringify(r.missing_images)}`);
      if (r.missing_covers !== null) console.log(`   missingCovers            ${JSON.stringify(r.missing_covers)}`);
      if (r.landmark_shortfall !== null) console.log(`   landmarkMinimumShortfall staged ${r.landmark_shortfall} of a guideline 2`);
      console.log('');
    }

    console.log('Rates:');
    for (const [key, label] of MARKERS) {
      const col = { missingImages: 'missing_images', missingCovers: 'missing_covers', landmarkMinimumShortfall: 'landmark_shortfall' }[key];
      const n = rows.filter(r => r[col] !== null).length;
      const pct = rows.length ? ((n / rows.length) * 100).toFixed(1) : '0.0';
      console.log(`  ${key.padEnd(26)} ${String(n).padStart(4)} / ${rows.length}  (${pct}%)  — ${label}`);
    }
  } finally {
    await pool.end();
  }
})().catch(err => { console.error(err); process.exit(1); });
