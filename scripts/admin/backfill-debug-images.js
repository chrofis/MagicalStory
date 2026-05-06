/**
 * One-shot Phase 4 backfill: walk every story whose stories.data blob is
 * still bloated, push the inline debug bytes to R2, strip the residue,
 * UPDATE the row. Idempotent — re-runs only touch stories whose blob is
 * still oversized.
 *
 * Run from inside Railway so the private DB URL handles the large
 * jsonb reads (the public URL drops 100MB+ transfers mid-stream):
 *   railway run node --max-old-space-size=4096 scripts/admin/backfill-debug-images.js [--dry] [--limit=N] [--threshold-kb=1024]
 *
 * Or locally on a small dataset.
 *
 * Flags:
 *   --dry            : list stories that would be touched, no writes
 *   --limit=N        : process at most N stories (default: all)
 *   --threshold-kb=N : skip stories whose blob is already <= N KB (default: 1024)
 *   --story-id=ID    : process only this one story (for spot-checks)
 *   --sleep-ms=N     : delay between stories to ease R2 load (default: 250)
 */

require('dotenv').config();
process.env.STORAGE_MODE = process.env.STORAGE_MODE || 'database';
const { Pool } = require('pg');

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const LIMIT = (() => {
  const a = args.find(a => a.startsWith('--limit='));
  return a ? parseInt(a.split('=')[1], 10) : null;
})();
const THRESHOLD_KB = (() => {
  const a = args.find(a => a.startsWith('--threshold-kb='));
  return a ? parseInt(a.split('=')[1], 10) : 1024;
})();
const SINGLE_ID = (() => {
  const a = args.find(a => a.startsWith('--story-id='));
  return a ? a.split('=')[1] : null;
})();
const SLEEP_MS = (() => {
  const a = args.find(a => a.startsWith('--sleep-ms='));
  return a ? parseInt(a.split('=')[1], 10) : 250;
})();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const { initializePool } = require('../../server/services/database');
  initializePool();
  const { extractInlineImagesToR2, stripInlineImagesFromStoryData } = require('../../server/services/database');

  const r2 = require('../../server/lib/r2');
  if (!r2.isConfigured()) {
    console.error('FATAL: R2 not configured — set R2_* env vars first');
    process.exit(1);
  }

  // Use a separate pool for this script's queries (the service module's pool
  // is also alive after initializePool but we want long-lived statements).
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('railway.app') ? { rejectUnauthorized: false } : false,
  });

  // Find candidate stories: big enough AND not already marked as backfilled.
  // After a successful backfill we set data.r2BackfilledAt; that flag is the
  // single authoritative signal for 'this story has been through the
  // extract+strip pipeline'. The size filter is just a perf hint to skip
  // tiny rows; the marker is what prevents re-processing.
  let candidateRows;
  if (SINGLE_ID) {
    candidateRows = await pool.query(
      "SELECT id, pg_column_size(data) AS bytes FROM stories WHERE id = $1",
      [SINGLE_ID]
    );
  } else {
    const limitClause = LIMIT ? ` LIMIT ${LIMIT}` : '';
    candidateRows = await pool.query(
      `SELECT id, pg_column_size(data) AS bytes
       FROM stories
       WHERE pg_column_size(data) > $1
         AND NOT (data ? 'r2BackfilledAt')
       ORDER BY pg_column_size(data) DESC${limitClause}`,
      [THRESHOLD_KB * 1024]
    );
  }

  console.log(`[backfill] candidates: ${candidateRows.rows.length} stories (threshold ${THRESHOLD_KB} KB, limit ${LIMIT || '∞'})`);
  if (candidateRows.rows.length === 0) {
    console.log('[backfill] nothing to do');
    await pool.end();
    return;
  }

  if (DRY) {
    console.log('[backfill] DRY RUN — would process:');
    for (const row of candidateRows.rows) {
      console.log(`  ${row.id}  ${Math.round(row.bytes / 1024).toString().padStart(8)} KB`);
    }
    await pool.end();
    return;
  }

  let processed = 0, failed = 0, totalBytesBefore = 0, totalBytesAfter = 0;
  const startTime = Date.now();

  for (let i = 0; i < candidateRows.rows.length; i++) {
    const { id, bytes: beforeBytes } = candidateRows.rows[i];
    const idx = `[${i + 1}/${candidateRows.rows.length}]`;
    process.stdout.write(`${idx} ${id} (${Math.round(beforeBytes / 1024)} KB) … `);

    try {
      // SELECT the blob
      const t0 = Date.now();
      const r = await pool.query("SELECT data FROM stories WHERE id = $1", [id]);
      if (r.rows.length === 0) { process.stdout.write('GONE\n'); continue; }
      const data = r.rows[0].data;
      const tSelect = Date.now() - t0;

      // Extract -> R2, then strip
      const t1 = Date.now();
      await extractInlineImagesToR2(id, data);
      const tExtract = Date.now() - t1;

      stripInlineImagesFromStoryData(data);

      // Mark as backfilled so subsequent runs skip this story.
      data.r2BackfilledAt = new Date().toISOString();

      // Save back
      const newJson = JSON.stringify(data);
      const t2 = Date.now();
      await pool.query('UPDATE stories SET data = $1 WHERE id = $2', [newJson, id]);
      const tUpdate = Date.now() - t2;

      // Read back size for verification
      const v = await pool.query("SELECT pg_column_size(data) AS bytes FROM stories WHERE id = $1", [id]);
      const afterBytes = v.rows[0].bytes;
      totalBytesBefore += beforeBytes;
      totalBytesAfter += afterBytes;
      const savedKB = Math.round((beforeBytes - afterBytes) / 1024);
      const pct = Math.round(100 * (beforeBytes - afterBytes) / beforeBytes);
      process.stdout.write(`OK ${Math.round(afterBytes / 1024)} KB (-${savedKB} KB, ${pct}%) [select=${tSelect}ms extract=${tExtract}ms update=${tUpdate}ms]\n`);
      processed++;
    } catch (err) {
      process.stdout.write(`FAIL: ${err.message}\n`);
      failed++;
    }

    if (SLEEP_MS > 0 && i + 1 < candidateRows.rows.length) await sleep(SLEEP_MS);
  }

  const elapsedMin = ((Date.now() - startTime) / 60000).toFixed(2);
  const savedMB = Math.round((totalBytesBefore - totalBytesAfter) / (1024 * 1024));
  console.log(`\n[backfill] done in ${elapsedMin} min`);
  console.log(`  processed: ${processed}`);
  console.log(`  failed   : ${failed}`);
  console.log(`  reclaimed: ${savedMB} MB`);

  await pool.end();
})().catch(e => { console.error('FATAL:', e.message, '\n', e.stack); process.exit(1); });
