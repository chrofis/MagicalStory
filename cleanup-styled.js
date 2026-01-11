// Run with: node cleanup-styled.js <DATABASE_URL>
const { Pool } = require('pg');

const DATABASE_URL = process.argv[2] || process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('Usage: node cleanup-styled.js <DATABASE_URL>');
  process.exit(1);
}

async function cleanupStyledAvatars() {
  const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

  try {
    // Find user
    const userResult = await pool.query(
      "SELECT id FROM users WHERE email = 'rogerfischer@hotmail.com'"
    );
    if (userResult.rows.length === 0) {
      console.log('User not found');
      return;
    }
    const userId = userResult.rows[0].id;
    console.log('Found user:', userId);

    // Get character data
    const rowId = `characters_${userId}`;
    const charResult = await pool.query(
      'SELECT data FROM characters WHERE id = $1',
      [rowId]
    );
    if (charResult.rows.length === 0) {
      console.log('No character data found');
      return;
    }

    const data = JSON.parse(charResult.rows[0].data);
    const characters = data.characters || [];

    let totalCleared = 0;
    let styledCount = 0;
    let costumedCount = 0;

    for (const char of characters) {
      if (char.avatars) {
        if (char.avatars.styledAvatars) {
          const styles = Object.keys(char.avatars.styledAvatars);
          styledCount += styles.length;
          totalCleared += JSON.stringify(char.avatars.styledAvatars).length;
          console.log(`  ${char.name}: removing ${styles.length} styled (${styles.join(', ')})`);
          delete char.avatars.styledAvatars;
        }
        if (char.avatars.costumed) {
          const costumes = Object.keys(char.avatars.costumed);
          costumedCount += costumes.length;
          totalCleared += JSON.stringify(char.avatars.costumed).length;
          console.log(`  ${char.name}: removing ${costumes.length} costumed`);
          delete char.avatars.costumed;
        }
      }
    }

    // Save
    await pool.query(
      'UPDATE characters SET data = $1 WHERE id = $2',
      [JSON.stringify(data), rowId]
    );

    console.log(`\nDone! Cleared ${styledCount} styled + ${costumedCount} costumed = ${(totalCleared/1024/1024).toFixed(2)} MB`);
  } finally {
    await pool.end();
  }
}

cleanupStyledAvatars().catch(console.error);
