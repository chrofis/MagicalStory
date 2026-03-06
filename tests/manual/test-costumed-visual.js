/**
 * Visual comparison test - generates multiple pirate avatars and saves them
 * to test-output/ folder for visual inspection
 */

require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const OUTPUT_DIR = path.join(__dirname, 'test-output');

function saveImage(base64Data, filename) {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);
  const base64Clean = base64Data.replace(/^data:image\/\w+;base64,/, '');
  const filepath = path.join(OUTPUT_DIR, filename);
  fs.writeFileSync(filepath, Buffer.from(base64Clean, 'base64'));
  return filepath;
}

async function main() {
  console.log('🎭 Visual Costumed Avatar Test\n');
  console.log(`Output folder: ${OUTPUT_DIR}\n`);

  // Clean output folder
  if (fs.existsSync(OUTPUT_DIR)) {
    fs.readdirSync(OUTPUT_DIR).forEach(f => fs.unlinkSync(path.join(OUTPUT_DIR, f)));
  }

  // 1. Get Sophie's character data
  console.log('1. Fetching character data...');
  const result = await pool.query(
    `SELECT data FROM characters WHERE user_id = $1`,
    ['1767568240635']
  );

  const data = JSON.parse(result.rows[0].data);
  const sophie = data.characters.find(c => c.name === 'Sophie' || c.name.includes('Sophie'));
  console.log(`   Found: ${sophie.name}`);

  // 2. Save reference image (standard avatar)
  console.log('\n2. Saving reference image...');
  const standardAvatar = sophie.avatars?.standard;
  if (standardAvatar) {
    const refPath = saveImage(standardAvatar, '0-reference-standard.png');
    console.log(`   ✅ Reference: ${refPath}`);
  }

  // 3. Generate multiple pirate avatars
  console.log('\n3. Generating pirate avatars (3 attempts)...\n');
  const { generateStyledCostumedAvatar } = require('./server/routes/avatars.js');

  const costumeConfig = {
    costume: 'pirate',
    description: 'A swashbuckling pirate with a red bandana, black tricorn hat with skull emblem, loose white pirate shirt, brown leather vest, and an eyepatch'
  };

  const results = [];

  for (let i = 1; i <= 3; i++) {
    console.log(`   Attempt ${i}...`);
    const costumeResult = await generateStyledCostumedAvatar(sophie, costumeConfig, 'pixar');

    if (costumeResult.success) {
      // Extract ArcFace score from logs (hacky but works for this test)
      // The actual score is printed in the console output
      const filepath = saveImage(costumeResult.imageData, `${i}-pirate-attempt.png`);
      console.log(`   ✅ Saved: ${filepath}\n`);
      results.push({ attempt: i, filepath, success: true });
    } else {
      console.log(`   ❌ Failed: ${costumeResult.error}\n`);
      results.push({ attempt: i, success: false, error: costumeResult.error });
    }
  }

  // 4. Summary
  console.log('\n4. Summary:');
  console.log(`   Output folder: ${OUTPUT_DIR}`);
  console.log('   Files created:');
  console.log('   - 0-reference-standard.png (the reference face)');
  results.forEach(r => {
    if (r.success) {
      console.log(`   - ${r.attempt}-pirate-attempt.png`);
    }
  });
  console.log('\n   Look at the ARCFACE scores above to identify good vs bad generations.');
  console.log('   Good: > 50% similarity');
  console.log('   Bad:  < 50% similarity (face identity lost)');

  await pool.end();
  console.log('\n✅ Done - open test-output/ folder to view images');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
