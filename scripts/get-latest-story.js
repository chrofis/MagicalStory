require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const result = await pool.query(
    "SELECT id, data->>'title' as title FROM stories ORDER BY created_at DESC LIMIT 1"
  );
  if (result.rows.length > 0) {
    console.log(result.rows[0].id);
  }
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
