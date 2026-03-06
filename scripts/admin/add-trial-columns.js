#!/usr/bin/env node
/**
 * Migration: Add trial-related columns to the users table.
 *
 * Usage: node scripts/admin/add-trial-columns.js
 *
 * Adds:
 *   - is_trial       BOOLEAN   — marks anonymous trial accounts
 *   - trial_data     JSONB     — stores trial-specific metadata
 *   - claim_token    VARCHAR   — token sent in claim-account email
 *   - claim_token_expires TIMESTAMP — expiry for the claim token
 */
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_trial BOOLEAN DEFAULT FALSE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_data JSONB DEFAULT NULL;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS claim_token VARCHAR(64) DEFAULT NULL;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS claim_token_expires TIMESTAMP DEFAULT NULL;
    `);
    await client.query('COMMIT');
    console.log('Migration complete: trial columns added');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
