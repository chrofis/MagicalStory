#!/usr/bin/env node
/**
 * Push ONE story back from staging into production — the return leg of
 * copy-story-to-staging.js.
 *
 * WHY: fixing a disappointing story used to mean deploying to production and
 * re-running there, which is backwards — you cannot iterate on a live
 * environment. With this pair you pull the story to staging, fix/rerun as many
 * times as you like (Test Lab, regeneration endpoints), and promote the result
 * to the user when it is actually good.
 *
 * Both environments share the SAME R2 bucket (magicalstory-images /
 * images.magicalstory.ch — verified 2026-08-23), so no image bytes move: images
 * generated on staging are already in the bucket production reads from, and the
 * story's image URLs resolve verbatim on both sides. This is what makes the
 * round trip cheap.
 *
 * WHAT MOVES: stories.data, stories.metadata, stories.image_version_meta, and
 * the story_images rows.
 * WHAT NEVER MOVES: user_id, share_token, is_shared, created_at. Those belong
 * to production — a promoted story must land in the same user's library, with
 * their existing share link still valid.
 *
 * Usage:
 *   node scripts/admin/promote-story-to-prod.js <storyId> [--force] [--yes]
 *   node scripts/admin/promote-story-to-prod.js <storyId> --dry-run
 */
'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const { Pool } = require('pg');

const args = process.argv.slice(2);
const storyId = args.find((a) => !a.startsWith('--'));
const FORCE = args.includes('--force');
const DRY = args.includes('--dry-run');
const YES = args.includes('--yes');

if (!storyId) {
  console.error('Usage: node scripts/admin/promote-story-to-prod.js <storyId> [--force] [--dry-run] [--yes]');
  process.exit(1);
}

const prodUrl = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
const stagingUrl = process.env.STAGING_DATABASE_URL;
if (!prodUrl || !stagingUrl) {
  console.error('Need DATABASE_URL (prod) and STAGING_DATABASE_URL in .env');
  process.exit(1);
}
const host = (u) => { const x = new URL(u); return `${x.hostname}:${x.port}${x.pathname}`; };
if (host(prodUrl) === host(stagingUrl)) {
  console.error('REFUSED: source and target are the same DB');
  process.exit(1);
}

const sha = (obj) => crypto.createHash('sha256').update(JSON.stringify(obj ?? null)).digest('hex').slice(0, 16);
const backupDir = path.resolve(__dirname, '..', '..', 'backups', 'story-promotions');

