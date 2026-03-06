require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const result = await pool.query(
    "SELECT id, created_at, data->>'title' as title FROM stories ORDER BY created_at DESC LIMIT 10"
  );
  console.log('Recent stories:');
  for (const row of result.rows) {
    console.log('  ' + row.id + ' - ' + row.title + ' (' + new Date(row.created_at).toISOString().slice(0,10) + ')');
  }
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
