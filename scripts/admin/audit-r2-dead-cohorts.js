#!/usr/bin/env node
/**
 * R2 ORPHAN AUDIT — READ ONLY. This file cannot delete anything.
 *
 * GDPR ruling Q7 (2026-09-12, tasks/gdpr-erasure-2026-09-11.md §8): a read-only
 * audit of orphaned R2 objects, because `deleteStoryArtefacts`
 * (`server/routes/stories.js:3334`) logs a failed prune instead of throwing, so
 * objects can survive a story deletion and are then unreachable by any per-user
 * erasure.
 *
 * "Cannot delete" is a property of THIS FILE, not of a flag: it imports no
 * delete command, constructs no S3 client, and has no confirm or production
 * flag to mistype. The shared module it requires
 * (`scripts/lib/r2Cohorts.js`) exports no delete function either, so no
 * argument, typo or future edit to argument parsing can reach a delete path from
 * here. Restored 2026-09-13 after commit `3b1e18d2b` had folded the audit into a
 * `--report-only` flag on the deleting tool (docs/decisions.md, 2026-09-13).
 *
 * The scan, the cohort rule and the report are the SAME implementation the
 * delete tool uses, so the rule cannot drift between the two tools.
 *
 * Usage
 *   node scripts/admin/audit-r2-dead-cohorts.js
 *   node scripts/admin/audit-r2-dead-cohorts.js --list=200
 *
 * Options
 *   --age-days=30      cohort age floor used for the "would be swept" verdict
 *   --list=20          sample keys printed per prefix / per unknown prefix
 *   --out=path.json    manifest path (default: a temp file, path is printed)
 *   --no-manifest      skip writing the manifest
 */
'use strict';

const path = require('path');
const { parseScanOptions, scanAndReport } = require(path.resolve(__dirname, '..', 'lib', 'r2Cohorts.js'));

(async () => {
  const { pool } = await scanAndReport({
    options: parseScanOptions(process.argv.slice(2)),
    modeLabel: 'AUDIT — READ ONLY (this tool has no delete path)',
    toolName: 'audit-r2-dead-cohorts.js',
  });
  console.log('\nAudit complete — nothing was deleted; this tool cannot delete.');
  console.log('To sweep dead cohorts, use scripts/admin/delete-r2-dead-cohorts.js.\n');
  await pool.end();
})().catch((e) => { console.error('FATAL', e.message, e.stack); process.exit(1); });
