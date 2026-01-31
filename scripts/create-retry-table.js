const { Pool } = require('pg');

async function run() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  try {
    console.log('Creating story_retry_images table...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS story_retry_images (
        id SERIAL PRIMARY KEY,
        story_id VARCHAR(255) NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
        page_number INT NOT NULL,
        retry_index INT NOT NULL,
        image_type VARCHAR(50) NOT NULL,
        grid_index INT,
        image_data TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('Table created successfully');

    console.log('Creating indexes...');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_retry_images_story ON story_retry_images(story_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_retry_images_page ON story_retry_images(story_id, page_number)');
    // Unique index with COALESCE for the constraint
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_retry_images_unique ON story_retry_images(story_id, page_number, retry_index, image_type, COALESCE(grid_index, -1))');
    console.log('Indexes created successfully');

    const check = await pool.query("SELECT COUNT(*) FROM story_retry_images");
    console.log('Table row count:', check.rows[0].count);

  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
