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
 * Staging and production have SEPARATE R2 buckets (images-staging.magicalstory.ch
 * vs images.magicalstory.ch; the old "one shared bucket" assumption stopped being
 * true). So image bytes DO move: every images-staging URL the story references
 * (story_images.image_url and any string in data/metadata/image_version_meta) is
 * downloaded and uploaded to the production bucket (local .env R2_* must point at
 * production) under the same key, then rewritten to the production public URL.
 * Uploads happen BEFORE the DB write; any failure aborts with nothing written.
 *
 * TWO MODES
 *   update (default): overwrite an existing production story, same id, same owner.
 *   --as-new --user=<prodUserId>: create a NEW production story (fresh id; the
 *     story id inside keys/URLs is rewritten too) in that user's library. The
 *     original is untouched. No story_jobs row is created, so nothing is emailed:
 *     the library lists a row with no job row as finished (routes/stories.js).
 *
 * WHAT MOVES: stories.data, stories.metadata, stories.image_version_meta, and
 * the story_images rows.
 * WHAT NEVER MOVES (update mode): user_id, share_token, is_shared, created_at. Those
 * belong to production — a promoted story must land in the same user's library, with
 * their existing share link still valid. Staging is_test image rows never move.
 *
 * Usage:
 *   node scripts/admin/promote-story-to-prod.js <storyId> [--force] [--yes]
 *   node scripts/admin/promote-story-to-prod.js <storyId> --dry-run
 *   node scripts/admin/promote-story-to-prod.js <storyId> --as-new --user=<prodUserId> [--dry-run|--yes]
 */
'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const { Pool } = require('pg');
const urls = require('../lib/promoteStoryUrls');

const args = process.argv.slice(2);
const storyId = args.find((a) => !a.startsWith('--'));
const FORCE = args.includes('--force');
const DRY = args.includes('--dry-run');
const YES = args.includes('--yes');
const AS_NEW = args.includes('--as-new');
const NEW_USER = (args.find((a) => a.startsWith('--user=')) || '').slice('--user='.length);

if (!storyId) {
  console.error('Usage: node scripts/admin/promote-story-to-prod.js <storyId> [--force] [--dry-run] [--yes] [--as-new --user=<prodUserId>]');
  process.exit(1);
}
if (AS_NEW && !NEW_USER) { console.error('--as-new needs --user=<prodUserId>'); process.exit(1); }
if (!AS_NEW && NEW_USER) { console.error('--user only applies with --as-new'); process.exit(1); }

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

const CONTENT_TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };

/**
 * Everything the production DB will receive, rewritten for the production bucket,
 * plus the distinct staging URLs whose bytes must be copied. Throws if a staging
 * URL would survive the rewrite.
 */
function preparePayload(staged, stagedImgs, oldId, newId) {
  const rw = (v) => urls.rewriteDeep(v, oldId, newId);
  const toCopy = urls.collectStagingUrls([staged.data, staged.metadata, staged.image_version_meta,
    stagedImgs.map((r) => r.image_url)]);
  const payload = {
    data: rw(staged.data),
    metadata: rw(staged.metadata),
    image_version_meta: rw(staged.image_version_meta),
    imgs: stagedImgs.map((r) => ({ ...r, image_url: r.image_url ? rw(r.image_url) : r.image_url })),
  };
  urls.assertNoStagingUrls(payload, 'rewritten payload');
  const mentions = urls.countStagingHostMentions(payload);
  if (mentions) throw new Error(`${mentions} raw images-staging mention(s) left in rewritten payload`);
  return { payload, toCopy: [...toCopy].sort() };
}

// The local R2_* env must be PRODUCTION's bucket, or the copy would land in the wrong place.
function assertProdBucket() {
  const r2 = require('../../server/lib/r2');
  if (!r2.isConfigured()) throw new Error('R2_* env not configured');
  if (process.env.R2_PUBLIC_URL.replace(/\/$/, '') !== urls.PROD_BASE) {
    throw new Error(`R2_PUBLIC_URL is ${process.env.R2_PUBLIC_URL}, expected ${urls.PROD_BASE} (production bucket)`);
  }
  return r2;
}

