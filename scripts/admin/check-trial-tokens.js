// Quick script to check trial user tokens in the database
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

(async () => {
  // Check for the specific token
  const r1 = await pool.query(
    "SELECT id, email, email_verified, is_trial, email_verification_token IS NOT NULL as has_token, email_verification_expires FROM users WHERE email_verification_token = $1",
    ['65cceddfbfb155722f8a53b3b62777f3e6ce6f8121fd7e71c246967678be5269']
  );
  console.log('Token match:', r1.rows.length > 0 ? JSON.stringify(r1.rows[0]) : 'NOT FOUND');

  // Check all recent trial users
  const r2 = await pool.query(
    'SELECT id, email, email_verified, is_trial, email_verification_token, email_verification_expires, created_at FROM users WHERE is_trial = true ORDER BY created_at DESC LIMIT 10'
  );
  console.log('\nRecent trial users:');
  r2.rows.forEach(r => {
    const token = r.email_verification_token ? r.email_verification_token.substring(0, 12) + '...' : 'NULL';
    const expires = r.email_verification_expires ? new Date(r.email_verification_expires).toISOString() : 'NULL';
    const now = new Date();
    const expired = r.email_verification_expires ? new Date(r.email_verification_expires) < now : null;
    console.log(`  ${r.email} | verified: ${r.email_verified} | token: ${token} | expires: ${expires} ${expired !== null ? (expired ? '(EXPIRED)' : '(valid)') : ''} | created: ${new Date(r.created_at).toISOString()}`);
  });

  // Also check if any token contains the prefix
  const r3 = await pool.query(
    "SELECT id, email, email_verification_token FROM users WHERE email_verification_token LIKE '65cceddf%'"
  );
  console.log('\nPartial token match (65cceddf%):', r3.rows.length > 0 ? JSON.stringify(r3.rows) : 'NONE');

  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
