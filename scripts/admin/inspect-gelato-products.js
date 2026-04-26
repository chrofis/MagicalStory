/**
 * Inspect the gelato_products table — shows raw values for every row so we
 * can see exactly what min_pages / max_pages / available_page_counts are
 * set to (the admin UI sometimes shows derived values).
 *
 * Usage (from a shell with DATABASE_URL pointing at prod):
 *   node scripts/admin/inspect-gelato-products.js
 *
 * Or via Railway:
 *   railway run node scripts/admin/inspect-gelato-products.js
 */

const pg = require('pg');

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

(async () => {
  await client.connect();
  const r = await client.query(
    `SELECT product_uid, product_name, cover_type, size,
            min_pages, max_pages,
            available_page_counts,
            is_active
       FROM gelato_products
      ORDER BY is_active DESC, product_uid`
  );

  for (const row of r.rows) {
    console.log('---');
    console.log(`UID:    ${row.product_uid}`);
    console.log(`Name:   ${row.product_name}`);
    console.log(`Active: ${row.is_active}`);
    console.log(`Cover:  ${row.cover_type}`);
    console.log(`Size:   ${row.size}`);
    console.log(`Pages:  min=${row.min_pages} max=${row.max_pages}`);
    console.log(`Counts: ${row.available_page_counts === null ? '(null)' : JSON.stringify(row.available_page_counts)}`);
  }
  console.log(`\nTotal rows: ${r.rows.length}`);
  await client.end();
})().catch((e) => {
  console.error(e);
  client.end();
  process.exit(1);
});
