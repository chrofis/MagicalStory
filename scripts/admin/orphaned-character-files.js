#!/usr/bin/env node
/**
 * Orphaned character files on R2 — READ ONLY (no delete command is imported).
 *
 * Lists objects under `characters/` that no database row references, grouped by
 * user. Before server/lib/characterR2.js (2026-10-21) deleting a character left
 * its files behind (bug character-delete-leaves-photos-on-r2); this finds them.
 * "Referenced" = the exact key appears in a URL anywhere in any table of any
 * database that writes to the bucket (same scan as audit-r2-dead-cohorts.js,
 * scripts/lib/r2Cohorts.js scanReferencedKeys).
 *
 * Usage: node scripts/admin/orphaned-character-files.js [--env=prod|staging] [--user=<id>] [--list=all|N]
 *   Staging shares the production bucket and both databases are always scanned,
 *   so --env only validates the choice; staging is not a separate view.
 */
'use strict';
require('dotenv').config();
const path = require('path');
const { Pool } = require('pg');
const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { scanReferencedKeys, bytes, section, row, die } = require(path.resolve(__dirname, '..', 'lib', 'r2Cohorts.js'));

const arg = (n, d) => { const a = process.argv.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const env = arg('env', 'prod');
if (!['prod', 'staging'].includes(env)) die('--env must be prod or staging.');
const onlyUser = arg('user', null);
const listN = arg('list', 'all');
if (!process.env.DATABASE_URL || !process.env.R2_BUCKET) die('DATABASE_URL and R2_BUCKET must be set in .env.');

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
  });
  section(`ORPHANED CHARACTER FILES — READ ONLY — bucket ${process.env.R2_BUCKET} (env ${env})`);
  const { referenced, tablesScanned, databases } = await scanReferencedKeys(pool);
  row('databases / tables scanned', `${databases} / ${tablesScanned}`);
  row('distinct keys referenced', referenced.size);

  const orphans = []; let total = 0; let token;
  const prefix = onlyUser ? `characters/${onlyUser}/` : 'characters/';
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: process.env.R2_BUCKET, Prefix: prefix, ContinuationToken: token, MaxKeys: 1000 }));
    for (const o of r.Contents || []) {
      total++;
      if (!referenced.has(o.Key)) orphans.push({ key: o.Key, size: o.Size || 0, lm: o.LastModified });
    }
    token = r.NextContinuationToken;
  } while (token);

  section('RESULT');
  row('objects under ' + prefix, total);
  row('unreferenced (orphaned)', `${orphans.length} / ${bytes(orphans.reduce((s, o) => s + o.size, 0))}`);
  const byUser = new Map();
  for (const o of orphans) { const u = o.key.split('/')[1]; (byUser.get(u) || byUser.set(u, []).get(u)).push(o); }
  for (const [u, os] of [...byUser].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n  user ${u}: ${os.length} orphaned object(s), ${bytes(os.reduce((s, o) => s + o.size, 0))}`);
    for (const o of (listN === 'all' ? os : os.slice(0, Number(listN) || 0))) {
      console.log(`    ${o.key}  (${o.size} B, ${o.lm ? new Date(o.lm).toISOString() : '?'})`);
    }
  }
  console.log('\nNothing was deleted; this tool cannot delete.');
  await pool.end();
})().catch(e => { console.error('FATAL', e.stack || e.message); process.exit(1); });
