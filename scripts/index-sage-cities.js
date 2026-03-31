/**
 * Index landmarks for all Sage cities that are missing from the landmark_index.
 * Run via: railway run -- node scripts/index-sage-cities.js
 */
const { discoverLandmarksForLocation } = require('../server/lib/landmarkPhotos');

const cities = [
  'Maienfeld', 'Andermatt', 'Grindelwald', 'Interlaken', 'Zermatt',
  'Broc', 'Altdorf', 'Sempach', 'Kandersteg', 'Vals', 'Wimmis'
];

async function run() {
  console.log(`Indexing ${cities.length} cities...`);
  for (const city of cities) {
    try {
      console.log(`\n📍 Indexing: ${city}...`);
      const results = await discoverLandmarksForLocation(city, 'Switzerland', 30);
      console.log(`  ✅ ${city}: ${results ? results.length : 0} landmarks discovered`);
    } catch (e) {
      console.log(`  ❌ ${city}: ${e.message}`);
    }
  }
  console.log('\nDone!');
  process.exit(0);
}

run();
