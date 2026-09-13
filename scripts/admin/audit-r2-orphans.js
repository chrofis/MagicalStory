#!/usr/bin/env node
/**
 * R2 ORPHAN AUDIT — READ ONLY. It has no delete mode and never will.
 *
 * Owner ruling 2026-09-12 (Q7, tasks/gdpr-erasure-2026-09-11.md §8): build the
 * audit, not a sweep. Deleting bucket objects from a script that infers
 * "unreferenced" from key shapes is how real images get lost; this reports and
 * writes a manifest, a human decides, and a separate script
 * (`delete-r2-orphans.js`) consumes only the reviewed manifest.
 *
 * Why orphans exist: `server/routes/stories.js` calls
 * `r2.deleteStoryArtefacts(id)` when a story is deleted, and that helper logs
 * failures and returns a count rather than throwing. A failed prune therefore
 * leaves objects behind with no DB row pointing at them, silently.
 *
 * ── HOW "REFERENCED" IS DECIDED (three independent gates, ALL must clear) ───
 *
 * An object is called an ORPHAN only when every one of these says "no owner":
 *
 *   GATE 1 — DIRECT URL SCAN (the authoritative one, added 2026-09-12).
 *     Every BASE TABLE in the `public` schema is cast to text row-by-row
 *     (`t::text` covers every column, including JSONB at arbitrary depth) and
 *     every `https://<R2_PUBLIC_URL host>/<key>` occurrence is extracted. This
 *     is discovery-based, not enumeration-based: a new table, a new column, or
 *     a URL parked at a JSONB path nobody enumerated is caught automatically.
 *     It is the answer to "did we miss a reference source?" — we cannot, short
 *     of a reference living outside the database entirely.
 *
 *   GATE 2 — AGE FLOOR. Nothing whose LastModified is newer than
 *     AGE_FLOOR_DAYS is ever classified orphan, whatever the other gates say.
 *     An in-flight generation writes its objects before the row that cites
 *     them, so a fresh object with no reference is normal, not garbage.
 *
 *   GATE 3 — OWNING ROW. The id embedded in the key must have no live row:
 *       stories/{A}/…                   A is a live stories.id, users.id
 *                                       (dbHousekeeping mints
 *                                       stories/{userId}/{storyId}/migrated/…),
 *                                       story_jobs.id, or orders.story_id
 *       characters/{userId}/{charId}/…  charId live OR userId live
 *       orders/pdf-{jobId}-{ts}.pdf     files.id live OR jobId is a live
 *                                       orders.story_id (an orders row does
 *                                       NOT store the PDF URL, so gate 1 is
 *                                       blind to it — see the note in
 *                                       ownerVerdict); unparseable → UNKNOWN
 *       landmarks/index/{landmarkId}/…  landmarkId is a live landmark_index.id
 *       landmarks/historical/{id}-{slug}  UNKNOWN, always — the slug makes the
 *                                       id ambiguous, so the shape carries no
 *                                       trustworthy owner. (These ARE fully
 *                                       resolved by gate 1 when referenced.)
 *       any other shape                 UNKNOWN, always.
 *
 * UNKNOWN is a first-class outcome and is NEVER folded into the orphan count.
 * Anything the script cannot confidently attribute stays UNKNOWN by design.
 *
 * Target: the bucket in `.env` (production — there are no staging R2
 * credentials, ruling Q8). The DB it compares against must be the one that
 * bucket serves; the host guard below enforces that.
 *
 * Usage
 *   node scripts/admin/audit-r2-orphans.js
 *   node scripts/admin/audit-r2-orphans.js --staging      # only if R2_* point at staging
 *   node scripts/admin/audit-r2-orphans.js --list=200     # print up to N example keys
 *   node scripts/admin/audit-r2-orphans.js --age-days=60  # raise the age floor
 *   node scripts/admin/audit-r2-orphans.js --out=path.json
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { Pool } = require('pg');
const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');

require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const { ch } = require(path.resolve(__dirname, '..', 'lib', 'chTime.js'));

/** Nothing newer than this is ever an orphan. */
const DEFAULT_AGE_FLOOR_DAYS = 30;

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
  console.log(`  ${String(label).padEnd(42)} ${value}`);
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

/** Walk the whole bucket, streaming batches to the caller. */
async function listAll(s3, onBatch) {
  let ContinuationToken;
  let seen = 0;
  do {
    const res = await s3.send(new ListObjectsV2Command({
      Bucket: process.env.R2_BUCKET, ContinuationToken, MaxKeys: 1000,
    }));
    const batch = (res.Contents || []).map((o) => ({
      key: o.Key, size: o.Size || 0, lastModified: o.LastModified || null,
    }));
    seen += batch.length;
    onBatch(batch);
    process.stderr.write(`\r  listing… ${seen} objects`);
    ContinuationToken = res.IsTruncated ? res.NextContinuationToken : null;
  } while (ContinuationToken);
  process.stderr.write('\r');
  return seen;
}

