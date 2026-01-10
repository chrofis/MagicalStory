/**
 * Test script to generate a costumed avatar and compare with ArcFace
 * Compares costumed avatar to:
 * 1. Original photo (double transformation: photo → illustrated → costumed)
 * 2. Standard avatar (single transformation: illustrated → costumed)
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function main() {
  console.log('🎭 Costumed Avatar ArcFace Test\n');

  // 1. Get Sophie's character data from database
  console.log('1. Fetching character data...');
  const result = await pool.query(
    `SELECT data FROM characters WHERE user_id = $1`,
    ['1767568240635']
  );

  if (!result.rows.length) {
    console.error('No character data found');
    process.exit(1);
  }

  const data = JSON.parse(result.rows[0].data);
  const sophie = data.characters.find(c => c.name === 'Sophie' || c.name.includes('Sophie'));

  if (!sophie) {
    console.error('Sophie not found in characters');
    process.exit(1);
  }

  console.log(`   Found: ${sophie.name}`);
  console.log(`   Has standard avatar: ${!!sophie.avatars?.standard}`);
  console.log(`   Has face photo: ${!!sophie.photos?.face}`);

  // 2. Generate costumed avatar (pirate)
  console.log('\n2. Generating pirate costume avatar...');
  const { generateStyledCostumedAvatar } = require('./server/routes/avatars.js');

  const costumeConfig = {
    costume: 'pirate',
    description: 'A swashbuckling pirate with a red bandana, black tricorn hat with skull emblem, loose white pirate shirt, brown leather vest, and an eyepatch'
  };

  const artStyle = 'pixar';

  const costumeResult = await generateStyledCostumedAvatar(sophie, costumeConfig, artStyle);

  if (!costumeResult.success) {
    console.error('Failed to generate costumed avatar:', costumeResult.error);
    process.exit(1);
  }

  const costumedAvatar = costumeResult.imageData;
  console.log(`   ✅ Generated pirate avatar (${Math.round(costumedAvatar.length / 1024)}KB)`);
  console.log(`   Note: Built-in evaluation compared to standard avatar (see logs above)`);

  // 3. Now compare with ArcFace to ORIGINAL PHOTO (different from built-in which uses standard)
  console.log('\n3. Additional ArcFace comparison to ORIGINAL PHOTO...');

  const photoAnalyzerUrl = process.env.PHOTO_ANALYZER_URL || 'http://127.0.0.1:5000';

  // 3a. Compare costumed avatar to original photo
  console.log('\n   a) Costumed → Original Photo:');
  const originalPhoto = sophie.photos?.face || sophie.photos?.original || sophie.photoUrl;

  if (originalPhoto) {
    try {
      const photoResult = await fetchJson(`${photoAnalyzerUrl}/compare-identity`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image1: originalPhoto,
          image2: costumedAvatar,
          quadrant2: 'top-left'  // Use first quadrant of 2x2 grid
        })
      });

      if (photoResult.success) {
        console.log(`      Similarity: ${(photoResult.similarity * 100).toFixed(1)}%`);
        console.log(`      Same person: ${photoResult.same_person} (${photoResult.confidence})`);
      } else {
        console.log(`      Failed: ${photoResult.error}`);
      }
    } catch (err) {
      console.log(`      Error: ${err.message}`);
    }
  } else {
    console.log('      No original photo available');
  }

  // 3b. Compare costumed avatar to standard avatar (manual check to confirm built-in result)
  console.log('\n   b) Costumed → Standard Avatar (confirmation):');
  const standardAvatar = sophie.avatars?.standard;

  if (standardAvatar) {
    try {
      const standardResult = await fetchJson(`${photoAnalyzerUrl}/compare-identity`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image1: standardAvatar,
          image2: costumedAvatar,
          quadrant1: 'top-left',  // Standard is also 2x2 grid
          quadrant2: 'top-left'
        })
      });

      if (standardResult.success) {
        console.log(`      Similarity: ${(standardResult.similarity * 100).toFixed(1)}%`);
        console.log(`      Same person: ${standardResult.same_person} (${standardResult.confidence})`);
      } else {
        console.log(`      Failed: ${standardResult.error}`);
      }
    } catch (err) {
      console.log(`      Error: ${err.message}`);
    }
  } else {
    console.log('      No standard avatar available');
  }

  // 3c. Also compare standard to photo (baseline)
  console.log('\n   c) Standard Avatar → Original Photo (baseline):');
  if (standardAvatar && originalPhoto) {
    try {
      const baselineResult = await fetchJson(`${photoAnalyzerUrl}/compare-identity`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image1: originalPhoto,
          image2: standardAvatar,
          quadrant2: 'top-left'
        })
      });

      if (baselineResult.success) {
        console.log(`      Similarity: ${(baselineResult.similarity * 100).toFixed(1)}%`);
        console.log(`      Same person: ${baselineResult.same_person} (${baselineResult.confidence})`);
      } else {
        console.log(`      Failed: ${baselineResult.error}`);
      }
    } catch (err) {
      console.log(`      Error: ${err.message}`);
    }
  }

  console.log('\n4. Analysis:');
  console.log('   - If (a) ≈ (b): Both comparisons are equally valid');
  console.log('   - If (b) > (a): Standard avatar comparison is better');
  console.log('   - If (a) > (b): Photo comparison is better (unexpected)');
  console.log('   - Comparing to standard removes photo→illustration variable');

  await pool.end();
  console.log('\n✅ Done');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
