require('dotenv').config();
const { Pool } = require('pg');
(async () => {
  const storyId = process.argv[2];
  const pool = new Pool({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const r = await pool.query("SELECT data::jsonb->>'outline' as o FROM stories WHERE id = $1", [storyId]);
  const raw = r.rows[0]?.o || '(not stored)';
  console.log(typeof raw === 'string' ? raw : JSON.stringify(raw));
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
