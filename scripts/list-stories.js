require('dotenv').config();
const { Pool } = require('pg');
const { ch, fromPgNaive } = require('./lib/chTime');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const result = await pool.query(
    "SELECT id, created_at, data->>'title' as title FROM stories ORDER BY created_at DESC LIMIT 10"
  );
  console.log('Recent stories:');
  for (const row of result.rows) {
    // created_at is a naive TIMESTAMP — node-pg parses it as local; rehome first.
    console.log('  ' + row.id + ' - ' + row.title + ' (' + ch(fromPgNaive(row.created_at)) + ')');
  }
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
