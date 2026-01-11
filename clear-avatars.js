const { Pool } = require('pg');

async function clearAvatars() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    // Find user ID
    const userResult = await pool.query(
      "SELECT id, email FROM users WHERE email = 'rogerfischer@hotmail.com'"
    );

    if (userResult.rows.length === 0) {
      console.log('User not found');
      return;
    }

    const userId = userResult.rows[0].id;
    console.log('Found user:', userId, userResult.rows[0].email);

    // Get current character data
    const charResult = await pool.query(
      'SELECT id, data FROM characters WHERE user_id = $1',
      [userId]
    );

    if (charResult.rows.length === 0) {
      console.log('No character data found');
      return;
    }

    console.log('Found', charResult.rows.length, 'character record(s)');

    for (const row of charResult.rows) {
      const data = row.data;
      const characters = data.characters || [];

      let totalAvatarSize = 0;

      // Clear avatars from each character
      for (const char of characters) {
        if (char.avatars) {
          // Estimate size
          const avatarJson = JSON.stringify(char.avatars);
          totalAvatarSize += avatarJson.length;

          console.log('Clearing avatars for:', char.name);
          console.log('  - Had keys:', Object.keys(char.avatars));

          // Clear all avatar data
          delete char.avatars;
        }
      }

      console.log('Total avatar data size:', (totalAvatarSize / 1024 / 1024).toFixed(2), 'MB');

      // Update the record
      await pool.query(
        'UPDATE characters SET data = $1 WHERE id = $2',
        [data, row.id]
      );

      console.log('Updated character record:', row.id);
    }

    console.log('Done! All avatars cleared.');

  } finally {
    await pool.end();
  }
}

clearAvatars().catch(console.error);
