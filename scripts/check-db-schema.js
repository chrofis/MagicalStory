require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  // Get story_jobs columns
  const cols = await pool.query(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = 'story_jobs'
  `);
  console.log('story_jobs columns:');
  for (const row of cols.rows) {
    console.log('  ' + row.column_name + ': ' + row.data_type);
  }

  // Check for images table
  const tables = await pool.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name LIKE '%image%'
  `);
  console.log('\nTables with "image":');
  for (const row of tables.rows) {
    console.log('  ' + row.table_name);
  }

  // Get latest story_job for our story
  const job = await pool.query(`
    SELECT id, status, data FROM story_jobs
    WHERE story_id = 'job_1769285688015_idstty79v'
    ORDER BY created_at DESC LIMIT 1
  `);
  if (job.rows.length > 0) {
    console.log('\nLatest job status:', job.rows[0].status);
    const data = job.rows[0].data;
    if (data) {
      console.log('Job data keys:', Object.keys(data).join(', '));
      if (data.sceneImages && data.sceneImages[0]) {
        console.log('sceneImages[0] keys:', Object.keys(data.sceneImages[0]).join(', '));
        const s = data.sceneImages[0];
        console.log('  imageData:', s.imageData ? 'YES (' + s.imageData.length + ')' : 'NO');
      }
    }
  }

  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
