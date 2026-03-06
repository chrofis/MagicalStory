#!/usr/bin/env node
const pg = require('pg');

const dbUrl = process.env.DATABASE_URL || process.env.DATABASE_PRIVATE_URL;
if (!dbUrl) {
  console.log('No database URL found. Using file mode.');
  process.exit(0);
}

const pool = new pg.Pool({
  connectionString: dbUrl,
  ssl: { rejectUnauthorized: false }
});

pool.query('SELECT id, username, email, role FROM users ORDER BY created_at ASC')
  .then(result => {
    console.log('Current users:');
    result.rows.forEach(u => {
      const role = u.role || 'user';
      const email = u.email || u.username;
      console.log(`- ${email} (role: ${role}, id: ${u.id})`);
    });
    pool.end();
  })
  .catch(err => {
    console.error('Error:', err.message);
    pool.end();
    process.exit(1);
  });
