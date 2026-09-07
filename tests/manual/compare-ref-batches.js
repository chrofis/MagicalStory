/**
 * Print referenceSheetBatches for one or more stories (prod or staging), to
 * establish whether a given element class started getting its own reference
 * sheet at some point — dating a suspected regression against a deploy.
 *
 * Usage: node tests/manual/compare-ref-batches.js <storyId> [--prod]
 */
require('dotenv').config();
const { Pool } = require('pg');

const storyId = process.argv[2];
const useProd = process.argv.includes('--prod');
if (!storyId) { console.error('usage: compare-ref-batches.js <storyId> [--prod]'); process.exit(1); }

const pool = new Pool({
  connectionString: useProd ? process.env.DATABASE_URL : process.env.STAGING_DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

(async () => {
  const r = await pool.query('select data from stories where id=$1', [storyId]);
  if (!r.rows.length) { console.error('not found'); process.exit(1); }
  const d = r.rows[0].data;
  console.log(useProd ? 'PROD' : 'STAGING', storyId, '|', d.title);
  console.log('referenceSheetBatches:');
  for (const b of d.referenceSheetBatches || []) {
    console.log(`  batch ${b.batchIdx}: ids=${JSON.stringify(b.elementIds)}`);
    for (const n of b.elementNames || []) console.log(`      - ${n}`);
  }
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
