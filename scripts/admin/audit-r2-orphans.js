#!/usr/bin/env node
/**
 * R2 ORPHAN AUDIT — READ ONLY. It has no delete mode and never will.
 *
 * Owner ruling 2026-09-12 (Q7, tasks/gdpr-erasure-2026-09-11.md §8): build the
 * audit, not a sweep. Deleting bucket objects from a script that infers
 * "unreferenced" from key shapes is how real images get lost; this reports, a
 * human decides.
 *
 * Why orphans exist: `server/routes/stories.js:3334` calls
 * `r2.deleteStoryArtefacts(id)` when a story is deleted, and that helper logs
 * failures and returns a count rather than throwing. A failed prune therefore
 * leaves objects behind with no DB row pointing at them, silently. They are
 * unreachable by any per-user enumeration, which is why the GDPR erasure
 * script cannot find them either.
 *
 * How "referenced" is decided — by the OWNING ROW, never by a URL scan:
 *   stories/{A}/…                     A is a live stories.id OR a live users.id
 *                                     (dbHousekeeping.js:148 mints
 *                                     stories/{userId}/{storyId}/migrated/…)
 *   characters/{userId}/{charId}/…    charId is a live characters.id
 *                                     OR userId is a live users.id
 *   orders/{fileId}.pdf               fileId is a live files.id (the id is the whole
 *                                     basename, e.g. `pdf-{jobId}-{ts}`)
 *   landmarks/index/{landmarkId}/…    landmarkId is a live landmark_index.id
 *   landmarks/historical/…            NOT AUDITED — the key is `{id}-{slug}`
 *                                     and the slug is lossy; reported separately
 *   anything else                     NOT AUDITED — reported as unknown
 *
 * Every rule is deliberately conservative: an object counts as an orphan only
 * when NO candidate owner exists. Under-reporting is the safe direction for a
 * number a human may act on.
 *
 * Target: the bucket in `.env` (production — there are no staging R2
 * credentials, ruling Q8). The DB it compares against must be the one that
 * bucket serves, so the host guard from the erasure script applies here too.
 *
 * Usage
 *   node scripts/admin/audit-r2-orphans.js
 *   node scripts/admin/audit-r2-orphans.js --staging   # only if R2_* point at staging
 *   node scripts/admin/audit-r2-orphans.js --list=200  # print up to N example keys
 */
'use strict';

const path = require('path');
const { Pool } = require('pg');
const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');

require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const { ch } = require(path.resolve(__dirname, '..', 'lib', 'chTime.js'));

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

function section(title) {
  console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`);
}

function row(label, value) {
  console.log(`  ${String(label).padEnd(40)} ${value}`);
}

/** Same guard as the erasure script: prove the bucket belongs to this database. */
async function assertBucketMatchesDatabase(client, envName) {
  const sample = (await client.query(
    "SELECT image_url FROM story_images WHERE image_url LIKE 'http%' ORDER BY id DESC LIMIT 1",
  )).rows[0];
  if (!sample) {
    console.log('  ⚠️  No stored image URL on this database — cannot verify the bucket.');
    return;
  }
  const dbHost = new URL(sample.image_url).host;
  const cfgHost = new URL(process.env.R2_PUBLIC_URL).host;
  if (dbHost !== cfgHost) {
    die(`R2 BUCKET MISMATCH — refusing to run.\n`
      + `    ${envName} database serves images from : ${dbHost}\n`
      + `    .env R2_PUBLIC_URL points at          : ${cfgHost}  (bucket "${process.env.R2_BUCKET}")\n\n`
      + `  Every object would look orphaned, because this bucket holds none of that\n`
      + `  database's images. Point the R2_* vars at ${dbHost} and re-run.`);
  }
  row('bucket verified', `${process.env.R2_BUCKET} (${cfgHost}) matches ${envName}`);
}

/** Walk the whole bucket. */
async function listAll(s3, onBatch) {
  let ContinuationToken;
  let seen = 0;
  do {
    const res = await s3.send(new ListObjectsV2Command({
      Bucket: process.env.R2_BUCKET, ContinuationToken, MaxKeys: 1000,
    }));
    const batch = (res.Contents || []).map((o) => ({ key: o.Key, size: o.Size || 0 }));
    seen += batch.length;
    onBatch(batch);
    process.stderr.write(`\r  listing… ${seen} objects`);
    ContinuationToken = res.IsTruncated ? res.NextContinuationToken : null;
  } while (ContinuationToken);
  process.stderr.write('\r');
  return seen;
}

/** Every live id we compare against, loaded once as sets. */
async function loadLiveIds(client) {
  const ids = async (sql) => new Set(
    (await client.query(sql)).rows.map((r) => String(r.id)),
  );
  return {
    stories: await ids('SELECT id FROM stories'),
    users: await ids('SELECT id FROM users'),
    characters: await ids('SELECT id FROM characters'),
    files: await ids('SELECT id FROM files'),
    landmarks: await ids('SELECT id FROM landmark_index'),
  };
}

/**
 * @returns {{group: string, state: 'referenced'|'orphan'|'unaudited'}}
 */
