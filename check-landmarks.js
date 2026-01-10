require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function check() {
  const res = await pool.query(`
    SELECT id, created_at,
           input_data->'userLocation' as user_location,
           input_data->'availableLandmarks' as available_landmarks
    FROM story_jobs
    ORDER BY created_at DESC
    LIMIT 3
  `);
  console.log('Recent story jobs:');
  res.rows.forEach(r => {
    console.log(`Job: ${r.id}`);
    console.log(`  Created: ${r.created_at}`);
    console.log(`  userLocation: ${JSON.stringify(r.user_location)}`);
    const landmarks = r.available_landmarks;
    if (landmarks && Array.isArray(landmarks)) {
      console.log(`  landmarks count: ${landmarks.length}`);
      if (landmarks.length > 0) {
        console.log(`  first landmark: ${landmarks[0]?.name}`);
      }
    } else {
      console.log(`  landmarks: none`);
    }
    console.log('');
  });
  pool.end();
}
check().catch(e => { console.error(e); pool.end(); });
