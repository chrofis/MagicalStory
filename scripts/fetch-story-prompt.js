const { Pool } = require('pg');

async function main() {
  const dbUrl = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  console.log('Connecting to database...');

  const pool = new Pool({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false }
  });

  try {
    // Get the outline prompt from the latest story
    const result = await pool.query(
      "SELECT data->'outlinePrompt' as prompt FROM stories ORDER BY created_at DESC LIMIT 1"
    );

    const prompt = result.rows[0]?.prompt;
    if (prompt) {
      console.log('\n=== OUTLINE PROMPT ===\n');
      console.log(prompt);
    } else {
      console.log('No outlinePrompt found in latest story');
    }
  } catch(e) {
    console.error('Error:', e.message);
  }

  await pool.end();
}

main();
