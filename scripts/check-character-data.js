// Check character data structure
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function checkCharacters() {
  try {
    const result = await pool.query(
      "SELECT data FROM characters WHERE user_id = '1767568240635'"
    );

    if (result.rows.length === 0) {
      console.log('No character data found');
      return;
    }

    const rawData = result.rows[0].data;
    // Parse if string
    const data = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
    const characters = data.characters || [];

    console.log(`Found ${characters.length} characters:\n`);
    console.log('Raw data type:', typeof rawData);
    console.log('Data keys:', Object.keys(data));

    characters.forEach(c => {
      console.log(`=== ${c.name} ===`);
      console.log('  physicalTraits:', c.physicalTraits || 'MISSING');
      console.log('  clothingDescription:', c.clothingDescription || 'MISSING');
      console.log('  avatars.clothing:', c.avatars?.clothing ? Object.keys(c.avatars.clothing) : 'NONE');
      console.log('  avatars.standard:', c.avatars?.standard ? 'present' : 'MISSING');
      console.log('  avatars.faceMatch:', c.avatars?.faceMatch ? Object.keys(c.avatars.faceMatch) : 'NONE');
      console.log('');
    });

  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await pool.end();
  }
}

checkCharacters();
