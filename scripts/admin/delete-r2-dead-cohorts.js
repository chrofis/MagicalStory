#!/usr/bin/env node
/**
 * R2 GARBAGE COLLECTION — the deleting tool. Reports, and (only when told twice)
 * deletes, objects belonging to DEAD COHORTS.
 *
 * The scan, the cohort rule and the whole report live in
 * `scripts/lib/r2Cohorts.js`, shared with the read-only entrypoint
 * `scripts/admin/audit-r2-dead-cohorts.js` (GDPR ruling Q7) so the rule cannot
 * drift between the two. Only the DELETE phase below is this file's own.
 *
 * A cohort is an owner prefix: `stories/{id}/` or `characters/{user}/{char}/`.
 * A cohort is DEAD only if ZERO of its objects appear in any URL stored anywhere
 * in the database. See the module header and docs/r2-storage.md.
 *
 * Consolidated 2026-09-13 from `audit-r2-orphans.js` (reporting, age floor,
 * manifest, bucket/DB host guard) + `delete-r2-orphans.js` (both deleted). Their
 * owning-row / id-attribution gates were DROPPED, not ported: that is the unsound
 * approach the cohort rule replaced.
 *
 * Modes
 *   --report-only      report + manifest, deletion is impossible in this mode
 *                      (for a file that CANNOT delete at all, use
 *                       scripts/admin/audit-r2-dead-cohorts.js)
 *   (default)          dry run: identical report, tells you how to delete
 *   --confirm --production   actually delete (BOTH flags required)
 *
 * Options
 *   --age-days=30      cohort age floor: a cohort whose NEWEST object is younger
 *                      than this is protected, whatever the references say. An
 *                      in-flight generation writes objects before the row citing
 *                      them, so a fresh unreferenced object is normal.
 *   --list=20          sample keys printed per prefix / per unknown prefix
 *   --out=path.json    manifest path (default: a temp file, path is printed)
 *   --no-manifest      skip writing the manifest
 */
'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { S3Client, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
const { parseScanOptions, scanAndReport, section, bytes, die } = require(path.resolve(__dirname, '..', 'lib', 'r2Cohorts.js'));

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const REPORT_ONLY = flag('--report-only');
const CONFIRM = flag('--confirm');
const PROD = flag('--production');
const LOG = './tasks/r2-deletion-log-' + new Date().toISOString().slice(0, 10) + '.jsonl';

(async () => {
  const deleting = CONFIRM && PROD && !REPORT_ONLY;
  const { pool, victims, deadBytes } = await scanAndReport({
    options: parseScanOptions(argv),
    modeLabel: REPORT_ONLY ? 'REPORT ONLY (deletion impossible)'
      : deleting ? '!!  LIVE DELETE' : 'DRY RUN (no --confirm --production)',
    toolName: 'delete-r2-dead-cohorts.js',
  });

  if (REPORT_ONLY) {
    console.log('\n--report-only — nothing deleted, deletion is not possible in this mode.\n');
    await pool.end();
    return;
  }
  if (!CONFIRM || !PROD) {
    console.log('\nDRY RUN — nothing deleted. Pass --confirm --production to delete.\n');
    await pool.end();
    return;
  }

  // 6. Delete in batches of 1000 (S3 API max), logging every key removed.
  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
  });
  section('7. DELETING');
  let done = 0;
  for (let i = 0; i < victims.length; i += 1000) {
    const batch = victims.slice(i, i + 1000);
    const res = await s3.send(new DeleteObjectsCommand({
      Bucket: process.env.R2_BUCKET,
      Delete: { Objects: batch.map((b) => ({ Key: b.k })), Quiet: true },
    }));
    if (res.Errors && res.Errors.length) {
      die(`R2 reported ${res.Errors.length} errors, first: ${JSON.stringify(res.Errors[0])}`);
    }
    fs.appendFileSync(LOG, batch.map((b) => JSON.stringify({ ts: new Date().toISOString(), key: b.k, size: b.size })).join('\n') + '\n');
    done += batch.length;
    console.log(`  deleted ${done}/${victims.length}`);
  }
  console.log(`\nDONE: ${done} objects, ${bytes(deadBytes)}. Log: ${LOG}`);
  await pool.end();
})().catch((e) => { console.error('FATAL', e.message, e.stack); process.exit(1); });
