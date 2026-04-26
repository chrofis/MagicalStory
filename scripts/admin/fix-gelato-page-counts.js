/**
 * One-shot cleanup: clear available_page_counts from rows where it is
 * inconsistent with min_pages/max_pages. Production state (April 2026):
 * several active rows have min=30/max=200 but available_page_counts=[24],
 * left over from a stale Gelato API sync. The list overrides the range,
 * so the snap function picks 24 — which is below the actual content
 * size and below min_pages. Result: order rejected.
 *
 * Strategy: NULL out available_page_counts whenever max(list) < min_pages.
 * The snap function then uses the row's min/max as the source of truth.
 *
 * Dry run by default. Pass `commit` to actually update.
 *
 * Usage:
 *   DATABASE_URL=... node scripts/admin/fix-gelato-page-counts.js          # dry run
 *   DATABASE_URL=... node scripts/admin/fix-gelato-page-counts.js commit   # apply
 */

const pg = require('pg');

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL not set'); process.exit(1); }

const commit = process.argv.includes('commit');
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

(async () => {
  await client.connect();

  const r = await client.query(
    `SELECT product_uid, min_pages, max_pages, available_page_counts, is_active
       FROM gelato_products
      WHERE available_page_counts IS NOT NULL`
  );

  const toFix = [];
  for (const row of r.rows) {
    let counts = row.available_page_counts;
    if (typeof counts === 'string') {
      try { counts = JSON.parse(counts); } catch { counts = null; }
    }
    if (!Array.isArray(counts) || counts.length === 0) continue;
    const listMax = Math.max(...counts.map(Number).filter(Number.isFinite));
    if (row.min_pages && listMax < row.min_pages) {
      toFix.push({
        uid: row.product_uid,
        active: row.is_active,
        min: row.min_pages, max: row.max_pages,
        listMax,
        oldCounts: row.available_page_counts,
      });
    }
  }

  console.log(`Mode: ${commit ? 'COMMIT' : 'DRY RUN'}`);
  console.log(`Rows with inconsistent available_page_counts (list max < min_pages): ${toFix.length}\n`);

  for (const row of toFix) {
    console.log(`  - ${row.active ? '[ACTIVE]' : '[inact]'} ${row.uid}`);
    console.log(`    min=${row.min}, max=${row.max}, list_max=${row.listMax}, old_counts=${JSON.stringify(row.oldCounts)}`);
  }

  if (commit && toFix.length > 0) {
    const r2 = await client.query(
      `UPDATE gelato_products
          SET available_page_counts = NULL,
              updated_at = CURRENT_TIMESTAMP
        WHERE product_uid = ANY($1::text[])`,
      [toFix.map(r => r.uid)]
    );
    console.log(`\nCleared available_page_counts on ${r2.rowCount} rows.`);
  } else if (toFix.length > 0) {
    console.log('\nDry run — pass `commit` to apply.');
  } else {
    console.log('\nNothing to fix.');
  }

  await client.end();
})().catch((e) => { console.error(e); client.end(); process.exit(1); });
