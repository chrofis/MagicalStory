#!/usr/bin/env node
/**
 * Dump the public-schema metadata (tables, columns, indexes) of the
 * DATABASE_URL the script can see — to stdout as JSON.
 *
 * Designed to run inside Railway via `railway run` for each environment,
 * piping the result to a local file. Then diff-schemas.js compares the
 * two JSON files locally.
 *
 * Usage (per Railway environment):
 *   railway run -- node scripts/admin/dump-schema.js > prod-schema.json
 *   railway environment staging
 *   railway run -- node scripts/admin/dump-schema.js > staging-schema.json
 *
 * Read-only. Never writes to the DB.
 */

const { Client } = require('pg');

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const tables = await client.query(`
      SELECT table_name FROM information_schema.tables
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
    const out = {
      generated_at: new Date().toISOString(),
      tables: tables.rows.map(r => r.table_name),
      columns: columns.rows,
      indexes: indexes.rows,
    };
    process.stdout.write(JSON.stringify(out, null, 2));
  } finally {
    await client.end();
  }
})().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
