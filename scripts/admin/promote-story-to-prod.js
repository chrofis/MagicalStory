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
 * THREE MODES
 *   update (default): overwrite an existing production story, same id, same owner.
 *   --as-new --user=<prodUserId>: create a NEW production story (fresh id; the
 *     story id inside keys/URLs is rewritten too) in that user's library. The
 *     original is untouched. No story_jobs row is created, so nothing is emailed:
 *     the library lists a row with no job row as finished (routes/stories.js).
 *
 *   --restore-from=<backup.json>: put a story back EXACTLY as a promote backup captured it
 *     (backups/story-promotions/<id>-<ts>.json). Needs no staging DB. See restoreFromBackup().
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
 *   node scripts/admin/promote-story-to-prod.js <storyId> --restore-from=<backupFile> [--dry-run|--yes]
 *
 * --target=staging (only with --as-new / --restore-from) points the WRITE at the staging DB and
 * staging bucket instead of production, so the tooling can be exercised for real without touching
 * production. R2_* env must then be the STAGING bucket's.
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
const flagValue = (name) => (args.find((a) => a.startsWith(`${name}=`)) || '').slice(name.length + 1);
const NEW_USER = flagValue('--user');
const RESTORE_FROM = flagValue('--restore-from');
const TARGET = flagValue('--target') || 'prod';

if (!storyId) {
  console.error('Usage: node scripts/admin/promote-story-to-prod.js <storyId> [--force] [--dry-run] [--yes] [--as-new --user=<prodUserId>]');
  process.exit(1);
}
if (AS_NEW && !NEW_USER) { console.error('--as-new needs --user=<prodUserId>'); process.exit(1); }
if (!AS_NEW && NEW_USER) { console.error('--user only applies with --as-new'); process.exit(1); }
if (!['prod', 'staging'].includes(TARGET)) { console.error('--target must be prod or staging'); process.exit(1); }
if (AS_NEW && RESTORE_FROM) { console.error('--as-new and --restore-from are different modes'); process.exit(1); }
if (TARGET === 'staging' && !AS_NEW && !RESTORE_FROM) { console.error('--target=staging only applies with --as-new or --restore-from'); process.exit(1); }

const prodUrl = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
const stagingUrl = process.env.STAGING_DATABASE_URL;
if (TARGET === 'prod' && !prodUrl) { console.error('Need DATABASE_URL (prod) in .env'); process.exit(1); }
if (!stagingUrl && (!RESTORE_FROM || TARGET === 'staging')) { console.error('Need STAGING_DATABASE_URL in .env'); process.exit(1); }
// The DB and bucket every WRITE goes to. The story itself is always READ from staging.
const targetDbUrl = TARGET === 'staging' ? stagingUrl : prodUrl;
const targetBase = TARGET === 'staging' ? urls.STAGING_BASE : urls.PROD_BASE;
const host = (u) => { const x = new URL(u); return `${x.hostname}:${x.port}${x.pathname}`; };
if (TARGET === 'prod' && stagingUrl && host(prodUrl) === host(stagingUrl)) {
  console.error('REFUSED: source and target are the same DB');
  process.exit(1);
}

const sha = (obj) => crypto.createHash('sha256').update(JSON.stringify(obj ?? null)).digest('hex').slice(0, 16);
const backupDir = path.resolve(__dirname, '..', '..', 'backups', 'story-promotions');

const CONTENT_TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };

/**
 * Everything the target DB will receive, rewritten for the target bucket, plus the distinct
 * source URLs whose bytes must be copied (other-bucket URLs, and as-new every URL whose key
 * carries the old story id). Throws if a URL on the wrong bucket would survive the rewrite.
 */
function preparePayload(staged, stagedImgs, oldId, newId) {
  const rw = (v) => urls.rewriteDeep(v, oldId, newId, targetBase);
  const toCopy = urls.collectCopySources([staged.data, staged.metadata, staged.image_version_meta,
    stagedImgs.map((r) => r.image_url)], oldId, newId, targetBase);
  const payload = {
    data: rw(staged.data),
    metadata: rw(staged.metadata),
    image_version_meta: rw(staged.image_version_meta),
    imgs: stagedImgs.map((r) => ({ ...r, image_url: r.image_url ? rw(r.image_url) : r.image_url })),
  };
  urls.assertAllOnBase(payload, targetBase, 'rewritten payload', oldId, newId);
  if (TARGET === 'prod') {
    const mentions = urls.countStagingHostMentions(payload);
    if (mentions) throw new Error(`${mentions} raw images-staging mention(s) left in rewritten payload`);
  }
  return { payload, toCopy: [...toCopy].sort() };
}

