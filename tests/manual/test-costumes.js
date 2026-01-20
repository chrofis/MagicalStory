/**
 * Test different costumes - avoiding hats/head coverings per prompt rules
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

// Test costumes that DON'T conflict with "no hats/head coverings" rule
const TEST_COSTUMES = [
  {
    name: 'medieval-peasant',
    costume: 'medieval peasant',
    description: 'A medieval peasant outfit: rough brown linen tunic with rope belt, simple cream-colored undershirt with loose sleeves, brown wool pants, and worn leather boots. No hat or head covering.'
  },
  {
    name: 'superhero',
    costume: 'superhero',
    description: 'A child-friendly superhero costume: bright blue bodysuit with red cape flowing behind, yellow lightning bolt emblem on chest, red boots and red gloves. NO MASK - face fully visible.'
  },
  {
    name: 'ballerina',
    costume: 'ballerina',
    description: 'An elegant ballerina outfit: pink tutu with layered tulle skirt, fitted pink leotard top, pink ballet slippers with ribbons, small pearl earrings. Hair in a neat bun.'
  }
];

async function main() {
  console.log('🎭 Costume Test - Multiple Designs\n');
  console.log(`Output folder: ${OUTPUT_DIR}\n`);

  // Clean output folder
  if (fs.existsSync(OUTPUT_DIR)) {
    fs.readdirSync(OUTPUT_DIR).forEach(f => fs.unlinkSync(path.join(OUTPUT_DIR, f)));
  }

  // Get character data
  console.log('1. Fetching character data...');
  const result = await pool.query(
    `SELECT data FROM characters WHERE user_id = $1`,
    ['1767568240635']
  );

  const data = JSON.parse(result.rows[0].data);
  const sophie = data.characters.find(c => c.name === 'Sophie' || c.name.includes('Sophie'));
  console.log(`   Found: ${sophie.name}\n`);

  // Save reference
  console.log('2. Saving reference...');
  if (sophie.avatars?.standard) {
    saveImage(sophie.avatars.standard, '0-reference.png');
    console.log('   ✅ Saved reference\n');
  }

  // Generate each costume
  console.log('3. Generating costumes...\n');
  const { generateStyledCostumedAvatar } = require('./server/routes/avatars.js');

  for (let i = 0; i < TEST_COSTUMES.length; i++) {
    const costume = TEST_COSTUMES[i];
    console.log(`   [${i + 1}/${TEST_COSTUMES.length}] ${costume.name}...`);
    console.log(`   Description: ${costume.description.substring(0, 80)}...`);

    const result = await generateStyledCostumedAvatar(sophie, {
      costume: costume.costume,
      description: costume.description
    }, 'pixar');

    if (result.success) {
      const filename = `${i + 1}-${costume.name}.png`;
      saveImage(result.imageData, filename);
      console.log(`   ✅ Saved: ${filename}\n`);
    } else {
      console.log(`   ❌ Failed: ${result.error}\n`);
    }
  }

  console.log('4. Summary - check ArcFace scores above');
  console.log(`   Output: ${OUTPUT_DIR}`);

  await pool.end();
  console.log('\n✅ Done');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
