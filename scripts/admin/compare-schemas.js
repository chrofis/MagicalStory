#!/usr/bin/env node
/**
 * Compare PostgreSQL schemas between two databases (typically prod and staging)
 * and print the diff. Read-only — never writes.
 *
 * Usage:
 *   node scripts/admin/compare-schemas.js <PROD_URL> <STAGING_URL>
 *
 * Or via env vars:
 *   PROD_DATABASE_URL=...  STAGING_DATABASE_URL=...  node scripts/admin/compare-schemas.js
 *
 * Get the URLs from Railway:
 *   Railway dashboard → service → Postgres → "Connect" → copy the postgresql:// URL
 *   (or `railway variables` inside the right environment)
 *
 * Outputs three sections:
 *   1. Tables present on one side only
 *   2. Columns present on one side only (per shared table)
 *   3. Indexes present on one side only (per shared table)
 */

const { Client } = require('pg');

const PROD_URL = process.argv[2] || process.env.PROD_DATABASE_URL;
const STAGING_URL = process.argv[3] || process.env.STAGING_DATABASE_URL;

if (!PROD_URL || !STAGING_URL) {
  console.error('Missing connection URLs.');
  console.error('Usage: node scripts/admin/compare-schemas.js <PROD_URL> <STAGING_URL>');
  console.error('Or set PROD_DATABASE_URL and STAGING_DATABASE_URL in env.');
  process.exit(1);
}

async function fetchSchema(url, label) {
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const tables = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);
    const columns = await client.query(`
      SELECT table_name, column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, column_name
    `);
    const indexes = await client.query(`
      SELECT tablename AS table_name, indexname AS index_name, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
      ORDER BY tablename, indexname
    `);
    return {
      label,
      tables: new Set(tables.rows.map(r => r.table_name)),
      columns: groupBy(columns.rows, r => r.table_name, r => `${r.column_name}::${r.data_type}${r.is_nullable === 'NO' ? ' NOT NULL' : ''}${r.column_default ? ` DEFAULT ${r.column_default}` : ''}`),
      indexes: groupBy(indexes.rows, r => r.table_name, r => r.index_name),
    };
  } finally {
    await client.end();
  }
}

function groupBy(rows, keyFn, valFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!m.has(k)) m.set(k, new Set());
    m.get(k).add(valFn(r));
  }
  return m;
}

function setDiff(a, b) {
  const onlyA = [];
  const onlyB = [];
  for (const v of a) if (!b.has(v)) onlyA.push(v);
  for (const v of b) if (!a.has(v)) onlyB.push(v);
  return { onlyA, onlyB };
}

function colNamesOnly(colSet) {
  return new Set([...colSet].map(s => s.split('::')[0]));
}

(async () => {
  console.log('Fetching prod schema...');
  const prod = await fetchSchema(PROD_URL, 'prod');
  console.log('Fetching staging schema...');
  const staging = await fetchSchema(STAGING_URL, 'staging');

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('TABLES');
  console.log('═══════════════════════════════════════════════════════════');
  const tableDiff = setDiff(prod.tables, staging.tables);
  if (tableDiff.onlyA.length === 0 && tableDiff.onlyB.length === 0) {
    console.log('  ✓ Identical table set');
  }
  if (tableDiff.onlyA.length > 0) {
    console.log(`  Only on prod (${tableDiff.onlyA.length}):`);
    for (const t of tableDiff.onlyA) console.log(`    + ${t}`);
  }
  if (tableDiff.onlyB.length > 0) {
    console.log(`  Only on staging (${tableDiff.onlyB.length}):`);
    for (const t of tableDiff.onlyB) console.log(`    + ${t}`);
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('COLUMNS (per shared table)');
  console.log('═══════════════════════════════════════════════════════════');
  const sharedTables = [...prod.tables].filter(t => staging.tables.has(t)).sort();
  let columnDriftCount = 0;
  for (const t of sharedTables) {
    const prodCols = prod.columns.get(t) || new Set();
    const stagingCols = staging.columns.get(t) || new Set();
    // Compare column names first (cheap signal)
    const prodNames = colNamesOnly(prodCols);
    const stagingNames = colNamesOnly(stagingCols);
    const nameDiff = setDiff(prodNames, stagingNames);
    if (nameDiff.onlyA.length === 0 && nameDiff.onlyB.length === 0) continue;
    columnDriftCount++;
    console.log(`\n  Table: ${t}`);
    if (nameDiff.onlyA.length > 0) {
      console.log(`    Columns only on prod:`);
      for (const c of nameDiff.onlyA) {
        const full = [...prodCols].find(s => s.startsWith(`${c}::`));
        console.log(`      + ${full}`);
      }
    }
    if (nameDiff.onlyB.length > 0) {
      console.log(`    Columns only on staging:`);
      for (const c of nameDiff.onlyB) {
        const full = [...stagingCols].find(s => s.startsWith(`${c}::`));
        console.log(`      + ${full}`);
      }
    }
  }
  if (columnDriftCount === 0) {
    console.log('  ✓ No column drift on shared tables');
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('INDEXES (per shared table)');
  console.log('═══════════════════════════════════════════════════════════');
  let indexDriftCount = 0;
  for (const t of sharedTables) {
    const prodIdx = prod.indexes.get(t) || new Set();
    const stagingIdx = staging.indexes.get(t) || new Set();
    const d = setDiff(prodIdx, stagingIdx);
    if (d.onlyA.length === 0 && d.onlyB.length === 0) continue;
    indexDriftCount++;
    console.log(`\n  Table: ${t}`);
    if (d.onlyA.length > 0) {
      console.log(`    Indexes only on prod:`);
      for (const i of d.onlyA) console.log(`      + ${i}`);
    }
    if (d.onlyB.length > 0) {
      console.log(`    Indexes only on staging:`);
      for (const i of d.onlyB) console.log(`      + ${i}`);
    }
  }
  if (indexDriftCount === 0) {
    console.log('  ✓ No index drift on shared tables');
  }

  console.log('\nDone.');
})().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
