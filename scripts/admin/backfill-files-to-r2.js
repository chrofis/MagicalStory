/**
 * Migrate files.file_data → R2.
 *
 * 42 rows × ~7.5 MB = ~316 MB of order PDFs in Postgres. The
 * /api/files/:fileId endpoint already redirects to file_url when set;
 * this script uploads each row's bytes to R2 (with the file's mime_type)
 * and stores the R2 URL on file_url, then NULLs file_data.
 *
 * Run from inside Railway:
 *   railway ssh "node --max-old-space-size=4096 scripts/admin/backfill-files-to-r2.js [--dry] [--limit=N]"
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

  const limitClause = LIMIT ? ` LIMIT ${LIMIT}` : '';
  const candidates = await pool.query(
    `SELECT id, filename, file_type, mime_type, file_size
     FROM files
     WHERE file_data IS NOT NULL AND file_url IS NULL
     ORDER BY file_size DESC${limitClause}`
  );

  console.log(`[backfill-files] candidates: ${candidates.rows.length} rows`);
  if (DRY) {
    for (const r of candidates.rows.slice(0, 50)) {
      console.log(`  ${(r.file_size/1024/1024).toFixed(1).padStart(6)} MB  ${r.file_type}  ${r.filename || '(no name)'}  id=${r.id}`);
    }
    await pool.end();
    return;
  }
  if (candidates.rows.length === 0) { await pool.end(); return; }

  let processed = 0, failed = 0, totalBytes = 0;
  const t0 = Date.now();
  let nextIdx = 0;
  const PARALLEL = 6; // PDFs are larger — fewer concurrent uploads
  const workers = new Array(Math.min(PARALLEL, candidates.rows.length)).fill(null).map(async () => {
    while (true) {
      const myIdx = nextIdx++;
      if (myIdx >= candidates.rows.length) return;
      const row = candidates.rows[myIdx];
      try {
        const dataRow = await pool.query("SELECT file_data FROM files WHERE id = $1", [row.id]);
        if (dataRow.rows.length === 0 || !dataRow.rows[0].file_data) continue;
        const buf = Buffer.isBuffer(dataRow.rows[0].file_data)
          ? dataRow.rows[0].file_data
          : Buffer.from(dataRow.rows[0].file_data);
        const key = r2.keyForOrderPdf(row.id);
        const url = await r2.uploadImage(buf, key, row.mime_type || 'application/pdf');
        if (!url) {
          process.stdout.write(`[${myIdx + 1}] FAIL upload ${row.id}\n`);
          failed++; continue;
        }
        await pool.query("UPDATE files SET file_url = $1, file_data = NULL WHERE id = $2", [url, row.id]);
        process.stdout.write(`[${myIdx + 1}/${candidates.rows.length}] OK ${(row.file_size/1024/1024).toFixed(1)} MB  ${row.filename || row.id}\n`);
        processed++;
        totalBytes += row.file_size;
      } catch (err) {
        process.stdout.write(`[${myIdx + 1}] FAIL ${row.id}: ${err.message}\n`);
        failed++;
      }
    }
  });
  await Promise.all(workers);

  console.log(`\n[backfill-files] done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  console.log(`  processed: ${processed}, failed: ${failed}, transferred: ${(totalBytes/1024/1024).toFixed(1)} MB`);
  await pool.end();
})().catch(e => { console.error('FATAL:', e.message, '\n', e.stack); process.exit(1); });
