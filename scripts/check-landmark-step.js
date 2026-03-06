// Check where landmark flow fails
// Run with: DATABASE_URL=... node scripts/check-landmark-step.js

const { Pool } = require('pg');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    // Find latest story with Ruine Stein (title is in data JSON)
    const stories = await pool.query(`
      SELECT id, data->>'title' as title FROM stories
      WHERE data->>'title' LIKE '%Ruine Stein%'
      ORDER BY created_at DESC LIMIT 1
    `);

    if (stories.rows.length === 0) {
      console.log('No story found');
      return;
    }

    const storyId = stories.rows[0].id;
    console.log('Story:', stories.rows[0].title);
    console.log('ID:', storyId);

    // Get data blob
    const dataResult = await pool.query('SELECT data FROM stories WHERE id = $1', [storyId]);
    const data = dataResult.rows[0]?.data;

    if (!data) {
      console.log('No data');
      return;
    }

    // STEP 4 CHECK: Visual Bible locations with photoVariants
    console.log('\n=== STEP 4: Visual Bible Locations ===');
    const vb = data.visualBible;
    if (vb?.locations) {
      for (const loc of vb.locations) {
        if (loc.isRealLandmark) {
          console.log(`${loc.name} [${loc.id}]:`);
          console.log(`  isRealLandmark: ${loc.isRealLandmark}`);
          console.log(`  isSwissPreIndexed: ${loc.isSwissPreIndexed || false}`);
          console.log(`  photoVariants: ${loc.photoVariants?.length || 0}`);
          if (loc.photoVariants?.length > 0) {
            loc.photoVariants.forEach((v, i) => {
              console.log(`    v${i+1}: ${v.description?.substring(0, 50) || 'no desc'}...`);
            });
          }
        }
      }
    }

    // STEP 5 & 6 CHECK: Scene descriptions with setting.location
    console.log('\n=== STEP 5-6: Scene Descriptions ===');
    const images = data.images || data.sceneImages || [];
    for (const img of images) {
      const pageNum = img.pageNumber;

      // Check parsedSceneMetadata
      const meta = img.parsedSceneMetadata;
      if (meta) {
        const loc = meta.setting?.location;
        const variant = meta.landmarkVariant;
        const hasLocId = loc && /\[LOC\d+\]/i.test(loc);
        console.log(`Page ${pageNum}: location="${loc || 'none'}" hasLocId=${hasLocId} variant=${variant || 'default(1)'}`);
      } else {
        console.log(`Page ${pageNum}: NO parsedSceneMetadata`);
      }
    }

    // Check if any page had landmarkPhotos
    console.log('\n=== Image landmarkPhotos ===');
    let foundAny = false;
    for (const img of images) {
      if (img.landmarkPhotos?.length > 0) {
        console.log(`Page ${img.pageNumber}: ${img.landmarkPhotos.length} landmark photo(s)`);
        foundAny = true;
      }
    }
    if (!foundAny) {
      console.log('No pages have landmarkPhotos');
    }

  } finally {
    await pool.end();
  }
}

main().catch(console.error);
