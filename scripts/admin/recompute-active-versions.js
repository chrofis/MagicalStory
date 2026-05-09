/**
 * One-shot: walk every story, run pickBestVersionIndex on every page +
 * cover's imageVersions[], and stamp activeVersion accordingly.
 *
 * Use after deploying a scoring fix to retroactively re-pick the active
 * version on stories that were saved with "newest stays active" semantics.
 *
 * Idempotent — re-running picks the same index unless versions or scores
 * change.
 *
 * Run from inside Railway (private DB URL):
 *   railway ssh "node scripts/admin/recompute-active-versions.js [--dry] [--story-id=ID]"
 */

require('dotenv').config();
process.env.STORAGE_MODE = process.env.STORAGE_MODE || 'database';
const { Pool } = require('pg');

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const SINGLE = (() => {
  const a = args.find(a => a.startsWith('--story-id='));
  return a ? a.split('=')[1] : null;
})();

(async () => {
  const { initializePool, setActiveVersion, getActiveVersion } = require('../../server/services/database');
  initializePool();
  const { pickBestVersionIndex, computeFinalScore } = require('../../server/lib/scoring');
  const { arrayToDbIndex } = require('../../server/lib/versionManager');

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('railway.app') ? { rejectUnauthorized: false } : false,
  });

  const filter = SINGLE ? "WHERE id = $1" : '';
  const stories = await pool.query(
    `SELECT id, data->'sceneImages' AS scenes, data->'coverImages' AS covers,
            image_version_meta AS meta
     FROM stories ${filter}`,
    SINGLE ? [SINGLE] : []
  );
  console.log(`[recompute] ${stories.rows.length} stories`);

  let totalSwitches = 0, totalPages = 0;

  for (const row of stories.rows) {
    const storyId = row.id;
    const meta = row.meta || {};
    const switches = [];

    const tryRecompute = async (versionsArr, key, type) => {
      if (!Array.isArray(versionsArr) || versionsArr.length === 0) return;
      const bestIdx = pickBestVersionIndex(versionsArr);
      if (bestIdx < 0) return;  // un-evaluated, leave alone
      const dbIdx = arrayToDbIndex(bestIdx, type);
      const currentActive = meta[key]?.activeVersion ?? meta[String(key)]?.activeVersion ?? 0;
      totalPages++;
      if (dbIdx === currentActive) return;
      const oldScore = computeFinalScore(versionsArr[currentActive]) ?? 'null';
      const newScore = computeFinalScore(versionsArr[bestIdx]) ?? 'null';
      switches.push({ key, from: currentActive, to: dbIdx, oldScore, newScore });
      if (!DRY) {
        await setActiveVersion(storyId, key, dbIdx);
      }
    };

    if (Array.isArray(row.scenes)) {
      for (const s of row.scenes) {
        if (!s?.pageNumber || !Array.isArray(s.imageVersions)) continue;
        await tryRecompute(s.imageVersions, s.pageNumber, 'scene');
      }
    }
    if (row.covers && typeof row.covers === 'object') {
      for (const k of ['frontCover', 'initialPage', 'backCover']) {
        const cv = row.covers[k];
        if (!cv?.imageVersions) continue;
        await tryRecompute(cv.imageVersions, k, k);
      }
    }

    if (switches.length > 0) {
      console.log(`[${storyId}] ${switches.length} switch${switches.length > 1 ? 'es' : ''}`);
      for (const s of switches) {
        console.log(`  ${s.key}: v${s.from} (score=${s.oldScore}) → v${s.to} (score=${s.newScore})`);
      }
      totalSwitches += switches.length;
    }
  }

  console.log(`\n[recompute] ${DRY ? 'DRY: would switch' : 'switched'} ${totalSwitches} active versions across ${totalPages} pages/covers in ${stories.rows.length} stories`);
  await pool.end();
})().catch(e => { console.error('FATAL:', e.message, '\n', e.stack); process.exit(1); });
