// Quick script to clear Baden landmarks cache from DB
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function clearBadenCache() {
  try {
    const result = await pool.query(
      "DELETE FROM landmarks_discovery WHERE LOWER(city) = 'baden' RETURNING city, country"
    );
    console.log(`Deleted ${result.rowCount} rows for Baden`);

    const remaining = await pool.query("SELECT city, country, created_at FROM landmarks_discovery ORDER BY created_at DESC LIMIT 5");
    console.log('Remaining cache entries:', remaining.rows);
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await pool.end();
  }
}

clearBadenCache();
