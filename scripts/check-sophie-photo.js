require('dotenv').config();
const { Pool } = require('pg');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const result = await pool.query('SELECT data FROM characters WHERE user_id = $1', ['1767568240635']);
  const data = JSON.parse(result.rows[0].data);

  console.log('All character names:', data.characters.map(c => c.name));

  const sophie = data.characters.find(c => c.name.includes('Sophie'));
  if (!sophie) {
    console.log('Sophie not found, using first character');
    const first = data.characters[0];
    console.log('First character name:', first.name);
    console.log('First character facePhoto exists:', first.facePhoto ? 'YES' : 'NO');
    console.log('First character facePhoto length:', first.facePhoto?.length || 0);
    console.log('First character facePhoto starts with:', first.facePhoto?.substring(0, 80));
    if (first.facePhoto) {
      const base64 = first.facePhoto.replace(/^data:image\/\w+;base64,/, '');
      const sizeKB = Math.round((base64.length * 3 / 4) / 1024);
      console.log('First character facePhoto size:', sizeKB, 'KB');
    }
    console.log('\nFirst character keys:', Object.keys(first));
  } else {
    console.log('Sophie facePhoto exists:', sophie.facePhoto ? 'YES' : 'NO');
    console.log('Sophie facePhoto length:', sophie.facePhoto?.length || 0);
    console.log('Sophie facePhoto starts with:', sophie.facePhoto?.substring(0, 80));

    // Check if it's the original face or a 2x2 grid
    if (sophie.facePhoto) {
      const base64 = sophie.facePhoto.replace(/^data:image\/\w+;base64,/, '');
      const sizeKB = Math.round((base64.length * 3 / 4) / 1024);
      console.log('Sophie facePhoto size:', sizeKB, 'KB');
    }

    // Check avatar thumbnails
    console.log('\nSophie keys:', Object.keys(sophie));
  }

  await pool.end();
}

main().catch(console.error);
