/**
 * Test script: Deduplicate landmarks across languages using Wikidata Q-IDs
 *
 * Run with: node test-wikidata.js
 */

const WIKI_HEADERS = {
  'User-Agent': 'MagicalStory/1.0 (https://magicalstory.ch; contact@magicalstory.ch) Node.js',
  'Accept': 'application/json'
};

/**
 * Geocode city to coordinates
 */
async function geocodeCity(city, country) {
  const query = [city, country].filter(Boolean).join(', ');
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`;

  const res = await fetch(url, {
    headers: { 'User-Agent': 'MagicalStory/1.0 (https://magicalstory.ch)' }
  });
  const data = await res.json();

  if (data.length > 0) {
    return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
  }
  return null;
}

/**
 * Search Wikipedia for landmarks near coordinates
 */
async function searchWikipediaLandmarks(lat, lon, lang, radiusMeters = 10000) {
  const url = `https://${lang}.wikipedia.org/w/api.php?` +
    `action=query&list=geosearch` +
    `&gscoord=${lat}|${lon}` +
    `&gsradius=${Math.min(radiusMeters, 10000)}` +
    `&gslimit=20` +
    `&format=json&origin=*`;

  const res = await fetch(url, { headers: WIKI_HEADERS });
  const data = await res.json();

  return (data.query?.geosearch || []).map(item => ({
    name: item.title,
    pageId: item.pageid,
    distance: item.dist,
    lang
  }));
}

/**
 * Fetch Wikidata Q-IDs for a batch of Wikipedia page IDs
 * This is the key function - it gets the universal ID that's the same across all languages
 */
async function fetchWikidataIds(lang, pageIds) {
  if (!pageIds || pageIds.length === 0) return new Map();

  const results = new Map();

  // Wikipedia API allows up to 50 page IDs per request
  const batchSize = 50;
  for (let i = 0; i < pageIds.length; i += batchSize) {
    const batch = pageIds.slice(i, i + batchSize);

    // Use pageprops to get wikibase_item (Wikidata Q-ID)
    const url = `https://${lang}.wikipedia.org/w/api.php?` +
      `action=query&pageids=${batch.join('|')}` +
      `&prop=pageprops&ppprop=wikibase_item` +
      `&format=json&origin=*`;

    try {
      const res = await fetch(url, { headers: WIKI_HEADERS });
      const data = await res.json();

      const pages = data.query?.pages || {};
      for (const [pageId, page] of Object.entries(pages)) {
        const qid = page.pageprops?.wikibase_item;
        if (qid) {
          results.set(parseInt(pageId), qid);
        }
      }
    } catch (err) {
      console.error(`Failed to fetch Wikidata IDs for ${lang}: ${err.message}`);
    }
  }

  return results;
}

/**
 * Discover landmarks with Wikidata deduplication
 */
async function discoverLandmarksWithDedup(city, country) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🔍 Discovering landmarks for: ${city}, ${country}`);
  console.log('='.repeat(60));

  // Step 1: Geocode
  const coords = await geocodeCity(city, country);
  if (!coords) {
    console.log('❌ Failed to geocode city');
    return;
  }
  console.log(`📍 Coordinates: ${coords.lat}, ${coords.lon}`);

  // Step 2: Search multiple Wikipedia languages
  const languages = ['de', 'en', 'fr'];
  const allLandmarks = [];

  for (const lang of languages) {
    const landmarks = await searchWikipediaLandmarks(coords.lat, coords.lon, lang);
    console.log(`\n📚 ${lang}.wikipedia: Found ${landmarks.length} articles`);

    // Fetch Wikidata Q-IDs for this batch
    const pageIds = landmarks.map(l => l.pageId);
    const qidMap = await fetchWikidataIds(lang, pageIds);

    // Add Q-ID to each landmark
    for (const landmark of landmarks) {
      landmark.qid = qidMap.get(landmark.pageId) || null;
      allLandmarks.push(landmark);

      if (landmark.qid) {
        console.log(`   ✓ ${landmark.name} → ${landmark.qid}`);
      } else {
        console.log(`   ✗ ${landmark.name} (no Q-ID)`);
      }
    }
  }

  // Step 3: Deduplicate by Wikidata Q-ID
  console.log(`\n${'─'.repeat(60)}`);
  console.log('🔄 DEDUPLICATION BY WIKIDATA Q-ID:');
  console.log('─'.repeat(60));

  const byQid = new Map();
  const noQid = [];

  for (const landmark of allLandmarks) {
    if (landmark.qid) {
      if (!byQid.has(landmark.qid)) {
        byQid.set(landmark.qid, []);
      }
      byQid.get(landmark.qid).push(landmark);
    } else {
      noQid.push(landmark);
    }
  }

  // Show duplicates found
  let duplicateCount = 0;
  for (const [qid, landmarks] of byQid.entries()) {
    if (landmarks.length > 1) {
      duplicateCount++;
      const names = landmarks.map(l => `${l.name} (${l.lang})`).join(' = ');
      console.log(`\n🔗 ${qid}: ${names}`);
    }
  }

  console.log(`\n📊 SUMMARY:`);
  console.log(`   Total landmarks found: ${allLandmarks.length}`);
  console.log(`   Unique Q-IDs: ${byQid.size}`);
  console.log(`   Duplicates found: ${duplicateCount}`);
  console.log(`   Without Q-ID: ${noQid.length}`);

  // Step 4: Build deduplicated list (prefer German name, then English, then French)
  const deduplicated = [];
  const langPriority = { 'de': 1, 'en': 2, 'fr': 3 };

  for (const [qid, landmarks] of byQid.entries()) {
    // Sort by language priority and pick first
    landmarks.sort((a, b) => (langPriority[a.lang] || 99) - (langPriority[b.lang] || 99));
    const best = landmarks[0];

    // Store all language variants for reference
    best.variants = landmarks.map(l => ({ name: l.name, lang: l.lang }));
    deduplicated.push(best);
  }

  // Add landmarks without Q-ID (can't dedupe these)
  deduplicated.push(...noQid);

  // Sort by distance
  deduplicated.sort((a, b) => a.distance - b.distance);

  console.log(`\n✅ DEDUPLICATED LIST (${deduplicated.length} landmarks):`);
  for (const l of deduplicated.slice(0, 15)) {
    const variants = l.variants?.length > 1
      ? ` [also: ${l.variants.slice(1).map(v => `${v.name}(${v.lang})`).join(', ')}]`
      : '';
    console.log(`   ${l.distance}m - ${l.name} (${l.lang})${variants}`);
  }

  return deduplicated;
}

// Run tests
async function main() {
  await discoverLandmarksWithDedup('Baden', 'Switzerland');
  await discoverLandmarksWithDedup('Bern', 'Switzerland');
}

main().catch(console.error);