(async () => {
  const prod = new Pool({ connectionString: prodUrl, ssl: { rejectUnauthorized: false } });
  const stg = new Pool({ connectionString: stagingUrl, ssl: { rejectUnauthorized: false } });

  const [{ rows: sRows }, { rows: pRows }] = await Promise.all([
    stg.query('SELECT * FROM stories WHERE id = $1', [storyId]),
    prod.query('SELECT * FROM stories WHERE id = $1', [storyId]),
  ]);
  if (!sRows.length) { console.error(`Story ${storyId} not found in STAGING — nothing to promote.`); process.exit(1); }
  if (!pRows.length) { console.error(`Story ${storyId} not found in PRODUCTION. This tool UPDATES an existing story; it will not create one.`); process.exit(1); }
  const staged = sRows[0];
  const live = pRows[0];

  console.log(`Story   : ${storyId}`);
  console.log(`Prod user: ${live.user_id}  (preserved — staging's user_id is ignored)`);

  // ── Guard 1: has production moved since the pull? ────────────────────────
  // The pull stamps the source hash into staging metadata. If production's data
  // no longer matches it, someone (the user, a repair, a regen) changed the
  // story after we took our copy, and promoting would silently discard that.
  const provenance = staged.metadata?.promotedFrom;
  const liveSha = sha(live.data);
  if (!provenance?.srcSha) {
    console.log('⚠️  No provenance stamp on the staging copy (pulled before this was added).');
    if (!FORCE) { console.error('   Refusing without --force: cannot prove production is unchanged since the pull.'); process.exit(1); }
  } else if (provenance.srcSha !== liveSha) {
    console.log(`⚠️  PRODUCTION CHANGED since the pull (${provenance.srcSha} -> ${liveSha}, pulled ${provenance.pulledAt}).`);
    console.log('   Someone edited/regenerated this story in production after you copied it.');
    if (!FORCE) { console.error('   Refusing without --force — promoting would discard those changes.'); process.exit(1); }
  } else {
    console.log(`Provenance: matches production (${liveSha}), pulled ${provenance.pulledAt}`);
  }

  // ── Guard 2: don't overwrite a story that is mid-generation ──────────────
  const job = await prod.query("SELECT status FROM story_jobs WHERE id = $1", [storyId]);
  const jobStatus = job.rows[0]?.status;
  if (jobStatus && ['processing', 'pending', 'running'].includes(jobStatus)) {
    console.error(`REFUSED: production job for this story is '${jobStatus}' — promoting now would race it.`);
    process.exit(1);
  }

  // ── Guard 3: the book may already be printed ────────────────────────────
  // Changing images under an ordered book means the customer's physical copy no
  // longer matches what they can see online. Loud, and --force only.
  const orders = await prod.query('SELECT id, created_at FROM orders WHERE story_id = $1', [storyId]);
  if (orders.rows.length) {
    console.log(`⚠️  ${orders.rows.length} ORDER(S) exist for this story (oldest ${String(orders.rows[0].created_at).slice(0, 10)}).`);
    console.log('   A printed book will no longer match the online version.');
    if (!FORCE) { console.error('   Refusing without --force.'); process.exit(1); }
  }

  const stagedImgs = await stg.query(
    `SELECT image_type, page_number, version_index, image_data, image_url, quality_score, generated_at
       FROM story_images WHERE story_id = $1`, [storyId]);
  const liveImgs = await prod.query('SELECT COUNT(*)::int AS n FROM story_images WHERE story_id = $1', [storyId]);

  // Inline bytes would have to travel; R2 URLs do not. Report the split so a
  // surprise (a staging image that never got offloaded) is visible, not silent.
  const inline = stagedImgs.rows.filter((r) => !r.image_url && r.image_data).length;
  console.log(`Images  : staging ${stagedImgs.rows.length} rows (${inline} inline, rest R2 URLs) -> prod currently ${liveImgs.rows[0].n}`);
  console.log(`Data    : staging ${(JSON.stringify(staged.data).length / 1048576).toFixed(2)}MB (sha ${sha(staged.data)})`);

  if (DRY) { console.log('\n--dry-run: no writes performed.'); await prod.end(); await stg.end(); return; }

  if (!YES) {
    // Writing to production is irreversible from the user's point of view.
    console.log('\nThis will OVERWRITE the production story with the staging version.');
    console.log('Re-run with --yes to proceed (a backup is written first).');
    await prod.end(); await stg.end();
    return;
  }

  // ── Backup BEFORE the write ─────────────────────────────────────────────
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = path.join(backupDir, `${storyId}-${stamp}.json`);
  const liveImgRows = await prod.query('SELECT * FROM story_images WHERE story_id = $1', [storyId]);
  fs.writeFileSync(backupFile, JSON.stringify({
    takenAt: new Date().toISOString(), storyId,
    story: live, story_images: liveImgRows.rows,
  }, null, 2));
  console.log(`Backup  : ${backupFile}`);

  // ── The write ───────────────────────────────────────────────────────────
  // One transaction: a half-promoted story (new data, old images) would render
  // as a mismatch the user can see.
  const client = await prod.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE stories
          SET data = $2, metadata = $3, image_version_meta = $4
        WHERE id = $1`,
      [storyId, staged.data, staged.metadata, staged.image_version_meta]
    );
    await client.query('DELETE FROM story_images WHERE story_id = $1', [storyId]);
    for (const r of stagedImgs.rows) {
      await client.query(
        `INSERT INTO story_images (story_id, image_type, page_number, version_index, image_data, image_url, quality_score, generated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [storyId, r.image_type, r.page_number, r.version_index, r.image_data, r.image_url, r.quality_score, r.generated_at]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(`FAILED, rolled back: ${e.message}`);
    console.error(`Production is untouched. Backup remains at ${backupFile}`);
    process.exit(1);
  } finally {
    client.release();
  }

  console.log(`\n✅ Promoted to production: ${stagedImgs.rows.length} image rows, user ${live.user_id} unchanged.`);
  console.log(`   Share link and ownership preserved. Restore with the backup file if needed.`);
  await prod.end(); await stg.end();
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
