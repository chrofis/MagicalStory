/**
 * Compare stage timings across trial runs (staging and prod) so a speed
 * regression can be attributed to a stage rather than guessed at.
 *
 * Usage: node tests/manual/compare-trial-timings.js
 */
require('dotenv').config();
const { Pool } = require('pg');
const { ch } = require('../../scripts/lib/chTime.js');

const TARGETS = [
  ['staging', 'job_1788802404497_i1mm4yn6h', 'rerun 2 (post-fix)'],
  ['staging', 'job_1788763045123_z8so79ngb', 'rerun 1 (this morning)'],
  ['staging', 'job_1788725396265_p3dh87hsv', 'Lily 09-06 20:09'],
  ['prod', 'job_1788698812047_q5b1vuds7', 'Amian prod trial'],
];

const pools = {
  staging: new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } }),
  prod: new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }),
};

const s = (ms) => (ms == null ? '   -' : (ms / 1000).toFixed(1).padStart(6) + 's');

(async () => {
  console.log('env      label                    total   storyGen  images  covers  repair  pages  trial  repairCfg');
  for (const [env, id, label] of TARGETS) {
    const r = await pools[env].query('select data, metadata from stories where id=$1', [id]);
    if (!r.rows.length) { console.log(`${env} ${label}: NOT FOUND`); continue; }
    const a = r.rows[0].data.analytics || {};
    const d = r.rows[0].data;
    console.log(
      env.padEnd(8),
      label.padEnd(24),
      s(a.totalDurationMs), s(a.storyGenDurationMs), s(a.imagesDurationMs),
      s(a.coversDurationMs), s(a.repairDurationMs),
      String(a.sceneCount).padStart(5),
      String(!!d.trialMode).padStart(6),
      JSON.stringify(a.pipelineConfig || {}),
    );
  }
  for (const p of Object.values(pools)) await p.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
