/**
 * Check if characters for user "new@new" are stored in the database
 */

const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function checkUserCharacters() {
  const client = await pool.connect();

  try {
    console.log('🔍 Checking for user "new@new"...\n');

    // Find the user
    const userResult = await client.query(
      `SELECT id, username, email, created_at FROM users WHERE username = $1 OR email = $1`,
      ['new@new']
    );

    if (userResult.rows.length === 0) {
      console.log('❌ User "new@new" not found in database');
      return;
    }

    const user = userResult.rows[0];
    console.log('✓ Found user:');
    console.log(`  ID: ${user.id}`);
    console.log(`  Username: ${user.username}`);
    console.log(`  Email: ${user.email}`);
    console.log(`  Created: ${user.created_at}\n`);

    // Check for characters
    console.log('🔍 Checking for characters...\n');
    const charResult = await client.query(
      `SELECT id, user_id, data, created_at FROM characters WHERE user_id = $1`,
      [user.id]
    );

    if (charResult.rows.length === 0) {
      console.log('❌ No characters found for this user');
      console.log('\n💡 Possible reasons:');
      console.log('  1. Characters were never saved (check frontend for errors)');
      console.log('  2. Characters were deleted');
      console.log('  3. Frontend sent empty character array');
    } else {
      console.log(`✓ Found ${charResult.rows.length} character record(s):\n`);
      charResult.rows.forEach((row, index) => {
        const data = JSON.parse(row.data);
        console.log(`Record ${index + 1}:`);
        console.log(`  ID: ${row.id}`);
        console.log(`  Created: ${row.created_at}`);
        console.log(`  Characters: ${data.characters?.length || 0}`);
        if (data.characters && data.characters.length > 0) {
          console.log(`  Character names:`);
          data.characters.forEach(char => {
            console.log(`    - ${char.name} (${char.gender}, age ${char.age})`);
          });
        }
        console.log('');
      });
    }

    // Check activity log
    console.log('🔍 Checking activity log...\n');
    const activityResult = await client.query(
      `SELECT action, details, created_at FROM activity_logs
       WHERE user_id = $1 AND action LIKE '%CHARACTER%'
       ORDER BY created_at DESC LIMIT 10`,
      [user.id]
    );

    if (activityResult.rows.length === 0) {
      console.log('❌ No character-related activity found');
    } else {
      console.log(`✓ Found ${activityResult.rows.length} character activity log(s):\n`);
      activityResult.rows.forEach((row, index) => {
        const details = JSON.parse(row.details);
        console.log(`${index + 1}. ${row.action} at ${row.created_at}`);
        console.log(`   Details: ${JSON.stringify(details)}`);
      });
    }

  } catch (error) {
    console.error('Error:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

checkUserCharacters()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
