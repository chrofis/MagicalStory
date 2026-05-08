/**
 * Migrate historical_locations.photo_data → R2.
 *
 * Each row has either a Wikipedia URL or a magicalstory:// tag in photo_url,
 * with the actual bytes inline in photo_data (~125 KB avg, 144 rows ≈ 18 MB).
 * Replace photo_url with the R2 URL, NULL the photo_data column.
 *
 * Readers (storyHelpers.js loadHistoricalLocations) store photoUrl + photoData
 * verbatim. Downstream consumers already prefer photoUrl via bytesFromAnyImage
 * (Phase 3) — it'll now fetch from R2 instead of falling back to photoData.
 *
 * Run from inside Railway:
 *   railway ssh "node scripts/admin/backfill-historical-locations.js [--dry]"
 */

require('dotenv').config();
process.env.STORAGE_MODE = process.env.STORAGE_MODE || 'database';
const { Pool } = require('pg');

const args = process.argv.slice(2);
const DRY = args.includes('--dry');

(async () => {
  const r2 = require('../../server/lib/r2');
  if (!r2.isConfigured()) {
    console.error('FATAL: R2 not configured');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('railway.app') ? { rejectUnauthorized: false } : false,
  });

  const candidates = await pool.query(
    `SELECT id, location_name, photo_url, length(photo_data) AS data_chars
     FROM historical_locations
     WHERE photo_data IS NOT NULL AND length(photo_data) > 1024
     ORDER BY length(photo_data) DESC`
  );

  console.log(`[backfill-locations] candidates: ${candidates.rows.length} rows`);
  if (candidates.rows.length === 0) {
    await pool.end();
    return;
  }
  if (DRY) {
    for (const r of candidates.rows.slice(0, 20)) {
      console.log(`  id=${r.id} ${Math.round(r.data_chars / 1024)} KB  ${r.location_name}  url=${r.photo_url || '(null)'}`);
    }
    if (candidates.rows.length > 20) console.log(`  ... +${candidates.rows.length - 20} more`);
    await pool.end();
    return;
  }

  // Drain in parallel pool of 12. Each iteration: SELECT bytes, upload, UPDATE.
  let processed = 0, failed = 0;
  const t0 = Date.now();

  let nextIdx = 0;
  const workers = new Array(Math.min(12, candidates.rows.length)).fill(null).map(async () => {
    while (true) {
      const myIdx = nextIdx++;
      if (myIdx >= candidates.rows.length) return;
      const row = candidates.rows[myIdx];
      try {
        // Fetch the actual bytes (we only have the size in candidates)
        const bytesRow = await pool.query("SELECT photo_data FROM historical_locations WHERE id = $1", [row.id]);
        if (bytesRow.rows.length === 0 || !bytesRow.rows[0].photo_data) continue;
        const slug = (row.location_name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const key = r2.keyForHistoricalLocationPhoto(row.id, slug);
        const url = await r2.uploadImage(bytesRow.rows[0].photo_data, key);
        if (!url) {
          process.stdout.write(`[${myIdx + 1}] FAIL upload: ${row.location_name}\n`);
          failed++;
          continue;
        }
        await pool.query("UPDATE historical_locations SET photo_url = $1, photo_data = NULL WHERE id = $2", [url, row.id]);
        process.stdout.write(`[${myIdx + 1}] OK ${Math.round(row.data_chars / 1024)} KB  ${row.location_name}\n`);
        processed++;
      } catch (err) {
        process.stdout.write(`[${myIdx + 1}] FAIL ${row.location_name}: ${err.message}\n`);
        failed++;
      }
    }
  });
  await Promise.all(workers);

  console.log(`\n[backfill-locations] done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  console.log(`  processed: ${processed}, failed: ${failed}`);
  await pool.end();
})().catch(e => { console.error('FATAL:', e.message, '\n', e.stack); process.exit(1); });