/**
 * GATE 1 — the direct URL scan.
 *
 * Discovers every base table itself rather than taking a hand-written list, so
 * a table added after this script was written is still scanned. Each row is
 * cast to text, which flattens every column (JSONB included) into one string,
 * and every public-URL occurrence is regexp-extracted. Only DISTINCT keys come
 * back over the wire, so a 150 MB `stories` table costs a few MB of client
 * memory, not 150.
 *
 * Returns { keys:Set<string>, perTable:Map<string,number>, skipped:[] }.
 */
async function scanReferencedKeys(client) {
  const host = new URL(process.env.R2_PUBLIC_URL).host.replace(/\./g, '\\.');
  // Key charset mirrors every keyFor* builder in server/lib/r2.js (all of them
  // sanitise to [A-Za-z0-9_-] plus '/' separators and a '.' extension).
  const RE = `${host}/([A-Za-z0-9_./-]+)`;

  const tables = (await client.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name`,
  )).rows.map((r) => r.table_name);

  const keys = new Set();
  const perTable = new Map();
  const skipped = [];

  for (const t of tables) {
    const sql = `SELECT DISTINCT m[1] AS k
                   FROM "${t}" src,
                        LATERAL regexp_matches(src::text, $1, 'g') m`;
    let res;
    try {
      res = await client.query(sql, [RE]);
    } catch (err) {
      // A table we cannot scan is a hole in gate 1 — that must be loud, not
      // silently treated as "no references here".
      skipped.push({ table: t, error: err.message });
      process.stderr.write(`\r`);
      console.error(`  ✗ URL scan FAILED on table "${t}": ${err.message}`);
      continue;
    }
    let added = 0;
    for (const r of res.rows) {
      // Trailing punctuation can ride along out of escaped JSON; strip nothing
      // but be sure the key is non-empty.
      const k = r.k;
      if (!k) continue;
      if (!keys.has(k)) added += 1;
      keys.add(k);
    }
    if (res.rows.length) perTable.set(t, res.rows.length);
    process.stderr.write(`\r  url-scan… ${t} (${res.rows.length} distinct, +${added} new)          `);
  }
  process.stderr.write('\r' + ' '.repeat(78) + '\r');
  return { keys, perTable, skipped, tables };
}

/** GATE 3 — every live owning id, loaded once as sets. */
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
    storyJobs: await ids('SELECT id FROM story_jobs'),
    // Story ids that still have a paid order. See ownerVerdict('orders/…').
    orderStoryIds: new Set(
      (await client.query("SELECT DISTINCT story_id AS id FROM orders WHERE story_id IS NOT NULL")).rows
        .map((r) => String(r.id)),
    ),
  };
}

/**
 * Owner-row verdict for a key shape.
 * @returns {{group:string, owner:'live'|'none'|'unknowable'}}
 */
function ownerVerdict(key, live) {
  const parts = key.split('/');

  if (parts[0] === 'stories' && parts.length >= 3) {
    const a = parts[1];
    // A story id, a user id (dbHousekeeping mints stories/{userId}/…), a
    // still-live story_jobs row, or a paid order pointing at that job all
    // count as an owner. The last two matter because the `stories` row can be
    // deleted while the job/order rows survive.
    const alive = live.stories.has(a) || live.users.has(a)
      || live.storyJobs.has(a) || live.orderStoryIds.has(a);
    return { group: 'stories/', owner: alive ? 'live' : 'none' };
  }
  if (parts[0] === 'characters' && parts.length >= 4) {
    const [, userId, charId] = parts;
    return { group: 'characters/', owner: (live.characters.has(charId) || live.users.has(userId)) ? 'live' : 'none' };
  }
  if (parts[0] === 'orders' && parts.length === 2) {
    const fileId = parts[1].replace(/\.pdf$/i, '');
    if (live.files.has(fileId)) return { group: 'orders/', owner: 'live' };
    // The `files` row is NOT the only owner. `files` is pruned aggressively
    // (a story delete takes its files with it) while the paid `orders` row
    // survives forever, and an orders row does not store the PDF URL — so
    // gate 1 cannot see it either. Found empirically 2026-09-12: all 22
    // orders/ candidates in the first hardened manifest belonged to live,
    // paid orders whose story had been deleted. Deleting them would have
    // destroyed the print artefact behind a real customer's order.
    //
    // The key is `pdf-{storyJobId}-{timestamp}.pdf`, so the job id is
    // recoverable — but only when it matches the job-id shape. If it does
    // not, the key is UNKNOWN, never an orphan.
    const m = /^pdf-(job_\d+_[a-z0-9]+)-\d+$/i.exec(fileId);
    if (!m) return { group: 'orders/', owner: 'unknowable' };
    return { group: 'orders/', owner: live.orderStoryIds.has(m[1]) ? 'live' : 'none' };
  }
  if (parts[0] === 'landmarks' && parts[1] === 'index' && parts.length >= 4) {
    return { group: 'landmarks/index/', owner: live.landmarks.has(parts[2]) ? 'live' : 'none' };
  }
  if (parts[0] === 'landmarks' && parts[1] === 'historical') {
    // `{rowId}-{slug}.jpg` — the slug can itself contain '-', so the row id is
    // not recoverable from the key. Gate 1 resolves these when referenced;
    // anything gate 1 missed stays UNKNOWN rather than becoming a candidate.
    return { group: 'landmarks/historical/', owner: 'unknowable' };
  }
  return { group: `${parts[0] || '(root)'}/ (unrecognised)`, owner: 'unknowable' };
}

/**
 * Final classification. Order matters: every gate that can rescue an object
 * runs before the one that condemns it.
 * @returns {{group:string, state:string, reason:string}}
 */
function classify(o, live, referencedKeys, ageFloorMs, now) {
  const { group, owner } = ownerVerdict(o.key, live);

  // GATE 1
  if (referencedKeys.has(o.key)) {
    return { group, state: 'referenced', reason: 'url-in-database' };
  }
  // GATE 2
  const lm = o.lastModified ? new Date(o.lastModified).getTime() : null;
  if (lm === null) {
    return { group, state: 'unknown', reason: 'no-last-modified' };
  }
  if (now - lm < ageFloorMs) {
    return { group, state: 'recent', reason: 'newer-than-age-floor' };
  }
  // GATE 3
  if (owner === 'live') {
    return { group, state: 'referenced', reason: 'owning-row-alive' };
  }
  if (owner === 'unknowable') {
    return { group, state: 'unknown', reason: 'key-shape-carries-no-owner-id' };
  }
  return { group, state: 'orphan', reason: 'no-url-reference-and-no-live-owning-row' };
}

async function main() {
  const argv = process.argv.slice(2);
  const args = new Set(argv.map((a) => a.split('=')[0]));
  const valueOf = (name, dflt) => {
    const a = argv.find((x) => x.startsWith(`${name}=`));
    return a ? a.slice(name.length + 1) : dflt;
  };
  const listLimit = Math.max(0, parseInt(valueOf('--list', '20'), 10) || 0);
  const ageDays = Number(valueOf('--age-days', String(DEFAULT_AGE_FLOOR_DAYS)));
  if (!Number.isFinite(ageDays) || ageDays < 0) die('--age-days must be a non-negative number.');
  const staging = args.has('--staging');

  const connectionString = staging ? process.env.STAGING_DATABASE_URL : process.env.DATABASE_URL;
  const envName = staging ? 'staging' : 'PRODUCTION';
  if (!connectionString) die(`${staging ? 'STAGING_DATABASE_URL' : 'DATABASE_URL'} is not set in .env.`);
  if (!process.env.R2_BUCKET || !process.env.R2_PUBLIC_URL) die('R2_* env vars are not configured.');

  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '').replace(/(\d{8})(\d{4})/, '$1-$2');
  const defaultOut = path.join(
    os.tmpdir(), `r2-orphan-manifest-${envName.toLowerCase()}-${stamp}.json`,
  );
  const outPath = path.resolve(valueOf('--out', defaultOut));

  console.log(`\n╔${'═'.repeat(74)}╗`);
  console.log(`║  R2 ORPHAN AUDIT — READ ONLY (nothing is ever deleted)${' '.repeat(20)}║`);
  console.log(`╚${'═'.repeat(74)}╝`);
  row('database', envName);
  row('bucket', process.env.R2_BUCKET);
  row('age floor', `${ageDays} day(s) — nothing newer can be an orphan`);
  row('time', ch(new Date()));

  const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();
  try {
    await assertBucketMatchesDatabase(client, envName);

    section('1. GATE 1 — DIRECT URL SCAN OF EVERY TABLE');
    console.log('  Every base table is cast to text (all columns, JSONB at any depth) and');
    console.log('  every public R2 URL is extracted. Tables are discovered, not listed, so a');
    console.log('  new table or column is covered without editing this script.\n');
    const scan = await scanReferencedKeys(client);
    row('tables scanned', scan.tables.length);
    for (const [t, n] of [...scan.perTable.entries()].sort((a, b) => b[1] - a[1])) {
      row(`  ${t}`, `${n} distinct key(s)`);
    }
    row('DISTINCT KEYS REFERENCED', scan.keys.size);
    if (scan.skipped.length) {
      console.log('');
      for (const s of scan.skipped) console.log(`  ✗ NOT SCANNED: ${s.table} — ${s.error}`);
      die(`${scan.skipped.length} table(s) could not be scanned. `
        + `Gate 1 is incomplete, so no orphan verdict from this run is trustworthy. `
        + `Fix the scan before using any manifest.`);
    }

    section('2. GATE 3 — LIVE OWNING ROWS');
    const live = await loadLiveIds(client);
    for (const [k, v] of Object.entries(live)) row(`  ${k}`, `${v.size} row(s)`);

    section('3. BUCKET WALK');
    const s3 = new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    });

    const now = Date.now();
    const ageFloorMs = ageDays * 24 * 60 * 60 * 1000;
    const groups = new Map();
    const candidates = []; // manifest entries — orphans only
    const bump = (g, state, size, key) => {
      if (!groups.has(g)) {
        groups.set(g, {
          referenced: 0, orphan: 0, unknown: 0, recent: 0,
          orphanBytes: 0, totalBytes: 0, samples: [],
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
        const { group, state, reason } = classify(o, live, scan.keys, ageFloorMs, now);
        bump(group, state, o.size, o.key);
        if (state === 'orphan') {
          candidates.push({
            key: o.key,
            size: o.size,
            lastModified: o.lastModified ? new Date(o.lastModified).toISOString() : null,
            prefix: group,
            reason,
          });
        }
      }
    });
    row('objects listed', total);

    section('4. RESULT BY KEY PREFIX');
    console.log('  referenced = a DB row cites its URL, or its owning row is alive.');
    console.log('  recent     = newer than the age floor; protected regardless.');
    console.log('  unknown    = cannot be attributed either way — NEVER a delete candidate.');
    console.log('  orphan     = no URL reference anywhere AND no live owning row AND old.\n');
    let orphanCount = 0; let orphanBytes = 0; let unknown = 0; let recent = 0; let referenced = 0;
    const sorted = [...groups.entries()].sort((a, b) => b[1].orphanBytes - a[1].orphanBytes);
    for (const [g, e] of sorted) {
      orphanCount += e.orphan; orphanBytes += e.orphanBytes;
      unknown += e.unknown; recent += e.recent; referenced += e.referenced;
      row(`  ${g}`, `${e.orphan} orphan / ${e.referenced} referenced`
        + `${e.recent ? ` / ${e.recent} recent` : ''}`
        + `${e.unknown ? ` / ${e.unknown} unknown` : ''}`
        + `  —  ${bytes(e.orphanBytes)} of ${bytes(e.totalBytes)}`);
    }
    console.log('');
    row('REFERENCED', `${referenced} object(s)`);
    row('RECENT (age-floor protected)', `${recent} object(s)`);
    row('UNKNOWN (never deletable)', `${unknown} object(s)`);
    row('ORPHAN CANDIDATES', `${orphanCount} object(s), ${bytes(orphanBytes)}`);

    section('5. MANIFEST');
    const manifest = {
      version: 1,
      generatedAt: new Date().toISOString(),
      generatedAtCh: ch(new Date()),
      environment: envName,
      bucket: process.env.R2_BUCKET,
      publicUrl: process.env.R2_PUBLIC_URL,
      ageFloorDays: ageDays,
      totals: {
        objectsInBucket: total,
        referenced,
        recent,
        unknown,
        orphanCandidates: orphanCount,
        orphanBytes,
      },
      gate1: {
        tablesScanned: scan.tables,
        distinctKeysReferenced: scan.keys.size,
        perTable: Object.fromEntries(scan.perTable),
      },
      liveOwnerCounts: Object.fromEntries(
        Object.entries(live).map(([k, v]) => [k, v.size]),
      ),
      byPrefix: Object.fromEntries(sorted.map(([g, e]) => [g, {
        orphan: e.orphan, referenced: e.referenced, recent: e.recent,
        unknown: e.unknown, orphanBytes: e.orphanBytes, totalBytes: e.totalBytes,
      }])),
      candidates,
    };
    fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2));
    row('written', outPath);
    row('candidates in manifest', candidates.length);
    console.log('\n  This manifest is the ONLY input the deleter accepts. Review it, then see');
    console.log('  scripts/admin/delete-r2-orphans.js (dry-run by default).');

    if (listLimit && orphanCount) {
      section(`6. EXAMPLE ORPHAN CANDIDATES (up to ${listLimit} per prefix)`);
      for (const [g, e] of sorted) {
        if (!e.samples.length) continue;
        console.log(`\n  ${g}`);
        for (const k of e.samples) console.log(`    ${k}`);
      }
    }

    section('READ-ONLY — NOTHING WAS DELETED');
    console.log('  This script has no delete mode by design (owner ruling Q7, 2026-09-12).\n');
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
