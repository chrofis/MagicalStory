#!/usr/bin/env node
/**
 * R2 ORPHAN DELETER — consumes a reviewed manifest, nothing else.
 *
 * This script NEVER decides what is garbage. `audit-r2-orphans.js` produces a
 * manifest; a human reads it; this removes exactly the keys listed in it and
 * not one key more. There is no "scan and sweep" mode and there must never be
 * one — re-deriving the candidate list at delete time is how a story created
 * between audit and deletion gets destroyed.
 *
 * Safety layers, in order:
 *   1. MANIFEST ONLY. The candidate list is read from disk. Unparseable,
 *      wrong-version, or wrong-bucket manifest → hard stop.
 *   2. DRY RUN BY DEFAULT. `--confirm` is required to delete anything.
 *   3. PRODUCTION NEEDS A SECOND FLAG. `--i-understand-this-is-production`.
 *   4. RE-VERIFICATION IMMEDIATELY BEFORE EACH DELETE. Every key in the batch
 *      is re-checked against the live database — both the URL scan (does any
 *      row now cite this URL?) and the owning row (has the story/character/
 *      file/landmark come back?). Anything that gained a reference is SKIPPED
 *      and logged. This is what protects a story created after the audit ran.
 *   5. AGE FLOOR RE-APPLIED. A key whose manifest LastModified is newer than
 *      the floor is skipped even if the manifest listed it.
 *   6. RESUMABLE. Every processed key is appended to a deletion log; a rerun
 *      with the same log skips what it already handled.
 *   7. FAILS LOUDLY. Any R2 or DB error aborts the run. Nothing is swallowed.
 *
 * Usage
 *   node scripts/admin/delete-r2-orphans.js --manifest=<path>              # dry run
 *   node scripts/admin/delete-r2-orphans.js --manifest=<path> --confirm \
 *        --i-understand-this-is-production
 *   …--log=<path>       deletion log (default: alongside the manifest)
 *   …--batch=1000       keys re-verified + deleted per round (max 1000). Each
 *                       round re-scans every base table, so smaller batches
 *                       mean more full-table scans, not less work.
 *   …--limit=N          stop after N deletions (a cautious first pass)
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');
const { S3Client, DeleteObjectsCommand } = require('@aws-sdk/client-s3');

require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const { ch } = require(path.resolve(__dirname, '..', 'lib', 'chTime.js'));

const MAX_BATCH = 1000; // S3 DeleteObjects hard limit

function die(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

function bytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
}

function row(label, value) {
  console.log(`  ${String(label).padEnd(42)} ${value}`);
}

/**
 * Live re-verification of one batch of keys, run against the database at the
 * moment of deletion.
 *
 * Two independent questions, both asked fresh:
 *   (a) does any row in any base table cite this exact URL now?
 *   (b) does the owning id in the key have a live row now?
 * A "yes" to either means the key is NOT deletable.
 *
 * @returns {Promise<Set<string>>} the subset of `keys` that gained a reference.
 */
