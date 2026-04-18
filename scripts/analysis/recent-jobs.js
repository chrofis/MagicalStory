/**
 * Diagnostic: list recent story_jobs for a user (or all users).
 * Used to check whether a "create story" call actually reached the backend.
 *
 *   node scripts/analysis/recent-jobs.js [email]
 */
require('dotenv').config();
const { Pool } = require('pg');

async function main() {
  const email = process.argv[2] || null;
  const pool = new Pool({
    connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  let userId = null;
  if (email) {
    const u = await pool.query('SELECT id, username, email FROM users WHERE LOWER(email) = LOWER($1)', [email]);
    if (u.rows.length === 0) {
      console.error(`No user with email ${email}`);
      await pool.end();
      process.exit(1);
    }
    userId = u.rows[0].id;
    console.log(`User: ${u.rows[0].username} (${u.rows[0].email}, id=${userId})`);
  }

  const sql = userId
    ? `SELECT id, status, progress, progress_message, created_at, updated_at,
              jsonb_extract_path_text(input_data, 'languageLevel') AS lvl,
              jsonb_extract_path_text(input_data, 'pages') AS pages,
              jsonb_extract_path_text(input_data, 'layoutOverride') AS layout_override
       FROM story_jobs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10`
    : `SELECT id, user_id, status, progress, progress_message, created_at, updated_at
       FROM story_jobs ORDER BY created_at DESC LIMIT 10`;
  const params = userId ? [userId] : [];
  const r = await pool.query(sql, params);
  console.log(`\nRecent story_jobs (${r.rows.length}):`);
  for (const row of r.rows) {
    console.log(`  ${row.id}`);
    console.log(`    status: ${row.status}, progress: ${row.progress}% ("${(row.progress_message || '').substring(0, 60)}")`);
    console.log(`    created: ${row.created_at?.toISOString?.() || row.created_at}, updated: ${row.updated_at?.toISOString?.() || row.updated_at}`);
    if (row.lvl) console.log(`    level=${row.lvl}, pages=${row.pages}, layoutOverride=${row.layout_override || '(none)'}`);
  }
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
