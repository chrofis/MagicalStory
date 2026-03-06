const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  try {
    const r = await pool.query("SELECT data->'sceneDescriptions'->12 as scene FROM stories WHERE id = 73");
    console.log('=== PAGE 13 SCENE DESCRIPTION ===');
    console.log(JSON.stringify(r.rows[0]?.scene, null, 2));
  } catch(e) {
    console.error('Error:', e.message);
  } finally {
    await pool.end();
  }
}
main();