/** Download every staging URL and upload it to the production bucket. Any failure throws. */
async function copyToProdBucket(toCopy, oldId, newId) {
  const r2 = assertProdBucket();
  let done = 0;
  const queue = [...toCopy];
  const worker = async () => {
    for (let u = queue.shift(); u; u = queue.shift()) {
      const key = urls.keyForStagingUrl(u, oldId, newId);
      const buf = await r2.fetchImageBytes(u);
      if (!buf || !buf.length) throw new Error(`download failed: ${u}`);
      const ext = key.split('.').pop().toLowerCase();
      const out = await r2.uploadImage(buf, key, CONTENT_TYPES[ext] || 'application/octet-stream');
      if (!out) throw new Error(`upload failed: ${key}`);
      if (++done % 25 === 0) console.log(`   copied ${done}/${toCopy.length}`);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  console.log(`R2      : copied ${done} objects staging -> production bucket`);
}

function printPlan({ newId, userId, payload, toCopy, oldId }) {
  console.log(`New id  : ${newId}`);
  console.log(`Owner   : ${userId}`);
  console.log(`Rows    : 1 stories row + ${payload.imgs.length} story_images rows (non-test)`);
  console.log(`R2 copy : ${toCopy.length} distinct staging URLs`);
  console.log('Sample rewritten:');
  for (const u of toCopy.slice(0, 5)) console.log(`   ${u}
 -> ${urls.PROD_BASE}/${urls.keyForStagingUrl(u, oldId, newId)}`);
  console.log(`Staging URLs left after rewrite: ${urls.collectStagingUrls(payload).size + urls.countStagingHostMentions(payload)}`);
}

/**
 * --as-new: create a NEW production story in `NEW_USER`'s library. The row mirrors
 * what the app writes for a finished story (database.js upsertStory: random
 * share_token, admin_draft false) so it lists exactly like any other story; staging's
 * is_shared / admin_draft / user_id are not carried. No story_jobs row is written:
 * the library lists a story with no job row as finished and no email path is touched.
 * The user's characters row already exists on production and is not copied.
 */
async function promoteAsNew(prod, stg, staged) {
  const oldId = staged.id;
  const u = await prod.query('SELECT id FROM users WHERE id = $1', [NEW_USER]);
  if (!u.rows.length) { console.error(`REFUSED: user ${NEW_USER} not found in production.`); process.exit(1); }
  const newId = urls.makeJobId();
  if ((await prod.query('SELECT 1 FROM stories WHERE id = $1', [newId])).rows.length) throw new Error('generated id collides');

  const imgs = await stg.query(
    `SELECT image_type, page_number, version_index, image_data, image_url, quality_score, generated_at
       FROM story_images WHERE story_id = $1 AND NOT is_test
       ORDER BY image_type, page_number, version_index`, [oldId]);
  const { payload, toCopy } = preparePayload(staged, imgs.rows, oldId, newId);
  delete payload.metadata?.promotedFrom;
  printPlan({ newId, userId: NEW_USER, payload, toCopy, oldId });
  console.log(`Source  : staging ${oldId} (data sha ${sha(staged.data)}); original production story untouched`);

  if (DRY) { console.log('\n--dry-run: no uploads, no writes performed.'); return; }
  if (!YES) { console.log('\nRe-run with --yes to create the story.'); return; }

  await copyToProdBucket(toCopy, oldId, newId);
  fs.mkdirSync(backupDir, { recursive: true });
  const manifest = path.join(backupDir, `${newId}-created.json`);
  fs.writeFileSync(manifest, JSON.stringify({ createdAt: new Date().toISOString(), newId, userId: NEW_USER, sourceStagingId: oldId,
    uploadedKeys: toCopy.map((x) => urls.keyForStagingUrl(x, oldId, newId)) }, null, 2));
  console.log(`Manifest: ${manifest} (undo = delete story ${newId} + its story_images + R2 prefix stories/${newId}/)`);

  const client = await prod.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO stories (id, user_id, data, metadata, share_token, is_shared, image_version_meta, admin_draft,
                            idea_source, idea_original, idea_used)
       VALUES ($1,$2,$3,$4,$5,FALSE,$6,FALSE,$7,$8,$9)`,
      [newId, NEW_USER, payload.data, payload.metadata, crypto.randomBytes(32).toString('hex'), payload.image_version_meta,
       staged.idea_source, staged.idea_original, staged.idea_used]);
    for (const r of payload.imgs) {
      await client.query(
        `INSERT INTO story_images (story_id, image_type, page_number, version_index, image_data, image_url, quality_score, generated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [newId, r.image_type, r.page_number, r.version_index, r.image_data, r.image_url, r.quality_score, r.generated_at]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(`FAILED, rolled back: ${e.message}. Production DB untouched (uploaded R2 objects are orphans under stories/${newId}/).`);
    process.exit(1);
  } finally { client.release(); }
  console.log(`
✅ Created production story ${newId} for user ${NEW_USER}: ${payload.imgs.length} image rows.`);
}

(async () => {
  const prod = new Pool({ connectionString: prodUrl, ssl: { rejectUnauthorized: false } });
  const stg = new Pool({ connectionString: stagingUrl, ssl: { rejectUnauthorized: false } });

  const [{ rows: sRows }, { rows: pRows }] = await Promise.all([
    stg.query('SELECT * FROM stories WHERE id = $1', [storyId]),
    prod.query('SELECT * FROM stories WHERE id = $1', [storyId]),
  ]);
  if (!sRows.length) { console.error(`Story ${storyId} not found in STAGING — nothing to promote.`); process.exit(1); }
  if (AS_NEW) { await promoteAsNew(prod, stg, sRows[0]); await prod.end(); await stg.end(); return; }
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
       FROM story_images WHERE story_id = $1 AND NOT is_test`, [storyId]);
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

  // Bytes first: a story row must never point at objects that are not there yet.
  await copyToProdBucket(toCopy, storyId, storyId);

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
      [storyId, payload.data, payload.metadata, payload.image_version_meta]
    );
    await client.query('DELETE FROM story_images WHERE story_id = $1', [storyId]);
    for (const r of payload.imgs) {
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