async function findNowReferenced(client, keys, tables, host) {
  const referenced = new Set();

  // (a) URL scan, restricted to the batch. `= ANY($1)` on the extracted key
  // keeps the work inside Postgres and returns only the hits.
  const RE = `${host}/([A-Za-z0-9_./-]+)`;
  for (const t of tables) {
    const sql = `SELECT DISTINCT m[1] AS k
                   FROM "${t}" src,
                        LATERAL regexp_matches(src::text, $1, 'g') m
                  WHERE m[1] = ANY($2::text[])`;
    // A failure here must abort — treating an unscannable table as "no
    // references" is exactly the mistake that loses a customer's book.
    const res = await client.query(sql, [RE, keys]);
    for (const r of res.rows) referenced.add(r.k);
  }

  // (b) owning rows.
  const storyish = new Set();
  const charIds = new Set();
  const userIds = new Set();
  const fileIds = new Set();
  const landmarkIds = new Set();
  for (const key of keys) {
    const p = key.split('/');
    if (p[0] === 'stories' && p.length >= 3) storyish.add(p[1]);
    else if (p[0] === 'characters' && p.length >= 4) { userIds.add(p[1]); charIds.add(p[2]); }
    else if (p[0] === 'orders' && p.length === 2) fileIds.add(p[1].replace(/\.pdf$/i, ''));
    if (p[0] === 'orders' && p.length === 2) {
      const m = /^pdf-(job_\d+_[a-z0-9]+)-\d+$/i.exec(p[1].replace(/\.pdf$/i, ''));
      if (m) storyish.add(m[1]);
    }
    else if (p[0] === 'landmarks' && p[1] === 'index' && p.length >= 4) landmarkIds.add(p[2]);
  }
  const liveSet = async (sql, values) => {
    if (!values.size) return new Set();
    const r = await client.query(sql, [[...values]]);
    return new Set(r.rows.map((x) => String(x.id)));
  };
  const liveStories = await liveSet('SELECT id FROM stories WHERE id = ANY($1::text[])', storyish);
  const liveStoryUsers = await liveSet('SELECT id FROM users WHERE id::text = ANY($1::text[])', storyish);
  const liveChars = await liveSet('SELECT id FROM characters WHERE id::text = ANY($1::text[])', charIds);
  const liveUsers = await liveSet('SELECT id FROM users WHERE id::text = ANY($1::text[])', userIds);
  const liveFiles = await liveSet('SELECT id FROM files WHERE id::text = ANY($1::text[])', fileIds);
  const liveLandmarks = await liveSet('SELECT id FROM landmark_index WHERE id::text = ANY($1::text[])', landmarkIds);
  // Same two extra owners the audit applies: a live story_jobs row, and a paid
  // orders row whose story_id is the job id. An orders row never stores the
  // PDF URL, so the URL scan alone cannot see it.
  const liveJobs = await liveSet('SELECT id FROM story_jobs WHERE id::text = ANY($1::text[])', storyish);
  const liveOrderStories = await liveSet(
    'SELECT DISTINCT story_id AS id FROM orders WHERE story_id = ANY($1::text[])', storyish,
  );

  for (const key of keys) {
    const p = key.split('/');
    let alive = false;
    if (p[0] === 'stories' && p.length >= 3) {
      alive = liveStories.has(p[1]) || liveStoryUsers.has(p[1])
        || liveJobs.has(p[1]) || liveOrderStories.has(p[1]);
    } else if (p[0] === 'characters' && p.length >= 4) alive = liveChars.has(p[2]) || liveUsers.has(p[1]);
    else if (p[0] === 'orders' && p.length === 2) {
      const fid = p[1].replace(/\.pdf$/i, '');
      const m = /^pdf-(job_\d+_[a-z0-9]+)-\d+$/i.exec(fid);
      // Unparseable order key → treated as alive, i.e. never deletable.
      alive = liveFiles.has(fid) || !m || liveOrderStories.has(m[1]);
    }
    else if (p[0] === 'landmarks' && p[1] === 'index' && p.length >= 4) alive = liveLandmarks.has(p[2]);
    else alive = true; // unrecognised shape → never deletable, belt and braces
    if (alive) referenced.add(key);
  }

  return referenced;
}

