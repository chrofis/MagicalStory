#!/usr/bin/env node
/**
 * Delete R2 objects belonging to DEAD COHORTS.
 *
 * A cohort is an owner prefix: `stories/{id}/` or `characters/{user}/{char}/`.
 * A cohort is DEAD only if ZERO of its objects appear in any URL stored anywhere
 * in the database. No id parsing, no substring matching, no type coercion — three
 * earlier classifiers failed on exactly those (2026-09-13, see docs/decisions.md).
 *
 * `orders/`, `landmarks/` and any unrecognised top-level prefix are protected
 * outright and can never be deleted, regardless of reference state.
 *
 * Dry-run by default. Requires --confirm AND --production to delete.
 */
require('dotenv').config();
const fs = require('fs');
const { S3Client, ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
const { Pool } = require('pg');

const HOST = 'https://images.magicalstory.ch/';
const argv = process.argv.slice(2);
const CONFIRM = argv.includes('--confirm');
const PROD = argv.includes('--production');
const LOG = './tasks/r2-deletion-log-' + new Date().toISOString().slice(0, 10) + '.jsonl';

function cohortOf(key) {
  const s = key.split('/');
  if (s[0] === 'orders') return { id: 'orders/', protected: true };
  if (s[0] === 'landmarks') return { id: 'landmarks/', protected: true };
  if (s[0] === 'stories' && s[1] && s.length >= 3) return { id: `stories/${s[1]}/` };
  if (s[0] === 'characters' && s[1] && s[2]) return { id: `characters/${s[1]}/${s[2]}/` };
  return { id: 'UNKNOWN/' + s[0] + '/', protected: true };   // never deletable
}

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
  });

  // 1. Every URL stored anywhere. A table that fails to scan is a HARD STOP —
  //    a silent zero there would mark that table's objects deletable.
  const tables = await pool.query(
    "select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE'"
  );
  const referenced = new Set();
  for (const { table_name: tn } of tables.rows) {
    try {
      const r = await pool.query(`select string_agg(src::text,' ') s from "${tn}" src`);
      const blob = r.rows[0] && r.rows[0].s;
      if (!blob) continue;
      (blob.match(/https:\/\/images\.magicalstory\.ch\/[^"'\s,}\]\)]+/g) || [])
        .forEach(u => referenced.add(u.slice(HOST.length)));
    } catch (err) {
      console.error(`FATAL: could not scan table ${tn}: ${err.message}`);
      process.exit(1);
    }
  }
  console.log(`referenced keys: ${referenced.size} (from ${tables.rows.length} tables)`);

  // 2. Bucket walk, grouped by cohort.
  const cohorts = new Map();
  let token, total = 0;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: process.env.R2_BUCKET, ContinuationToken: token }));
    for (const o of r.Contents || []) {
      total++;
      const c = cohortOf(o.Key);
      let e = cohorts.get(c.id);
      if (!e) { e = { protected: !!c.protected, keys: [], bytes: 0, refd: 0 }; cohorts.set(c.id, e); }
      e.keys.push({ k: o.Key, size: o.Size });
      e.bytes += o.Size;
      if (referenced.has(o.Key)) e.refd++;
    }
    token = r.NextContinuationToken;
  } while (token);

  const dead = [...cohorts.entries()].filter(([, e]) => !e.protected && e.refd === 0);
  const victims = dead.flatMap(([, e]) => e.keys);
  const bytes = dead.reduce((s, [, e]) => s + e.bytes, 0);

  console.log(`bucket objects: ${total}`);
  console.log(`DEAD cohorts: ${dead.length} -> ${victims.length} objects, ${(bytes / 1048576).toFixed(1)} MB`);
  console.log(`protected cohorts: ${[...cohorts.values()].filter(e => e.protected).length}`);

  // 3. Final safety: not one victim may be referenced.
  const leak = victims.filter(v => referenced.has(v.k));
  if (leak.length) { console.error(`FATAL: ${leak.length} referenced keys in the victim set — aborting`); process.exit(1); }

  if (!CONFIRM || !PROD) {
    console.log('\nDRY RUN — nothing deleted. Pass --confirm --production to delete.');
    await pool.end();
    return;
  }

  // 4. Delete in batches of 1000 (S3 API max), logging every key removed.
  let done = 0;
  for (let i = 0; i < victims.length; i += 1000) {
    const batch = victims.slice(i, i + 1000);
    const res = await s3.send(new DeleteObjectsCommand({
      Bucket: process.env.R2_BUCKET,
      Delete: { Objects: batch.map(b => ({ Key: b.k })), Quiet: true },
    }));
    if (res.Errors && res.Errors.length) {
      console.error(`FATAL: R2 reported ${res.Errors.length} errors, first: ${JSON.stringify(res.Errors[0])}`);
      process.exit(1);
    }
    fs.appendFileSync(LOG, batch.map(b => JSON.stringify({ key: b.k, size: b.size })).join('\n') + '\n');
    done += batch.length;
    console.log(`  deleted ${done}/${victims.length}`);
  }
  console.log(`\nDONE: ${done} objects, ${(bytes / 1048576).toFixed(1)} MB. Log: ${LOG}`);
  await pool.end();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
