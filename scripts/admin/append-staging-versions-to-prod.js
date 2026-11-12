#!/usr/bin/env node
/**
 * Deliver a story fixed on staging to production by APPENDING versions, never overwriting.
 *
 * For every picture (page or cover) whose staging active image differs from production's
 * active image, production gets ONE NEW VERSION: the staging image is copied into the
 * production bucket under the story's prefix at the next free version_index, a story_images
 * row is inserted, an imageVersions entry (marked source 'admin-fix') is appended to
 * stories.data, and image_version_meta makes it active and pinned, which is what the
 * customer's own version picker writes. Every existing production version stays untouched
 * and selectable (owner decision 2026-11-12). A cover's textless art layer travels with it
 * at the same version_index.
 *
 * In the same transaction the story's snapshot gets the stored "no" words of glasses / other
 * replaced by the 'none' sentinel (scripts/lib/noWordTraits.js; bug glasses-nein-read-as-glasses).
 *
 * Why not promote-story-to-prod.js: its update mode deletes and re-inserts every image row
 * and replaces data / image_version_meta with the staging copy, i.e. an overwrite.
 *
 * Guards (any one refuses):
 *   - production changed since the pull (data sha, image rows newer than the pull, a
 *     metadata.updatedAt after the pull, a production row the staging copy does not hold);
 *     provenance comes from the staging copy's metadata.promotedFrom, or, when a staging save
 *     has dropped that stamp, from --src-sha=<16 hex> --pulled-at=<ISO> as printed by
 *     copy-story-to-staging.js;
 *   - the production job is still running;
 *   - an order exists for the story (a printed book would no longer match), unless --force;
 *   - a target object key already exists in the production bucket.
 *
 * Usage:
 *   node scripts/admin/append-staging-versions-to-prod.js <storyId> [--src-sha=.. --pulled-at=..]            (dry run)
 *   node scripts/admin/append-staging-versions-to-prod.js <storyId> [--src-sha=.. --pulled-at=..] --yes      (write)
 *
 * --dry-run is the default and opens production READ ONLY. --yes first writes a JSON backup of
 * the production row and its image rows to tasks/customer-<storyId>-before-append-<ts>.json
 * (gitignored: customer data), uploads the bytes, then does every DB write in one transaction
 * on the locked row. Production R2 credentials are read from
 * `railway variables --service MagicalStory --environment production` (never printed).
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const { Pool } = require('pg');
const urls = require('../lib/promoteStoryUrls');
const plan = require('../lib/appendStagingVersions');
const { findNoWordFields, replaceNoWordFields, SENTINEL } = require('../lib/noWordTraits');
const { ch, fromPgNaive } = require('../lib/chTime');

const args = process.argv.slice(2);
const storyId = args.find((a) => !a.startsWith('--'));
const flag = (name) => (args.find((a) => a.startsWith(`${name}=`)) || '').slice(name.length + 1);
const YES = args.includes('--yes');
const FORCE = args.includes('--force');
if (!storyId || (args.includes('--dry-run') && YES)) {
  console.error('Usage: node scripts/admin/append-staging-versions-to-prod.js <storyId> [--src-sha=<sha> --pulled-at=<ISO>] [--dry-run | --yes] [--force]');
  process.exit(1);
}

const prodUrl = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
const stagingUrl = process.env.STAGING_DATABASE_URL;
if (!prodUrl || !stagingUrl) { console.error('Need DATABASE_URL (prod) and STAGING_DATABASE_URL in .env'); process.exit(1); }
const host = (u) => { const x = new URL(u); return `${x.hostname}:${x.port}${x.pathname}`; };
if (host(prodUrl) === host(stagingUrl)) { console.error('REFUSED: source and target are the same DB'); process.exit(1); }

const IMG_COLS = 'image_type, page_number, version_index, image_url, quality_score, generated_at, created_at';

/** Production R2 settings from Railway into process.env, never printed. */
function loadProdR2Env() {
  // Windows installs the CLI as railway.cmd, which execFileSync cannot start without the extension.
  const out = execFileSync(process.platform === 'win32' ? 'railway.cmd' : 'railway', ['variables', '--service', 'MagicalStory', '--environment', 'production', '--json'],
    // Node refuses to start a .cmd without a shell (EINVAL); the arguments are constants.
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  const vars = JSON.parse(out);
  for (const k of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_PUBLIC_URL']) {
    if (!vars[k]) throw new Error(`production Railway variables have no ${k}`);
    process.env[k] = vars[k];
  }
  if (process.env.R2_PUBLIC_URL.replace(/\/$/, '') !== urls.PROD_BASE) throw new Error(`production R2_PUBLIC_URL is not ${urls.PROD_BASE}`);
}

async function headStatus(u) {
  try { return (await fetch(u, { method: 'HEAD', signal: AbortSignal.timeout(30000) })).status; } catch (e) { return e.message; }
}

(async () => {
  const stg = new Pool({ connectionString: stagingUrl, ssl: { rejectUnauthorized: false } });
  const prod = new Pool({ connectionString: prodUrl, ssl: { rejectUnauthorized: false } });
  // A dry run cannot write: every production session is read-only.
  if (!YES) prod.on('connect', (c) => { c.query('SET default_transaction_read_only = on'); });
  const end = async () => { await stg.end(); await prod.end(); };

  const [sRes, pRes] = await Promise.all([
    stg.query('SELECT id, data, metadata, image_version_meta FROM stories WHERE id = $1', [storyId]),
    prod.query('SELECT * FROM stories WHERE id = $1', [storyId]),
  ]);
  if (!sRes.rows.length) { console.error(`Story ${storyId} not found in STAGING.`); process.exit(1); }
  if (!pRes.rows.length) { console.error(`Story ${storyId} not found in PRODUCTION. This tool appends to an existing story.`); process.exit(1); }
  const staged = sRes.rows[0];
  const live = pRes.rows[0];
  const [sImgs, pImgs] = await Promise.all([
    stg.query(`SELECT ${IMG_COLS} FROM story_images WHERE story_id = $1 AND NOT COALESCE(is_test, false)`, [storyId]),
    prod.query(`SELECT ${IMG_COLS} FROM story_images WHERE story_id = $1 AND NOT COALESCE(is_test, false)`, [storyId]),
  ]);

  // story_images.created_at is a naive TIMESTAMP holding the UTC wall clock; node-pg reads it as
  // local time, so re-home it before any comparison with the (true UTC) pull time.
  for (const r of [...sImgs.rows, ...pImgs.rows]) r.created_at = fromPgNaive(r.created_at);

  console.log(`Story   : ${storyId}  (prod owner ${live.user_id}, kept)`);

  // ── Provenance ─────────────────────────────────────────────────────────────
  const stamp = staged.metadata && staged.metadata.promotedFrom;
  const srcSha = (stamp && stamp.srcSha) || flag('--src-sha');
  const pulledAt = (stamp && stamp.pulledAt) || flag('--pulled-at');
  if (stamp && (flag('--src-sha') || flag('--pulled-at'))) {
    console.error('REFUSED: the staging copy carries its own provenance stamp; drop --src-sha / --pulled-at.'); process.exit(1);
  }
  if (!srcSha || !pulledAt) {
    console.error('REFUSED: no provenance. The staging copy has no metadata.promotedFrom (a staging save drops it);');
    console.error('         pass --src-sha=<sha> --pulled-at=<ISO> exactly as copy-story-to-staging.js printed them.');
    process.exit(1);
  }
  const problems = plan.provenanceProblems({
    prodData: live.data, prodMetadata: live.metadata, prodRows: pImgs.rows, stagingRows: sImgs.rows, srcSha, pulledAt,
  });
  console.log(`Provenance: ${stamp ? 'staging stamp' : 'command-line'} sha ${srcSha}, pulled ${ch(new Date(pulledAt))}`);
  if (problems.length) {
    console.error('REFUSED: production changed since the pull:');
    for (const p of problems) console.error(`   - ${p}`);
    process.exit(1);
  }
  console.log('            production unchanged since the pull (data sha, image rows, metadata.updatedAt)');

  // ── Guards ────────────────────────────────────────────────────────────────
  const job = await prod.query('SELECT status FROM story_jobs WHERE id = $1', [storyId]);
  const jobStatus = job.rows[0] && job.rows[0].status;
  if (['processing', 'pending', 'running'].includes(jobStatus)) { console.error(`REFUSED: production job is '${jobStatus}'.`); process.exit(1); }
  const orders = await prod.query('SELECT id FROM orders WHERE story_id = $1', [storyId]);
  console.log(`Orders  : ${orders.rows.length}`);
  if (orders.rows.length && !FORCE) { console.error('REFUSED: an order exists; a printed book would no longer match. --force to proceed.'); process.exit(1); }

  // ── Plan ──────────────────────────────────────────────────────────────────
  const entries = plan.planAppends({
    storyId, stagingMeta: staged.image_version_meta, stagingRows: sImgs.rows, prodMeta: live.image_version_meta, prodRows: pImgs.rows,
  });
  const appendedAt = new Date().toISOString();
  // Staging-bucket URLs inside a version entry (reference images made on staging) move too.
  const extraCopies = new Set();
  const rewrite = (v) => {
    for (const u of urls.collectCopySources(v, storyId, storyId, urls.PROD_BASE)) extraCopies.add(u);
    return urls.rewriteDeep(v, storyId, storyId, urls.PROD_BASE);
  };
  const newData = plan.applyPlanToData(live.data, staged.data, entries, { appendedAt, rewrite });
  const noWordPaths = replaceNoWordFields(newData);
  const newMeta = plan.applyPlanToMeta(live.image_version_meta, entries);
  urls.assertAllOnBase({ newData, newMeta }, urls.PROD_BASE, 'production payload');

  console.log(`Images  : staging ${sImgs.rows.length} rows, production ${pImgs.rows.length} rows`);
  console.log(`Plan    : ${entries.length} picture(s) get a new version (all existing production versions stay)`);
  for (const e of entries) {
    const label = e.imageType === 'scene' ? `p${e.pageNumber}` : e.key;
    const same = e.sameImageAsProdVersion != null ? `  (same image as production v${e.sameImageAsProdVersion})` : '';
    console.log(`   ${label.padEnd(12)} prod active v${e.prodActive ?? '-'} -> NEW v${e.newIndex} = staging v${e.stagingVersion}${e.art ? ` (+ ${e.art.imageType} v${e.newIndex})` : ''}${same}`);
  }
  const unplanned = new Set(entries.map((e) => e.key));
  console.log(`Unchanged: ${[...new Set(pImgs.rows.filter((r) => plan.DISPLAY_TYPES.includes(r.image_type)).map(plan.metaKeyOf))].filter((k) => !unplanned.has(k)).length} picture(s) already show the staging final image`);
  console.log(`'none'  : ${noWordPaths.length} stored "no" value(s) of glasses/other in production data -> '${SENTINEL}'`);
  const byTop = {};
  for (const p of noWordPaths) { const top = p.split(/[.[]/)[1]; byTop[top] = (byTop[top] || 0) + 1; }
  if (noWordPaths.length) console.log(`           by section: ${Object.entries(byTop).map(([k, n]) => `${k} ${n}`).join(', ')}`);
  const leftAfter = findNoWordFields(newData).length;
  if (leftAfter) throw new Error(`${leftAfter} "no" value(s) left after the replacement`);

  // Bytes to copy: each new version (and art layer) to its new key; extra referenced staging objects to their own key.
  const copies = [];
  for (const e of entries) {
    copies.push({ from: e.sourceUrl, key: e.newKey });
    if (e.art) copies.push({ from: e.art.sourceUrl, key: e.art.newKey });
  }
  for (const u of extraCopies) copies.push({ from: u, key: urls.keyForUrl(u) });
  console.log(`R2 copy : ${copies.length} object(s) -> ${urls.PROD_BASE}/stories/${storyId}/...`);
  const badSrc = []; const taken = [];
  for (const c of copies) {
    const s = await headStatus(c.from); if (s !== 200) badSrc.push(`${s} ${c.from}`);
    // Cache-busting query: a HEAD on the bare public URL of a not-yet-uploaded key makes the CDN
    // cache that 404, and the customer then sees broken pictures for minutes after the upload
    // (2026-11-12: 21 pictures per story for about 6 minutes).
    const t = await headStatus(`${urls.PROD_BASE}/${c.key}?precheck=${Date.now()}`); if (t === 200) taken.push(c.key);
  }
  console.log(`          sources reachable: ${copies.length - badSrc.length}/${copies.length}; target keys already taken: ${taken.length}`);
  if (badSrc.length) { console.error(`REFUSED: unreachable source(s): ${badSrc.slice(0, 3).join(' | ')}`); process.exit(1); }
  if (taken.length) { console.error(`REFUSED: production key(s) already exist: ${taken.slice(0, 3).join(' | ')}`); process.exit(1); }
  console.log(`Data    : production data sha ${plan.sha16(live.data)} -> ${plan.sha16(newData)} (${entries.length} imageVersions entries appended)`);

  if (!entries.length && !noWordPaths.length) { console.log('\nNothing to do.'); await end(); return; }
  if (!YES) { console.log('\n--dry-run: production opened read-only; no uploads, no writes. Re-run with --yes to append.'); await end(); return; }

  // ── Write ─────────────────────────────────────────────────────────────────
  const backupFile = path.resolve(__dirname, '..', '..', 'tasks', `customer-${storyId}-before-append-${appendedAt.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(backupFile, JSON.stringify({ takenAt: appendedAt, storyId, story: live,
    story_images: (await prod.query('SELECT * FROM story_images WHERE story_id = $1', [storyId])).rows }, null, 2));
  console.log(`Backup  : ${backupFile}`);

  loadProdR2Env();
  const r2 = require('../../server/lib/r2');
  if (!r2.isConfigured()) throw new Error('R2 not configured after loading production variables');
  for (const c of copies) {
    const buf = await r2.fetchImageBytes(c.from);
    if (!buf || !buf.length) throw new Error(`download failed: ${c.from}`);
    const up = await r2.uploadImage(buf, c.key, 'image/jpeg');
    if (!up) throw new Error(`upload failed: ${c.key}`);
  }
  console.log(`R2      : uploaded ${copies.length} object(s)`);

  const client = await prod.connect();
  try {
    await client.query('BEGIN');
    const locked = (await client.query('SELECT data FROM stories WHERE id = $1 FOR UPDATE', [storyId])).rows[0];
    if (plan.sha16(locked.data) !== plan.sha16(live.data)) throw new Error('production data changed during the run');
    for (const e of entries) {
      const rows = [{ type: e.imageType, page: e.pageNumber, key: e.newKey }];
      if (e.art) rows.push({ type: e.art.imageType, page: null, key: e.art.newKey });
      for (const r of rows) {
        await client.query(
          `INSERT INTO story_images (story_id, image_type, page_number, version_index, image_data, image_url, quality_score, generated_at)
           VALUES ($1, $2, $3, $4, NULL, $5, $6, $7)`,
          [storyId, r.type, r.page, e.newIndex, `${urls.PROD_BASE}/${r.key}`, r.type === e.imageType ? e.qualityScore : null, appendedAt]);
      }
    }
    await client.query(
      `UPDATE stories SET data = $2, image_version_meta = $3,
              metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{updatedAt}', to_jsonb($4::text))
        WHERE id = $1`,
      [storyId, JSON.stringify(newData), JSON.stringify(newMeta), appendedAt]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(`FAILED, rolled back: ${e.message}. Production rows untouched (uploaded objects are unreferenced). Backup: ${backupFile}`);
    process.exit(1);
  } finally { client.release(); }
  console.log(`\nAppended ${entries.length} version(s) to production story ${storyId}; ${noWordPaths.length} 'none' value(s) set.`);
  await end();
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
