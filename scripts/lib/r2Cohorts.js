'use strict';
/**
 * R2 COHORT SCAN — the ONE implementation of the cohort rule, shared by both
 * entrypoints so the rule can never drift between them:
 *
 *   scripts/admin/audit-r2-dead-cohorts.js   read-only (GDPR control, ruling Q7)
 *   scripts/admin/delete-r2-dead-cohorts.js  the same report, plus deletion
 *
 * This module LISTS and REPORTS. It never deletes: no delete command is imported
 * here and no delete function is exported, so a caller that requires
 * only this module cannot reach a delete path at all. The delete tool builds its
 * own client for its own delete phase.
 *
 * A cohort is an owner prefix: `stories/{id}/` or `characters/{user}/{char}/`.
 * A cohort is DEAD only if ZERO of its objects appear in any URL stored anywhere
 * in the database. No id parsing, no substring matching, no type coercion — three
 * earlier classifiers failed on exactly those (2026-09-13, see docs/decisions.md
 * "R2 garbage collection is COHORT-based" and docs/r2-storage.md).
 *
 * `orders/`, `landmarks/` and any unrecognised top-level prefix are protected
 * outright and can never be deleted, regardless of reference state. Unrecognised
 * prefixes are also REPORTED loudly, with samples, so a new key shape is noticed.
 */

require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { Pool } = require('pg');
const { ch } = require(path.resolve(__dirname, 'chTime.js'));

