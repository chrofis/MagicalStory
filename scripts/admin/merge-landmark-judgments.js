#!/usr/bin/env node
/**
 * Write agent-produced landmark scores into landmark_index.story_score.
 *
 * The agents judge visually (Read tool on downloaded thumbnails) and each
 * writes picks_<n>.json — `{ "<id>": { score, reason } }`. This merges every
 * picks file in a judging directory and applies it.
 *
 * A COVERAGE CHECK IS MANDATORY, not decoration: agents sometimes return fewer
 * ids than they were given (they die mid-batch, or quietly skip an image that
 * would not open). A missing id is indistinguishable from an unjudged landmark
 * and would be re-prepped forever, so the ids still missing are printed for a
 * cleanup pass.
 *
 *   node scripts/admin/merge-landmark-judgments.js --dir=DIR [--staging] [--dry-run]
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const { Pool } = require('pg');
const fs = require('fs');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const STAGING = args.includes('--staging');
const dirArg = args.find(a => a.startsWith('--dir='));
const DIR = dirArg ? dirArg.split('=')[1] : path.join(process.env.TEMP || '/tmp', 'lm_judge');

(async () => {
  const url = STAGING ? process.env.STAGING_DATABASE_URL : process.env.DATABASE_URL;
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });

  const files = fs.readdirSync(DIR).filter(f => /^picks_\d+\.json$/.test(f));
  const merged = {};
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
      for (const [id, v] of Object.entries(j)) {
        const score = Math.max(0, Math.min(100, parseInt(v?.score, 10)));
        if (!Number.isFinite(score)) continue;
        merged[id] = { score, reason: String(v?.reason || '').slice(0, 300) };
      }
    } catch (e) { console.log(`  ${f}: unreadable (${e.message})`); }
  }
  console.log(`${files.length} picks file(s) → ${Object.keys(merged).length} scored landmark(s)`);

  const manifest = fs.existsSync(path.join(DIR, 'manifest.json'))
    ? JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8')) : [];
  const missing = manifest.filter(m => merged[String(m.id)] === undefined);
  if (missing.length) {
    console.log(`⚠ ${missing.length} prepped landmark(s) were NOT scored — re-run those before assuming coverage:`);
    missing.slice(0, 12).forEach(m => console.log(`    ${m.id}  ${m.name}`));
  }

  if (DRY) { await pool.end(); return; }

  let n = 0;
  for (const [id, v] of Object.entries(merged)) {
    await pool.query(
      'UPDATE landmark_index SET story_score = $2, story_score_reason = $3, story_score_at = NOW() WHERE id = $1',
      [Number(id), v.score, v.reason]);
    n++;
  }
  const rejected = Object.values(merged).filter(v => v.score < 30).length;
  console.log(`\n✅ ${n} landmark(s) scored — ${rejected} below 30 will no longer be offered.`);
  await pool.end();
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
