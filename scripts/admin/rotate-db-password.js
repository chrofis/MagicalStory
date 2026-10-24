#!/usr/bin/env node
/**
 * Rotate the Postgres password of one environment without the value ever
 * reaching a terminal or chat.
 *
 *   node scripts/admin/rotate-db-password.js --env=staging
 *   node scripts/admin/rotate-db-password.js --env=prod
 *
 * Connects with the CURRENT address from .env (STAGING_DATABASE_URL, or
 * DATABASE_PUBLIC_URL for prod), runs ALTER USER <user> WITH PASSWORD, and
 * writes the new password to ~/db-password-<env>.txt. Prints only the file
 * path. Then: paste it into Railway (Postgres service: POSTGRES_PASSWORD and
 * PGPASSWORD), update the .env addresses, and delete the file.
 *
 * Changing the Railway variable alone does NOT change the password: Postgres
 * keeps the one it was initialised with until ALTER USER changes it.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');

const env = (process.argv.find(a => a.startsWith('--env=')) || '').split('=')[1];
const url = env === 'staging' ? process.env.STAGING_DATABASE_URL : env === 'prod' ? process.env.DATABASE_PUBLIC_URL : null;
if (!url) {
  console.error('usage: --env=staging|prod (needs STAGING_DATABASE_URL / DATABASE_PUBLIC_URL in .env)');
  process.exit(1);
}

(async () => {
  const user = decodeURIComponent(new URL(url).username);
  const password = crypto.randomBytes(24).toString('base64url');
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  // Identifiers cannot be bound as parameters; quote the user name and the literal.
  const ident = '"' + user.replace(/"/g, '""') + '"';
  await client.query(`ALTER USER ${ident} WITH PASSWORD '${password.replace(/'/g, "''")}'`);
  await client.end();
  const file = path.join(os.homedir(), `db-password-${env}.txt`);
  fs.writeFileSync(file, password + '\n', { mode: 0o600 });
  console.log(`${env}: password of "${user}" changed. New value saved to ${file}`);
  console.log('Existing connections keep working; NEW connections need the new value - update Railway now.');
})().catch(e => { console.error('FAILED (password unchanged):', e.message); process.exit(1); });
