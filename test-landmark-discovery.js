const { discoverLandmarksForLocation, clearCache } = require('./server/lib/landmarkPhotos');

async function test() {
  // Clear cache for fresh test
  clearCache();

  const testCases = [
    { city: 'Zurich', country: 'Switzerland' },
    { city: 'Paris', country: 'France' }
  ];

  for (const { city, country } of testCases) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Testing: ${city}, ${country}`);
    console.log('='.repeat(60));

    try {
      const landmarks = await discoverLandmarksForLocation(city, country, 5);

      console.log(`\nFound ${landmarks.length} landmarks:`);
      for (const landmark of landmarks) {
        const photoSize = landmark.photoData
          ? Math.round(landmark.photoData.length * 0.75 / 1024)
          : 0;
        console.log(`  - ${landmark.name} (${landmark.photoCount} photos, ${photoSize}KB)`);
      }

      if (landmarks.length === 0) {
        console.log('  (no landmarks found)');
      }
    } catch (err) {
      console.error(`Error: ${err.message}`);
    }
  }
}

test();
