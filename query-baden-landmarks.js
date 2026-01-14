// Quick script to query Baden landmarks from DB
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function queryBadenLandmarks() {
  try {
    const result = await pool.query(
      "SELECT city, country, language, landmarks, created_at FROM landmarks_discovery WHERE LOWER(city) = 'baden' ORDER BY language"
    );
    console.log(`Found ${result.rowCount} entries for Baden:\n`);

    for (const row of result.rows) {
      console.log(`=== ${row.language?.toUpperCase() || 'UNKNOWN'} (${row.city}, ${row.country}) ===`);
      console.log(`Created: ${row.created_at}`);

      let landmarks = row.landmarks;
      if (typeof landmarks === 'string') {
        landmarks = JSON.parse(landmarks);
      }

      if (Array.isArray(landmarks)) {
        landmarks.forEach((l, i) => {
          console.log(`${i + 1}. ${l.name} [${l.type}]`);
          if (l.description) console.log(`   ${l.description.substring(0, 100)}...`);
        });
      } else {
        console.log(JSON.stringify(landmarks, null, 2));
      }
      console.log('');
    }
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await pool.end();
  }
}

queryBadenLandmarks();
