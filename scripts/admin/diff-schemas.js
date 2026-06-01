#!/usr/bin/env node
/**
 * Compare two schema dumps produced by dump-schema.js and print the diff.
 *
 * Usage:
 *   node scripts/admin/diff-schemas.js prod-schema.json staging-schema.json
 */

const fs = require('fs');
const path = require('path');

const [prodFile, stagingFile] = process.argv.slice(2);
if (!prodFile || !stagingFile) {
  console.error('Usage: node scripts/admin/diff-schemas.js <prod.json> <staging.json>');
  process.exit(1);
}
const prod = JSON.parse(fs.readFileSync(prodFile, 'utf8'));
const staging = JSON.parse(fs.readFileSync(stagingFile, 'utf8'));

function fmtCol(c) {
  const nn = c.is_nullable === 'NO' ? ' NOT NULL' : '';
  const dflt = c.column_default ? ` DEFAULT ${c.column_default}` : '';
  return `${c.column_name} :: ${c.data_type}${nn}${dflt}`;
}

function colKey(c) { return `${c.table_name}.${c.column_name}`; }
function idxKey(i) { return `${i.table_name}.${i.index_name}`; }

const prodTables = new Set(prod.tables);
const stagingTables = new Set(staging.tables);

console.log('═══════════════════════════════════════════════════════════');
console.log(`PROD     dumped at ${prod.generated_at}`);
console.log(`STAGING  dumped at ${staging.generated_at}`);
console.log('═══════════════════════════════════════════════════════════');

console.log('\n── TABLES ────────────────────────────────────────────────');
const tablesOnlyProd = [...prodTables].filter(t => !stagingTables.has(t));
const tablesOnlyStaging = [...stagingTables].filter(t => !prodTables.has(t));
if (!tablesOnlyProd.length && !tablesOnlyStaging.length) console.log('  ✓ Identical');
if (tablesOnlyProd.length) {
  console.log(`  Only on prod (${tablesOnlyProd.length}):`);
  for (const t of tablesOnlyProd) console.log(`    + ${t}`);
}
if (tablesOnlyStaging.length) {
  console.log(`  Only on staging (${tablesOnlyStaging.length}):`);
  for (const t of tablesOnlyStaging) console.log(`    + ${t}`);
}

console.log('\n── COLUMNS (per shared table) ────────────────────────────');
const sharedTables = [...prodTables].filter(t => stagingTables.has(t)).sort();
const prodColMap = new Map();
const stagingColMap = new Map();
for (const c of prod.columns) prodColMap.set(colKey(c), c);
for (const c of staging.columns) stagingColMap.set(colKey(c), c);

let columnDriftFound = false;
for (const t of sharedTables) {
  const prodCols = prod.columns.filter(c => c.table_name === t);
  const stagingCols = staging.columns.filter(c => c.table_name === t);
  const prodColNames = new Set(prodCols.map(c => c.column_name));
  const stagingColNames = new Set(stagingCols.map(c => c.column_name));

  const onlyProd = prodCols.filter(c => !stagingColNames.has(c.column_name));
  const onlyStaging = stagingCols.filter(c => !prodColNames.has(c.column_name));
  const typeMismatches = [];
  for (const c of prodCols) {
    const sc = stagingColMap.get(colKey(c));
    if (sc && (sc.data_type !== c.data_type || sc.is_nullable !== c.is_nullable)) {
      typeMismatches.push({ prod: c, staging: sc });
    }
  }

  if (!onlyProd.length && !onlyStaging.length && !typeMismatches.length) continue;
  columnDriftFound = true;
  console.log(`\n  Table: ${t}`);
  if (onlyProd.length) {
    console.log('    Columns only on prod:');
    for (const c of onlyProd) console.log(`      + ${fmtCol(c)}`);
  }
  if (onlyStaging.length) {
    console.log('    Columns only on staging:');
    for (const c of onlyStaging) console.log(`      + ${fmtCol(c)}`);
  }
  if (typeMismatches.length) {
    console.log('    Type/nullability mismatches:');
    for (const m of typeMismatches) {
      console.log(`      ! ${m.prod.column_name}`);
      console.log(`          prod:    ${fmtCol(m.prod)}`);
      console.log(`          staging: ${fmtCol(m.staging)}`);
    }
  }
}
if (!columnDriftFound) console.log('  ✓ No column drift on shared tables');

console.log('\n── INDEXES (per shared table) ────────────────────────────');
let indexDriftFound = false;
for (const t of sharedTables) {
  const prodIdx = new Set(prod.indexes.filter(i => i.table_name === t).map(i => i.index_name));
  const stagingIdx = new Set(staging.indexes.filter(i => i.table_name === t).map(i => i.index_name));
  const onlyProd = [...prodIdx].filter(i => !stagingIdx.has(i));
  const onlyStaging = [...stagingIdx].filter(i => !prodIdx.has(i));
  if (!onlyProd.length && !onlyStaging.length) continue;
  indexDriftFound = true;
  console.log(`\n  Table: ${t}`);
  if (onlyProd.length) {
    console.log('    Indexes only on prod:');
    for (const i of onlyProd) console.log(`      + ${i}`);
  }
  if (onlyStaging.length) {
    console.log('    Indexes only on staging:');
    for (const i of onlyStaging) console.log(`      + ${i}`);
  }
}
if (!indexDriftFound) console.log('  ✓ No index drift on shared tables');

console.log('\nDone.');
