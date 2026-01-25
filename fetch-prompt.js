const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  try {
    // Get the story data keys first
    const keys = await pool.query(`
      SELECT DISTINCT jsonb_object_keys(data) as key
      FROM stories 
      WHERE id = (SELECT id FROM stories ORDER BY created_at DESC LIMIT 1)
    `);
    console.log('Story data keys:', keys.rows.map(r => r.key).join(', '));
    
    // Check for prompt in data
    const prompt = await pool.query(`
      SELECT data->'generationLog' as gen_log
      FROM stories 
      ORDER BY created_at DESC LIMIT 1
    `);
    
    if (prompt.rows[0]?.gen_log) {
      const log = prompt.rows[0].gen_log;
      // Find prompt entries
      const promptEntries = log.filter(e => e.type === 'prompt' || e.message?.includes('prompt'));
      console.log('Prompt entries found:', promptEntries.length);
      if (promptEntries.length > 0) {
        console.log(JSON.stringify(promptEntries[0], null, 2));
      }
    }
  } catch(e) {
    console.error('Error:', e.message);
  }
  await pool.end();
})();
