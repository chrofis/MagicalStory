#!/usr/bin/env node
/**
 * Backfill `Cache-Control: public, max-age=31536000, immutable` onto every
 * versioned R2 object (keys matching `/vN.jpg` or `-vN.jpg`).
 *
 * Versioned keys are immutable by construction — a new render writes a new
 * URL with a higher N. Stamping them with a 1-year immutable header lets
 * Cloudflare + browsers cache them forever. Saves ~2 MiB on every repeat
 * visit to a shared story page.
 *
 * Why this script exists:
 *   The fix landed in commit de9b52ac (server/lib/r2.js uploadImage), but
 *   only NEW uploads get the header. Pre-existing R2 objects were uploaded
 *   without it, so the CDN serves them with the default 4h TTL. This script
 *   walks the bucket and rewrites their metadata in place (S3 CopyObject
 *   with MetadataDirective=REPLACE — no bytes copied, just headers).
 *
 * Usage:
 *   node scripts/admin/backfill-r2-cache-headers.js                 # dry-run, count only
 *   node scripts/admin/backfill-r2-cache-headers.js --apply         # actually write
 *   node scripts/admin/backfill-r2-cache-headers.js --apply --prefix=stories/  # scope
 *
 * Safety:
 *   - Default is dry-run. --apply required to write.
 *   - Only touches keys matching the versioned pattern. Non-versioned keys
 *     (avatars, character photos that overwrite in place) are skipped on
 *     purpose; they need a short TTL.
 *   - CopyObject with same source+dest replaces metadata atomically. Object
 *     bytes are unchanged; URLs unchanged. Worst case: re-running is a no-op.
 *   - Logs every object it touches. Tail-friendly output.
 */

require('dotenv').config();
const {
  S3Client,
  ListObjectsV2Command,
  CopyObjectCommand,
  HeadObjectCommand,
} = require('@aws-sdk/client-s3');

const REQUIRED_ENV = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'];
for (const k of REQUIRED_ENV) {
  if (!process.env[k]) {
    console.error(`Missing env var: ${k}`);
    process.exit(1);
  }
}

const BUCKET = process.env.R2_BUCKET;
const ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const TARGET_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const VERSIONED_KEY = /(?:\/|-)v\d+\.(?:jpg|jpeg|png|webp)$/i;

const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : null;
  }).filter(Boolean)
);
const APPLY = args.apply === 'true';
const PREFIX = args.prefix || '';
const VERBOSE = args.verbose === 'true';

const client = new S3Client({
  region: 'auto',
  endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

async function* listAllObjects(prefix) {
  let continuationToken;
  do {
    const res = await client.send(new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: prefix,
      ContinuationToken: continuationToken,
      MaxKeys: 1000,
    }));
    for (const obj of res.Contents || []) yield obj;
    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken);
}

async function getCurrentCacheControl(key) {
  try {
    const head = await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return head.CacheControl || null;
  } catch (err) {
    return null;
  }
}

async function setCacheControl(key, contentType) {
  // CopyObject with the same source and destination, MetadataDirective=REPLACE
  // rewrites metadata in place. Bytes are unchanged, URL unchanged.
  await client.send(new CopyObjectCommand({
    Bucket: BUCKET,
    Key: key,
    CopySource: `${BUCKET}/${encodeURIComponent(key).replace(/%2F/g, '/')}`,
    CacheControl: TARGET_CACHE_CONTROL,
    ContentType: contentType || 'image/jpeg',
    MetadataDirective: 'REPLACE',
  }));
}

async function main() {
  console.log('═══ R2 Cache-Control Backfill ════════════════════════════');
  console.log(`  Bucket:        ${BUCKET}`);
  console.log(`  Prefix:        ${PREFIX || '(all)'}`);
  console.log(`  Target header: ${TARGET_CACHE_CONTROL}`);
  console.log(`  Mode:          ${APPLY ? 'APPLY (writing changes)' : 'DRY-RUN (no writes)'}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  let scanned = 0;
  let matched = 0;
  let alreadyCorrect = 0;
  let updated = 0;
  let errors = 0;
  const startTime = Date.now();

  for await (const obj of listAllObjects(PREFIX)) {
    scanned++;
    if (scanned % 500 === 0) {
      console.log(`  [progress] scanned ${scanned}, matched ${matched}, updated ${updated}, already-correct ${alreadyCorrect}`);
    }

    if (!VERSIONED_KEY.test(obj.Key)) continue;
    matched++;

    const current = await getCurrentCacheControl(obj.Key);
    if (current === TARGET_CACHE_CONTROL) {
      alreadyCorrect++;
      if (VERBOSE) console.log(`  [skip-already-correct] ${obj.Key}`);
      continue;
    }

    if (!APPLY) {
      if (VERBOSE) console.log(`  [would-update] ${obj.Key}  (was: ${current || '(none)'})`);
      continue;
    }

    try {
      // Guess content type from extension. R2 returns image/jpeg for .jpg by
      // default, but ContentType is required on REPLACE — passing null would
      // strip it.
      const ext = obj.Key.split('.').pop().toLowerCase();
      const ct =
        ext === 'png' ? 'image/png' :
        ext === 'webp' ? 'image/webp' :
        'image/jpeg';
      await setCacheControl(obj.Key, ct);
      updated++;
      if (VERBOSE) console.log(`  [updated] ${obj.Key}`);
    } catch (err) {
      errors++;
      console.error(`  [error] ${obj.Key}: ${err.message}`);
    }
  }

  const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n═══ Summary ═══════════════════════════════════════════════');
  console.log(`  Scanned:         ${scanned} total objects`);
  console.log(`  Matched pattern: ${matched} versioned objects`);
  console.log(`  Already correct: ${alreadyCorrect}`);
  console.log(`  ${APPLY ? 'Updated:        ' : 'Would update:   '} ${APPLY ? updated : (matched - alreadyCorrect)}`);
  console.log(`  Errors:          ${errors}`);
  console.log(`  Elapsed:         ${elapsedSec}s`);
  console.log('═══════════════════════════════════════════════════════════');

  if (!APPLY && matched - alreadyCorrect > 0) {
    console.log(`\nRe-run with --apply to actually update ${matched - alreadyCorrect} object(s).`);
  }
  if (errors > 0) process.exit(1);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