const HOST = (process.env.R2_PUBLIC_URL || 'https://images.magicalstory.ch').replace(/\/*$/, '') + '/';
const DEFAULT_AGE_FLOOR_DAYS = 30;

function die(msg) { console.error(`\nFATAL: ${msg}\n`); process.exit(1); }
function bytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
}
function section(t) { console.log(`\n${'─'.repeat(76)}\n${t}\n${'─'.repeat(76)}`); }
function row(l, v) { console.log(`  ${String(l).padEnd(44)} ${v}`); }

/**
 * The options both entrypoints share. Mode flags (--report-only, --confirm,
 * --production) are NOT parsed here — they belong to the tool that has modes.
 */
function parseScanOptions(argv) {
  const flag = (n) => argv.includes(n);
  const valueOf = (n, d) => {
    const a = argv.find((x) => x.startsWith(`${n}=`));
    return a ? a.slice(n.length + 1) : d;
  };
  return {
    writeManifest: !flag('--no-manifest'),
    list: Math.max(0, parseInt(valueOf('--list', '20'), 10) || 0),
    ageDays: Number(valueOf('--age-days', String(DEFAULT_AGE_FLOOR_DAYS))),
    out: valueOf('--out', null),
  };
}

/**
 * Cohort = owner prefix. NOTHING in a key is interpreted as an id; segments are
 * only ever used to delimit the prefix and to compare exact key strings.
 */
function cohortOf(key) {
  const s = key.split('/');
  if (s[0] === 'orders') return { id: 'orders/', prefix: 'orders/', protected: true };
  if (s[0] === 'landmarks') return { id: 'landmarks/', prefix: 'landmarks/', protected: true };
  if (s[0] === 'stories' && s[1] && s.length >= 3) return { id: `stories/${s[1]}/`, prefix: 'stories/' };
  if (s[0] === 'characters' && s[1] && s[2]) return { id: `characters/${s[1]}/${s[2]}/`, prefix: 'characters/' };
  return { id: 'UNKNOWN/' + s[0] + '/', prefix: `UNKNOWN/${s[0] || '(root)'}/`, protected: true, unknown: true };
}

/**
 * Sub-kind, for reporting only — never for a deletion decision. A fixed
 * vocabulary of path segments (plus the `tl_*` Test Lab shape); anything else is
 * `other`, so an id segment can never explode the report's cardinality.
 */
const SUB_KINDS = new Set([
  'debug', 'aux', 'retry', 'vb', 'empty_scene', 'empty-scene', 'style-lab',
  'styled-avatars', 'migrated', 'photos', 'avatars', 'thumbs', 'styled',
  'characters', 'index', 'historical',
]);
function subKindOf(key) {
  for (const seg of key.split('/').slice(1)) {
    if (/^tl_/.test(seg)) return 'tl_*';
    if (SUB_KINDS.has(seg)) return seg;
  }
  return 'other';
}

/** Prove the bucket in .env belongs to the database in DATABASE_URL. */
async function assertBucketMatchesDatabase(pool) {
  const sample = (await pool.query(
    "SELECT image_url FROM story_images WHERE image_url LIKE 'http%' ORDER BY id DESC LIMIT 1",
  )).rows[0];
  if (!sample) { row('bucket verified', 'SKIPPED — no stored image URL on this database'); return; }
  const dbHost = new URL(sample.image_url).host;
  const cfgHost = new URL(HOST).host;
  if (dbHost !== cfgHost) {
    die(`R2 BUCKET MISMATCH — refusing to run.\n`
      + `    database serves images from : ${dbHost}\n`
      + `    R2_PUBLIC_URL points at     : ${cfgHost}  (bucket "${process.env.R2_BUCKET}")\n\n`
      + `  Every cohort would look dead, because this bucket holds none of that\n`
      + `  database's images.`);
  }
  row('bucket verified', `${process.env.R2_BUCKET} (${cfgHost}) matches the database`);
}

/**
 * Run the whole read-only half: preflight, banner, reference scan, bucket walk,
 * verdicts, report, manifest. Returns the victim list so a caller that IS a
 * delete tool can act on it; this module itself never deletes.
 *
 * @param {object} p
 * @param {object} p.options   from parseScanOptions()
 * @param {string} p.modeLabel printed on the `mode` row
 * @param {string} p.toolName  recorded in the manifest
 */
async function scanAndReport({ options, modeLabel, toolName }) {
  const { writeManifest: WRITE_MANIFEST, list: LIST, ageDays: AGE_DAYS } = options;
  if (!Number.isFinite(AGE_DAYS) || AGE_DAYS < 0) die('--age-days must be a non-negative number.');
  if (!process.env.DATABASE_URL) die('DATABASE_URL is not set in .env.');
  if (!process.env.R2_BUCKET) die('R2_BUCKET is not set in .env.');

  console.log(`\n╔${'═'.repeat(74)}╗`);
  console.log(`║  R2 COHORT GARBAGE COLLECTION${' '.repeat(45)}║`);
  console.log(`╚${'═'.repeat(74)}╝`);
  row('mode', modeLabel);
  row('bucket', process.env.R2_BUCKET);
  row('age floor', `${AGE_DAYS} day(s) — no cohort younger than this is swept`);
  row('time', ch(new Date()));

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
  });

  await assertBucketMatchesDatabase(pool);

  // 1. Every URL stored anywhere. A table that fails to scan is a HARD STOP —
  //    a silent zero there would mark that table's objects deletable.
  section('1. REFERENCE SCAN — every base table, cast to text');
  const tables = await pool.query(
    "select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by table_name"
  );
  const referenced = new Set();
  const perTable = new Map();
  for (const { table_name: tn } of tables.rows) {
    try {
      const r = await pool.query(`select string_agg(src::text,' ') s from "${tn}" src`);
      const blob = r.rows[0] && r.rows[0].s;
      if (!blob) continue;
      const hits = blob.match(new RegExp(HOST.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') + `[^"'\\s,}\\]\\)]+`, 'g')) || [];
      const before = referenced.size;
      hits.forEach((u) => referenced.add(u.slice(HOST.length)));
      if (hits.length) perTable.set(tn, { hits: hits.length, newKeys: referenced.size - before });
    } catch (err) {
      die(`could not scan table ${tn}: ${err.message}\n  The reference set is incomplete, so no verdict from this run is trustworthy.`);
    }
  }
  for (const [t, e] of [...perTable.entries()].sort((a, b) => b[1].hits - a[1].hits)) {
    row(`  ${t}`, `${e.hits} url(s), +${e.newKeys} new key(s)`);
  }
  row('TABLES SCANNED', tables.rows.length);
  row('DISTINCT KEYS REFERENCED', referenced.size);

  // 2. Bucket walk, grouped by cohort.
  section('2. BUCKET WALK');
  const cohorts = new Map();
  const prefixes = new Map();     // prefix -> { objects, bytes, referenced, unreferenced, sub: Map }
  const unknownSamples = new Map();
  let token; let total = 0; let totalBytes = 0;
  const now = Date.now();
  const ageFloorMs = AGE_DAYS * 86400000;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: process.env.R2_BUCKET, ContinuationToken: token, MaxKeys: 1000 }));
    for (const o of r.Contents || []) {
      total++; totalBytes += o.Size || 0;
      const c = cohortOf(o.Key);
      const isRef = referenced.has(o.Key);
      const lm = o.LastModified ? new Date(o.LastModified).getTime() : null;

      let e = cohorts.get(c.id);
      if (!e) { e = { protected: !!c.protected, prefix: c.prefix, keys: [], bytes: 0, refd: 0, newest: 0, unknownAge: false }; cohorts.set(c.id, e); }
      e.keys.push({ k: o.Key, size: o.Size || 0 });
      e.bytes += o.Size || 0;
      if (isRef) e.refd++;
      if (lm === null) e.unknownAge = true; else if (lm > e.newest) e.newest = lm;

      let p = prefixes.get(c.prefix);
      if (!p) { p = { objects: 0, bytes: 0, referenced: 0, unreferenced: 0, sub: new Map() }; prefixes.set(c.prefix, p); }
      p.objects++; p.bytes += o.Size || 0;
      if (isRef) p.referenced++; else p.unreferenced++;
      const sk = subKindOf(o.Key);
      let s = p.sub.get(sk);
      if (!s) { s = { objects: 0, bytes: 0, referenced: 0, unreferenced: 0 }; p.sub.set(sk, s); }
      s.objects++; s.bytes += o.Size || 0;
      if (isRef) s.referenced++; else s.unreferenced++;

      if (c.unknown) {
        if (!unknownSamples.has(c.prefix)) unknownSamples.set(c.prefix, []);
        const arr = unknownSamples.get(c.prefix);
        if (arr.length < LIST) arr.push(o.Key);
      }
    }
    token = r.NextContinuationToken;
    process.stderr.write(`\r  listing… ${total} objects`);
  } while (token);
  process.stderr.write('\r' + ' '.repeat(50) + '\r');
  row('objects in bucket', `${total} — ${bytes(totalBytes)}`);
  row('cohorts', cohorts.size);

  // 3. Verdicts.
  const dead = [];
  let protectedCohorts = 0; let liveCohorts = 0; let ageHeld = 0; let ageHeldObjects = 0;
  for (const [id, e] of cohorts) {
    if (e.protected) { protectedCohorts++; continue; }
    if (e.refd > 0) { liveCohorts++; continue; }
    // AGE FLOOR — cohort level, because deletion is all-or-nothing per cohort.
    if (e.unknownAge || (now - e.newest) < ageFloorMs) { ageHeld++; ageHeldObjects += e.keys.length; continue; }
    dead.push([id, e]);
  }
  const victims = dead.flatMap(([, e]) => e.keys);
  const deadBytes = dead.reduce((s, [, e]) => s + e.bytes, 0);

  section('3. RESULT BY PREFIX AND SUB-KIND');
  console.log('  referenced   = this exact key appears in a URL stored in the database.');
  console.log('  unreferenced = it does not — which alone is NEVER proof it is dead.');
  console.log('  Deletion is decided per COHORT, not per object; see the next section.\n');
  for (const [pfx, p] of [...prefixes.entries()].sort((a, b) => b[1].bytes - a[1].bytes)) {
    row(pfx, `${p.objects} obj / ${bytes(p.bytes)} — ${p.referenced} referenced, ${p.unreferenced} unreferenced`);
    for (const [sk, s] of [...p.sub.entries()].sort((a, b) => b[1].bytes - a[1].bytes)) {
      row(`    ${sk}`, `${s.objects} obj / ${bytes(s.bytes)} — ${s.referenced} ref, ${s.unreferenced} unref`);
    }
  }

  section('4. UNKNOWN PREFIXES (protected unconditionally — and reported loudly)');
  if (!unknownSamples.size) {
    console.log('  none — every key matched a known prefix shape.');
  } else {
    console.log('  These key shapes are not in the prefix map. They can NEVER be deleted,');
    console.log('  but each one is a shape docs/r2-storage.md does not yet describe.\n');
    for (const [pfx, samples] of unknownSamples) {
      const p = prefixes.get(pfx);
      row(pfx, `${p.objects} obj / ${bytes(p.bytes)} — ${p.referenced} referenced`);
      for (const k of samples) console.log(`      ${k}`);
    }
  }

  section('5. COHORT VERDICT');
  row('protected cohorts (orders/landmarks/unknown)', protectedCohorts);
  row('live cohorts (>= 1 referenced object)', liveCohorts);
  row(`age-held cohorts (newer than ${AGE_DAYS}d)`, `${ageHeld} — ${ageHeldObjects} object(s)`);
  row('DEAD COHORTS', `${dead.length} -> ${victims.length} object(s), ${bytes(deadBytes)}`);
  if (LIST && dead.length) {
    console.log('');
    for (const [id, e] of dead.slice(0, LIST)) console.log(`      ${id}  (${e.keys.length} obj, ${bytes(e.bytes)})`);
    if (dead.length > LIST) console.log(`      … and ${dead.length - LIST} more (raise --list, or read the manifest)`);
  }

  // 4. Final safety: not one victim may be referenced.
  const leak = victims.filter((v) => referenced.has(v.k));
  if (leak.length) die(`${leak.length} referenced keys in the victim set — aborting`);

  // 5. Manifest for review.
  if (WRITE_MANIFEST) {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T-]/g, '');
    const outPath = path.resolve(options.out || path.join(os.tmpdir(), `r2-dead-cohorts-${stamp}.json`));
    fs.writeFileSync(outPath, JSON.stringify({
      version: 2,
      tool: toolName,
      rule: 'cohort: dead only if ZERO objects of the owner prefix are referenced anywhere in the DB',
      generatedAt: new Date().toISOString(),
      generatedAtCh: ch(new Date()),
      bucket: process.env.R2_BUCKET,
      publicUrl: HOST,
      ageFloorDays: AGE_DAYS,
      totals: {
        objectsInBucket: total, bytesInBucket: totalBytes,
        distinctKeysReferenced: referenced.size,
        cohorts: cohorts.size, protectedCohorts, liveCohorts,
        ageHeldCohorts: ageHeld, ageHeldObjects,
        deadCohorts: dead.length, deadObjects: victims.length, deadBytes,
      },
      tablesScanned: tables.rows.map((r) => r.table_name),
      perTable: Object.fromEntries([...perTable.entries()].map(([t, e]) => [t, e.hits])),
      byPrefix: Object.fromEntries([...prefixes.entries()].map(([pfx, p]) => [pfx, {
        objects: p.objects, bytes: p.bytes, referenced: p.referenced, unreferenced: p.unreferenced,
        bySubKind: Object.fromEntries([...p.sub.entries()]),
      }])),
      unknownPrefixes: Object.fromEntries(unknownSamples),
      deadCohorts: dead.map(([id, e]) => ({ cohort: id, objects: e.keys.length, bytes: e.bytes, keys: e.keys.map((k) => k.k) })),
    }, null, 2));
    section('6. MANIFEST');
    row('written', outPath);
    console.log('\n  Review it before deleting. Note: unlike the old two-script flow, the');
    console.log('  manifest is a REVIEW artefact only — it is never an input, so a stale or');
    console.log('  hand-edited file can never drive a delete.');
  }

  return { pool, victims, deadBytes, deadCohorts: dead.length, bytes };
}

module.exports = {
  DEFAULT_AGE_FLOOR_DAYS,
  HOST,
  parseScanOptions,
  cohortOf,
  subKindOf,
  bytes,
  section,
  row,
  die,
  scanAndReport,
};