function classify(key, live) {
  const parts = key.split('/');

  if (parts[0] === 'stories' && parts.length >= 3) {
    const a = parts[1];
    const referenced = live.stories.has(a) || live.users.has(a);
    return { group: 'stories/', state: referenced ? 'referenced' : 'orphan' };
  }
  if (parts[0] === 'characters' && parts.length >= 4) {
    const [, userId, charId] = parts;
    const referenced = live.characters.has(charId) || live.users.has(userId);
    return { group: 'characters/', state: referenced ? 'referenced' : 'orphan' };
  }
  if (parts[0] === 'orders' && parts.length === 2) {
    const fileId = parts[1].replace(/\.pdf$/i, '');
    return { group: 'orders/', state: live.files.has(fileId) ? 'referenced' : 'orphan' };
  }
  if (parts[0] === 'landmarks' && parts[1] === 'index' && parts.length >= 4) {
    return { group: 'landmarks/index/', state: live.landmarks.has(parts[2]) ? 'referenced' : 'orphan' };
  }
  if (parts[0] === 'landmarks') {
    // landmarks/historical/{id}-{slug}.jpg — the slug makes the id ambiguous.
    return { group: 'landmarks/historical/', state: 'unaudited' };
  }
  return { group: `${parts[0]}/ (unrecognised)`, state: 'unaudited' };
}

async function main() {
  const args = new Set(process.argv.slice(2).map((a) => a.split('=')[0]));
  const listArg = process.argv.slice(2).find((a) => a.startsWith('--list='));
  const listLimit = listArg ? Math.max(0, parseInt(listArg.split('=')[1], 10) || 0) : 20;
  const staging = args.has('--staging');

  const connectionString = staging ? process.env.STAGING_DATABASE_URL : process.env.DATABASE_URL;
  const envName = staging ? 'staging' : 'PRODUCTION';
  if (!connectionString) die(`${staging ? 'STAGING_DATABASE_URL' : 'DATABASE_URL'} is not set in .env.`);
  if (!process.env.R2_BUCKET || !process.env.R2_PUBLIC_URL) die('R2_* env vars are not configured.');

  console.log(`\n╔${'═'.repeat(74)}╗`);
  console.log(`║  R2 ORPHAN AUDIT — READ ONLY (nothing is ever deleted)${' '.repeat(20)}║`);
  console.log(`╚${'═'.repeat(74)}╝`);
  row('database', envName);
  row('bucket', process.env.R2_BUCKET);
  row('time', ch(new Date()));

  const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();
  try {
    await assertBucketMatchesDatabase(client, envName);

    section('1. LIVE DATABASE REFERENCES');
    const live = await loadLiveIds(client);
    for (const [k, v] of Object.entries(live)) row(`  ${k}`, `${v.size} row(s)`);

    section('2. BUCKET WALK');
    const s3 = new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    });

    const groups = new Map(); // group → {referenced, orphan, unaudited, orphanBytes, totalBytes, samples}
    const bump = (g, state, size, key) => {
      if (!groups.has(g)) {
        groups.set(g, {
          referenced: 0, orphan: 0, unaudited: 0, orphanBytes: 0, totalBytes: 0, samples: [],
        });
      }
      const e = groups.get(g);
      e[state] += 1;
      e.totalBytes += size;
      if (state === 'orphan') {
        e.orphanBytes += size;
        if (e.samples.length < listLimit) e.samples.push(key);
      }
    };

    const total = await listAll(s3, (batch) => {
      for (const o of batch) {
        const { group, state } = classify(o.key, live);
        bump(group, state, o.size, o.key);
      }
    });
    row('objects listed', total);

    section('3. RESULT — UNREFERENCED OBJECTS BY KEY PREFIX');
    console.log('  "Orphaned" = the id in the key has no live owning row (story, user,');
    console.log('  character, file or landmark). It is NOT a URL scan: an object whose owner');
    console.log('  row still exists counts as referenced even if nothing links to it.\n');
    let orphanCount = 0; let orphanBytes = 0; let unaudited = 0;
    const sorted = [...groups.entries()].sort((a, b) => b[1].orphanBytes - a[1].orphanBytes);
    for (const [g, e] of sorted) {
      orphanCount += e.orphan; orphanBytes += e.orphanBytes; unaudited += e.unaudited;
      row(`  ${g}`, `${e.orphan} orphaned / ${e.referenced} referenced`
        + `${e.unaudited ? ` / ${e.unaudited} unaudited` : ''}`
        + `  —  ${bytes(e.orphanBytes)} orphaned of ${bytes(e.totalBytes)}`);
    }
    console.log('');
    row('TOTAL ORPHANED', `${orphanCount} object(s), ${bytes(orphanBytes)}`);
    if (unaudited) row('NOT AUDITED', `${unaudited} object(s) (key shape carries no usable owner id)`);

    if (listLimit && orphanCount) {
      section(`4. EXAMPLE ORPHANED KEYS (up to ${listLimit} per prefix)`);
      for (const [g, e] of sorted) {
        if (!e.samples.length) continue;
        console.log(`\n  ${g}`);
        for (const k of e.samples) console.log(`    ${k}`);
      }
    }

    section('READ-ONLY — NOTHING WAS DELETED');
    console.log('  This script has no delete mode by design (owner ruling Q7, 2026-09-12).');
    console.log('  An orphan is evidence of a silently-failed prune (stories.js:3334), not a');
    console.log('  thing to sweep automatically. Decide per prefix, by hand.\n');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('\n✗ FATAL:', err.message);
  console.error(err.stack);
  process.exit(1);
});