async function main() {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => !a.includes('=')));
  const valueOf = (name, dflt) => {
    const a = argv.find((x) => x.startsWith(`${name}=`));
    return a ? a.slice(name.length + 1) : dflt;
  };

  const manifestPath = valueOf('--manifest', null);
  if (!manifestPath) die('--manifest=<path> is required. Run audit-r2-orphans.js first.');
  if (!fs.existsSync(manifestPath)) die(`Manifest not found: ${manifestPath}`);

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    die(`Manifest is not valid JSON: ${err.message}`);
  }
  if (manifest.version !== 1) die(`Unsupported manifest version: ${manifest.version}`);
  if (!Array.isArray(manifest.candidates)) die('Manifest has no candidates array.');

  const confirm = flags.has('--confirm');
  const prodAck = flags.has('--i-understand-this-is-production');
  const isProd = manifest.environment === 'PRODUCTION';
  const batchSize = Math.min(MAX_BATCH, Math.max(1, parseInt(valueOf('--batch', '1000'), 10) || 1000));
  const limit = parseInt(valueOf('--limit', '0'), 10) || 0;
  const logPath = path.resolve(valueOf('--log', manifestPath.replace(/\.json$/, '') + '.deletions.log'));

  if (manifest.bucket !== process.env.R2_BUCKET) {
    die(`Manifest was generated for bucket "${manifest.bucket}" but .env points at `
      + `"${process.env.R2_BUCKET}". Refusing to delete from a different bucket.`);
  }
  const connectionString = isProd ? process.env.DATABASE_URL : process.env.STAGING_DATABASE_URL;
  if (!connectionString) die(`No connection string for environment ${manifest.environment}.`);
  if (confirm && isProd && !prodAck) {
    die('This manifest targets PRODUCTION. Add --i-understand-this-is-production to proceed.');
  }
  if (manifest.publicUrl !== process.env.R2_PUBLIC_URL) {
    die(`Manifest public URL (${manifest.publicUrl}) != .env R2_PUBLIC_URL (${process.env.R2_PUBLIC_URL}).`);
  }

  const host = new URL(manifest.publicUrl).host.replace(/\./g, '\\.');
  const ageFloorMs = (manifest.ageFloorDays || 0) * 24 * 60 * 60 * 1000;
  const now = Date.now();

  console.log(`\n╔${'═'.repeat(74)}╗`);
  console.log(`║  R2 ORPHAN DELETER${' '.repeat(56)}║`);
  console.log(`╚${'═'.repeat(74)}╝`);
  row('mode', confirm ? '⚠️  LIVE DELETE' : 'DRY RUN (no --confirm)');
  row('manifest', manifestPath);
  row('manifest generated', manifest.generatedAtCh || manifest.generatedAt);
  row('environment', manifest.environment);
  row('bucket', manifest.bucket);
  row('candidates', manifest.candidates.length);
  row('age floor', `${manifest.ageFloorDays} day(s)`);
  row('deletion log', logPath);
  row('time', ch(new Date()));

  // Resume: anything already in the log is done.
  const handled = new Set();
  if (fs.existsSync(logPath)) {
    for (const line of fs.readFileSync(logPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { handled.add(JSON.parse(line).key); } catch { /* tolerate a torn last line */ }
    }
    row('already handled (resume)', handled.size);
  }

  const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();
  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });

  const logStream = confirm ? fs.createWriteStream(logPath, { flags: 'a' }) : null;
  const writeLog = (entry) => {
    if (logStream) logStream.write(JSON.stringify(entry) + '\n');
  };

  let deleted = 0; let deletedBytes = 0; let skippedReferenced = 0;
  let skippedRecent = 0; let skippedHandled = 0;

  try {
    const tables = (await client.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ORDER BY table_name`,
    )).rows.map((r) => r.table_name);
    row('tables re-verified against', tables.length);

    const queue = manifest.candidates.filter((c) => {
      if (handled.has(c.key)) { skippedHandled += 1; return false; }
      return true;
    });

    for (let i = 0; i < queue.length; i += batchSize) {
      if (limit && deleted >= limit) {
        console.log(`\n  --limit=${limit} reached; stopping.`);
        break;
      }
      const batch = queue.slice(i, i + batchSize);

      // Age floor, re-applied from the manifest's own LastModified.
      const aged = [];
      for (const c of batch) {
        const lm = c.lastModified ? new Date(c.lastModified).getTime() : null;
        if (lm === null || now - lm < ageFloorMs) {
          skippedRecent += 1;
          writeLog({ ts: new Date().toISOString(), key: c.key, action: 'skip', reason: 'age-floor' });
          continue;
        }
        aged.push(c);
      }
      if (!aged.length) continue;

      // THE critical gate: re-ask the live database, right now.
      const nowReferenced = await findNowReferenced(
        client, aged.map((c) => c.key), tables, host,
      );
      const deletable = [];
      for (const c of aged) {
        if (nowReferenced.has(c.key)) {
          skippedReferenced += 1;
          console.log(`  ⚠️  SKIP (gained a reference since the audit): ${c.key}`);
          writeLog({ ts: new Date().toISOString(), key: c.key, action: 'skip', reason: 'now-referenced' });
          continue;
        }
        deletable.push(c);
      }
      if (!deletable.length) continue;

      const slice = limit ? deletable.slice(0, Math.max(0, limit - deleted)) : deletable;
      if (!slice.length) continue;

      if (!confirm) {
        deleted += slice.length;
        deletedBytes += slice.reduce((a, c) => a + (c.size || 0), 0);
        process.stderr.write(`\r  dry run… would delete ${deleted} object(s)        `);
        continue;
      }

      const res = await s3.send(new DeleteObjectsCommand({
        Bucket: process.env.R2_BUCKET,
        Delete: { Objects: slice.map((c) => ({ Key: c.key })), Quiet: false },
      }));
      // Fail loudly — a partial delete is reported, never ignored.
      if (res.Errors && res.Errors.length) {
        for (const e of res.Errors) {
          console.error(`  ✗ DELETE FAILED ${e.Key}: ${e.Code} ${e.Message}`);
          writeLog({ ts: new Date().toISOString(), key: e.Key, action: 'error', reason: `${e.Code}: ${e.Message}` });
        }
        throw new Error(`${res.Errors.length} object(s) failed to delete — aborting the run.`);
      }
      const removed = new Set((res.Deleted || []).map((d) => d.Key));
      for (const c of slice) {
        if (!removed.has(c.key)) {
          throw new Error(`R2 reported neither success nor error for ${c.key} — aborting.`);
        }
        deleted += 1;
        deletedBytes += c.size || 0;
        writeLog({
          ts: new Date().toISOString(), key: c.key, action: 'deleted',
          size: c.size, lastModified: c.lastModified, prefix: c.prefix, reason: c.reason,
        });
      }
      process.stderr.write(`\r  deleted ${deleted} / ${queue.length} …        `);
    }
    process.stderr.write('\r' + ' '.repeat(60) + '\r');

    console.log(`\n${'─'.repeat(76)}`);
    row(confirm ? 'DELETED' : 'WOULD DELETE', `${deleted} object(s), ${bytes(deletedBytes)}`);
    row('skipped — gained a reference', skippedReferenced);
    row('skipped — inside age floor', skippedRecent);
    row('skipped — already in the log', skippedHandled);
    if (!confirm) {
      console.log('\n  DRY RUN. Nothing was deleted. Re-run with --confirm'
        + (isProd ? ' --i-understand-this-is-production' : '') + ' to act.\n');
    } else {
      console.log(`\n  Deletion log: ${logPath}\n`);
    }
  } finally {
    if (logStream) await new Promise((r) => logStream.end(r));
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('\n✗ FATAL:', err.message);
  console.error(err.stack);
  process.exit(1);
});