// The local R2_* env must be the TARGET bucket's, or the copy would land in the wrong place.
function assertTargetBucket() {
  const r2 = require('../../server/lib/r2');
  if (!r2.isConfigured()) throw new Error('R2_* env not configured');
  if (process.env.R2_PUBLIC_URL.replace(/\/$/, '') !== targetBase) {
    throw new Error(`R2_PUBLIC_URL is ${process.env.R2_PUBLIC_URL}, expected ${targetBase} (${TARGET} bucket)`);
  }
  return r2;
}

/** Download every source URL and upload it to the target bucket under its (possibly re-identified) key. Any failure throws. */
async function copyToTargetBucket(toCopy, oldId, newId) {
  const r2 = assertTargetBucket();
  let done = 0;
  const queue = [...toCopy];
  const worker = async () => {
    for (let u = queue.shift(); u; u = queue.shift()) {
      const key = urls.keyForUrl(u, oldId, newId);
      const buf = await r2.fetchImageBytes(u);
      if (!buf || !buf.length) throw new Error(`download failed: ${u}`);
      const ext = key.split('.').pop().toLowerCase();
      const out = await r2.uploadImage(buf, key, CONTENT_TYPES[ext] || 'application/octet-stream');
      if (!out) throw new Error(`upload failed: ${key}`);
      if (++done % 25 === 0) console.log(`   copied ${done}/${toCopy.length}`);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  console.log(`R2      : copied ${done} objects -> ${TARGET} bucket`);
}

/** Backup of the target story row + its image rows, written before any change. Returns the file path. */
async function backupCurrent(targetPool, id, storyRow) {
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = path.join(backupDir, `${id}-${stamp}.json`);
  const imgRows = await targetPool.query('SELECT * FROM story_images WHERE story_id = $1', [id]);
  fs.writeFileSync(backupFile, JSON.stringify({
    takenAt: new Date().toISOString(), storyId: id, story: storyRow, story_images: imgRows.rows,
  }, null, 2));
  console.log(`Backup  : ${backupFile}`);
  return backupFile;
}

/** HEAD every URL (public, free); returns the ones that do not answer 200 as "status url". */
async function unreachableUrls(list) {
  const queue = [...list];
  const bad = [];
  const worker = async () => {
    for (let u = queue.shift(); u; u = queue.shift()) {
      let status = 'error';
      try { status = (await fetch(u, { method: 'HEAD', signal: AbortSignal.timeout(30000) })).status; } catch (e) { status = e.message; }
      if (status !== 200) bad.push(`${status} ${u}`);
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return bad;
}

async function columnTypes(pool, table) {
  const r = await pool.query('SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1', [table]);
  return Object.fromEntries(r.rows.map((x) => [x.column_name, x.data_type]));
}

/**
 * --restore-from: put the story back exactly as the backup captured it (stories columns except
 * user_id / share_token / is_shared / created_at, and every story_images row). Why a mode of this
 * script and not a sibling: it shares the backup format, the pool/target/--dry-run/--yes plumbing
 * and the backup-before-write step with promote; only the source of the rows differs.
 * Image bytes are NOT copied: a promote backup is a row of the target environment, so its URLs are
 * already in the target bucket (assertRestorable refuses any other bucket).
 */
async function restoreFromBackup(targetPool) {
  const backup = JSON.parse(fs.readFileSync(path.resolve(RESTORE_FROM), 'utf8'));
  urls.assertRestorable(backup, storyId, targetBase);
  const { rows } = await targetPool.query('SELECT * FROM stories WHERE id = $1', [storyId]);
  if (!rows.length) { console.error(`Story ${storyId} not found in ${TARGET}. A restore overwrites an existing row; it does not create one.`); process.exit(1); }
  const live = rows[0];
  const storyTypes = await columnTypes(targetPool, 'stories');
  const imgTypes = await columnTypes(targetPool, 'story_images');
  const storyCols = urls.restoreStoryColumns(backup.story, live);
  const imgCols = [...new Set(backup.story_images.flatMap((r) => Object.keys(r)))].filter((c) => c !== 'id');
  const unknownImg = imgCols.filter((c) => !(c in imgTypes));
  if (unknownImg.length) throw new Error(`backup story_images column(s) not in the live table: ${unknownImg.join(', ')}`);
  if (backup.story_images.some((r) => r.story_id !== storyId)) throw new Error('backup contains story_images rows of another story');

  const job = await targetPool.query('SELECT status FROM story_jobs WHERE id = $1', [storyId]);
  if (job.rows[0] && ['processing', 'pending', 'running'].includes(job.rows[0].status)) {
    console.error(`REFUSED: the job for this story is '${job.rows[0].status}' - restoring now would race it.`); process.exit(1);
  }
  const orders = await targetPool.query('SELECT id FROM orders WHERE story_id = $1', [storyId]);
  const liveImgCount = (await targetPool.query('SELECT COUNT(*)::int AS n FROM story_images WHERE story_id = $1', [storyId])).rows[0].n;
  const reach = [...urls.collectBucketUrls(backup)].sort();

  console.log(`Story   : ${storyId} (${TARGET})  owner ${live.user_id}, share_token / is_shared / created_at kept as they are now`);
  console.log(`Backup  : taken ${backup.takenAt}, data sha ${sha(backup.story.data)} (live now ${sha(live.data)})`);
  console.log(`Writes  : stories columns [${storyCols.join(', ')}]`);
  console.log(`          story_images: delete ${liveImgCount} current rows, insert ${backup.story_images.length} from the backup`);
  console.log(`Orders  : ${orders.rows.length} order(s) exist for this story (informational)`);
  console.log(`R2      : no copy; checking ${reach.length} backup image URLs answer 200 ...`);
  // The story's own objects (stories/<id>/...) are what a promote could have overwritten or pruned, so
  // a miss there is fatal. A dead shared asset (landmark photo, character art) was already dead in the
  // original; it is reported, not blocking.
  const bad = await unreachableUrls(reach);
  const own = bad.filter((b) => b.includes(`/stories/${storyId}/`));
  if (own.length) throw new Error(`${own.length} of the story's own image URL(s) not reachable, e.g. ${own.slice(0, 3).join(' | ')}`);
  console.log(`          story-owned URLs all reachable; ${bad.length} shared URL(s) already dead in the original${bad.length ? `: ${bad.slice(0, 3).join(' | ')}` : ''}`);
  if (DRY) { console.log('\n--dry-run: no writes performed.'); return; }
  if (!YES) { console.log('\nRe-run with --yes to restore (a backup of the current row is written first).'); return; }

  await backupCurrent(targetPool, storyId, live);
  const client = await targetPool.connect();
  try {
    await client.query('BEGIN');
    const set = storyCols.map((c, i) => `"${c}" = $${i + 2}`).join(', ');
    await client.query(`UPDATE stories SET ${set} WHERE id = $1`,
      [storyId, ...storyCols.map((c) => urls.toDbValue(backup.story[c], storyTypes[c]))]);
    await client.query('DELETE FROM story_images WHERE story_id = $1', [storyId]);
    const cols = imgCols.map((c) => `"${c}"`).join(', ');
    const marks = imgCols.map((_, i) => `$${i + 1}`).join(', ');
    for (const r of backup.story_images) {
      await client.query(`INSERT INTO story_images (${cols}) VALUES (${marks})`,
        imgCols.map((c) => urls.toDbValue(r[c], imgTypes[c])));
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(`FAILED, rolled back: ${e.message}. ${TARGET} story ${storyId} is untouched.`);
    process.exit(1);
  } finally { client.release(); }
  console.log(`\nRestored ${TARGET} story ${storyId}: ${storyCols.length} columns, ${backup.story_images.length} image rows.`);
}

function printPlan({ newId, userId, payload, toCopy, oldId }) {
  console.log(`New id  : ${newId}`);
  console.log(`Owner   : ${userId}`);
  console.log(`Rows    : 1 stories row + ${payload.imgs.length} story_images rows (non-test)`);
  console.log(`R2 copy : ${toCopy.length} distinct source URLs -> ${TARGET} bucket under stories/${newId}/ (a story delete prunes that prefix, so the copy owns its objects)`);
  console.log('Sample rewritten:');
  for (const u of toCopy.slice(0, 5)) console.log(`   ${u}
 -> ${targetBase}/${urls.keyForUrl(u, oldId, newId)}`);
  console.log(`Story-id URLs off the target bucket after rewrite: ${[...urls.collectBucketUrls(payload)].filter((u) => u.includes(newId) && !u.startsWith(`${targetBase}/`)).length}`);
  console.log(`Old id left in payload: ${JSON.stringify(payload).split(oldId).length - 1}`);
}

/**
 * --as-new: create a NEW story in the target environment's `NEW_USER` library. The row mirrors
 * what the app writes for a finished story (database.js upsertStory: random
 * share_token, admin_draft false) so it lists exactly like any other story; staging's
 * is_shared / admin_draft / user_id are not carried. No story_jobs row is written:
 * the library lists a story with no job row as finished and no email path is touched.
 * The user's characters row already exists on production and is not copied.
 */
async function promoteAsNew(prod, stg, staged) {
  const oldId = staged.id;
  const u = await prod.query('SELECT id FROM users WHERE id = $1', [NEW_USER]);
  if (!u.rows.length) { console.error(`REFUSED: user ${NEW_USER} not found in ${TARGET}.`); process.exit(1); }
  const newId = urls.makeJobId();
  if ((await prod.query('SELECT 1 FROM stories WHERE id = $1', [newId])).rows.length) throw new Error('generated id collides');

  const imgs = await stg.query(
    `SELECT image_type, page_number, version_index, image_data, image_url, quality_score, generated_at
       FROM story_images WHERE story_id = $1 AND NOT is_test
       ORDER BY image_type, page_number, version_index`, [oldId]);
  const { payload, toCopy } = preparePayload(staged, imgs.rows, oldId, newId);
  delete payload.metadata?.promotedFrom;
  printPlan({ newId, userId: NEW_USER, payload, toCopy, oldId });
  console.log(`Source  : staging ${oldId} (data sha ${sha(staged.data)}); the original story is untouched`);

  if (DRY) { console.log('\n--dry-run: no uploads, no writes performed.'); return; }
  if (!YES) { console.log('\nRe-run with --yes to create the story.'); return; }

  await copyToTargetBucket(toCopy, oldId, newId);
  fs.mkdirSync(backupDir, { recursive: true });
  const manifest = path.join(backupDir, `${newId}-created.json`);
  fs.writeFileSync(manifest, JSON.stringify({ createdAt: new Date().toISOString(), newId, userId: NEW_USER, sourceStagingId: oldId,
    uploadedKeys: toCopy.map((x) => urls.keyForUrl(x, oldId, newId)) }, null, 2));
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
    console.error(`FAILED, rolled back: ${e.message}. Target DB untouched (uploaded R2 objects are orphans under stories/${newId}/).`);
    process.exit(1);
  } finally { client.release(); }
  console.log(`
✅ Created ${TARGET} story ${newId} for user ${NEW_USER}: ${payload.imgs.length} image rows.`);
}

(async () => {
  const mkPool = (u) => new Pool({ connectionString: u, ssl: { rejectUnauthorized: false } });
  if (RESTORE_FROM) {
    const t = mkPool(targetDbUrl);
    await restoreFromBackup(t);
    await t.end();
    return;
  }
  const stg = mkPool(stagingUrl);
  const prod = TARGET === 'staging' ? stg : mkPool(prodUrl);
  const end = async () => { await stg.end(); if (prod !== stg) await prod.end(); };

  const [{ rows: sRows }, { rows: pRows }] = await Promise.all([
    stg.query('SELECT * FROM stories WHERE id = $1', [storyId]),
    prod.query('SELECT * FROM stories WHERE id = $1', [storyId]),
  ]);
  if (!sRows.length) { console.error(`Story ${storyId} not found in STAGING — nothing to promote.`); process.exit(1); }
  if (AS_NEW) { await promoteAsNew(prod, stg, sRows[0]); await end(); return; }
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
  // Same rewrite as --as-new, computed before --dry-run exits so a dry run proves it too.
  const { payload, toCopy } = preparePayload(staged, stagedImgs.rows, storyId, storyId);
  console.log(`R2 copy : ${toCopy.length} distinct source URLs`);

  if (DRY) { console.log('\n--dry-run: no writes performed.'); await prod.end(); await stg.end(); return; }

  if (!YES) {
    // Writing to production is irreversible from the user's point of view.
    console.log('\nThis will OVERWRITE the production story with the staging version.');
    console.log('Re-run with --yes to proceed (a backup is written first).');
    await prod.end(); await stg.end();
    return;
  }

  // ── Backup BEFORE the write ─────────────────────────────────────────────
  const backupFile = await backupCurrent(prod, storyId, live);

  // Bytes first: a story row must never point at objects that are not there yet.
  await copyToTargetBucket(toCopy, storyId, storyId);

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
