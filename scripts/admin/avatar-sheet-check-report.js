#!/usr/bin/env node
'use strict';

/**
 * How often did the avatar sheet check fire, and did the redo help? (docs/decisions.md 2026-10-10 "Avatar sheets are ONE Grok 2 call";
 * tasks/verify.json avatar-sheet-check-usefulness-50-runs: remove the check if it never earned its call after 50 sheets.)
 *
 * Reads the `sheetCheck` record that server/lib/oneCallSheet.js writes on every styled-avatar log entry (stories.data
 * styledAvatarGeneration / costumedAvatarGeneration) and counts: sheets, judged, judge errors, flagged first sheets (by type),
 * redone, the redo shipped, shipped flagged, redo failed. Read-only.
 *
 *   node scripts/admin/avatar-sheet-check-report.js [--env=staging|prod] [--since=2026-10-10] [--list]
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const flag = (n, d = null) => { const a = process.argv.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const env = flag('env', 'staging');
const since = flag('since', '2026-10-10');

/** Pure: the counts of a list of sheetCheck records. Exported for the unit test. */
function summarize(checks) {
  const out = { sheets: checks.length, judged: 0, judgeErrors: 0, flaggedFirst: 0, flagsByType: {}, redone: 0, redoShippedBetter: 0, redoKeptFirst: 0, shippedFlagged: 0, redoFailed: 0, wallMsMean: null };
  let ms = 0;
  for (const c of checks) {
    if (c.judged) out.judged++;
    if (c.judgeError) out.judgeErrors++;
    if (c.firstFlags && c.firstFlags.length) {
      out.flaggedFirst++;
      for (const d of c.firstFlags) out.flagsByType[d.type] = (out.flagsByType[d.type] || 0) + 1;
    }
    if (c.redone) {
      out.redone++;
      if (c.redoError) out.redoFailed++;
      else if (c.shipped === 'second') out.redoShippedBetter++;
      else out.redoKeptFirst++;
    }
    const shipped = c.shipped === 'second' ? c.secondFlags : c.firstFlags;
    if (shipped && shipped.length) out.shippedFlagged++;
    ms += Number(c.totalMs) || 0;
  }
  out.wallMsMean = checks.length ? Math.round(ms / checks.length) : null;
  return out;
}

async function main() {
  const url = env === 'prod' ? process.env.DATABASE_URL : process.env.STAGING_DATABASE_URL;
  if (!url) throw new Error(`no database url for --env=${env}`);
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  const res = await pool.query(
    `SELECT id, created_at, jsonb_array_elements(COALESCE(data->'styledAvatarGeneration','[]'::jsonb) || COALESCE(data->'costumedAvatarGeneration','[]'::jsonb)) AS entry
       FROM stories WHERE created_at >= $1 AND (data ? 'styledAvatarGeneration' OR data ? 'costumedAvatarGeneration')`, [since]);
  await pool.end();
  const rows = res.rows.filter(r => r.entry && r.entry.sheetCheck);
  const summary = summarize(rows.map(r => r.entry.sheetCheck));
  console.log(`avatar sheet check since ${since} on ${env}:`, JSON.stringify(summary, null, 2));
  console.log(summary.sheets >= 50
    ? (summary.flaggedFirst === 0 || summary.redoShippedBetter === 0
      ? 'RULE: 50 or more sheets and the check never fired / the redo never shipped a better sheet: REMOVE the check (decisions entry).'
      : 'RULE: 50 or more sheets and the check fired and the redo helped: record "kept" with these numbers.')
    : `RULE: ${summary.sheets} of 50 sheets recorded: wait.`);
  if (process.argv.includes('--list')) for (const r of rows) console.log(r.id, r.entry.characterName, r.entry.clothingCategory, JSON.stringify(r.entry.sheetCheck));
}

if (require.main === module) main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
module.exports = { summarize };
