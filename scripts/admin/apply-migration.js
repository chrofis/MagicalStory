#!/usr/bin/env node
// One-off migration runner for testing or manual application.
// Usage: node scripts/admin/apply-migration.js

require('dotenv').config();
const { Pool } = require('pg');
const { runMigrations } = require('../../server/services/migrate');

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  try {
    console.log('Applying pending migrations...');
    await runMigrations(pool, { info: console.log });
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
