// Test the new landmark image search strategy
// Run with: node scripts/test-landmark-images.js

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// Inline the key functions for testing
const WIKI_HEADERS = {
  'User-Agent': 'MagicalStory/1.0 (https://magicalstory.ch; contact@magicalstory.ch)',
  'Accept': 'application/json'
};

// NEW: Get Commons category from Wikidata QID
async function getCommonsCategoryFromWikidata(qid) {
  if (!qid) return null;
  try {
    const url = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${qid}&props=claims&format=json&origin=*`;
    const res = await fetch(url, { headers: WIKI_HEADERS });
    const data = await res.json();
    // P373 is the "Commons category" property
    const p373 = data.entities?.[qid]?.claims?.P373?.[0]?.mainsnak?.datavalue?.value;
    if (p373) {
      console.log(`  [WIKIDATA] Found Commons category for ${qid}: "${p373}"`);
      return p373;
    }
    console.log(`  [WIKIDATA] No Commons category (P373) found for ${qid}`);
    return null;
  } catch (err) {
    console.log(`  [WIKIDATA] Error: ${err.message}`);
    return null;
  }
}

// NEW: Fetch images from a Commons category
async function fetchImagesFromCommonsCategory(categoryName, maxImages = 6) {
  const images = [];
  try {
    const url = `https://commons.wikimedia.org/w/api.php?action=query` +
      `&generator=categorymembers&gcmtitle=Category:${encodeURIComponent(categoryName)}` +
      `&gcmtype=file&gcmlimit=${maxImages * 2}` +
      `&prop=imageinfo&iiprop=url|user|size` +
      `&format=json&origin=*`;

    console.log(`  [CATEGORY] Fetching images from "Category:${categoryName}"`);
    const res = await fetch(url, { headers: WIKI_HEADERS });
    const data = await res.json();

    const pages = data.query?.pages;
    if (!pages) {
      console.log(`  [CATEGORY] No images found in category`);
      return images;
    }

    for (const page of Object.values(pages)) {
      if (images.length >= maxImages) break;

      const title = page.title || '';
      const lowerTitle = title.toLowerCase();

      // Skip non-photos
      if (!lowerTitle.endsWith('.jpg') && !lowerTitle.endsWith('.jpeg') && !lowerTitle.endsWith('.png')) continue;
      if (lowerTitle.includes('map') || lowerTitle.includes('wappen') || lowerTitle.includes('logo') ||
          lowerTitle.includes('icon') || lowerTitle.includes('flag')) continue;

      const info = page.imageinfo?.[0];
      if (info?.url && info.width >= 400 && info.height >= 300) {
        images.push({
          url: info.url,
          fileName: title.replace('File:', ''),
          width: info.width,
          height: info.height
        });
        console.log(`    + ${title.substring(0, 60)}... (${info.width}x${info.height})`);
      }
    }
    console.log(`  [CATEGORY] Found ${images.length} suitable images`);
    return images;
  } catch (err) {
    console.log(`  [CATEGORY] Error: ${err.message}`);
    return images;
  }
}

async function fetchWikipediaArticleImages(lang, pageId, maxImages = 6) {
  const images = [];
  try {
    const listUrl = `https://${lang}.wikipedia.org/w/api.php?` +
      `action=query&pageids=${pageId}` +
      `&prop=images&imlimit=${maxImages * 2}` +
      `&format=json&origin=*`;

    console.log(`  [WIKI] Fetching article images: ${lang}:${pageId}`);
    const listRes = await fetch(listUrl, { headers: WIKI_HEADERS });
    const listData = await listRes.json();

    const page = listData.query?.pages?.[pageId];
    if (!page?.images?.length) {
      console.log(`  [WIKI] No images in article`);
      return images;
    }

    const photoFiles = page.images.filter(img => {
      const name = img.title.toLowerCase();
      return (name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.png')) &&
        !name.includes('icon') && !name.includes('logo') && !name.includes('flag') &&
        !name.includes('wappen') && !name.includes('map') && !name.includes('commons-logo');
    });

    console.log(`  [WIKI] Found ${photoFiles.length} potential photos`);

    for (const img of photoFiles.slice(0, maxImages)) {
      try {
        // Normalize: German uses "Datei:", French "Fichier:", etc. Commons uses "File:"
        const commonsTitle = img.title
          .replace(/^Datei:/i, 'File:')
          .replace(/^Fichier:/i, 'File:')
          .replace(/^Archivo:/i, 'File:')
          .replace(/^Immagine:/i, 'File:');

        const infoUrl = `https://commons.wikimedia.org/w/api.php?` +
          `action=query&titles=${encodeURIComponent(commonsTitle)}` +
          `&prop=imageinfo&iiprop=url|user|size` +
          `&format=json&origin=*`;

        const infoRes = await fetch(infoUrl, { headers: WIKI_HEADERS });
        const infoData = await infoRes.json();
        const pages = infoData.query?.pages;
        const infoPage = pages ? Object.values(pages)[0] : null;
        const info = infoPage?.imageinfo?.[0];

        if (info?.url && info.width >= 400 && info.height >= 300) {
          images.push({
            url: info.url,
            fileName: commonsTitle.replace('File:', ''),
            width: info.width,
            height: info.height
          });
          console.log(`    + ${commonsTitle.substring(0, 50)}... (${info.width}x${info.height})`);
        }
      } catch (err) {
        console.log(`    - Error: ${err.message}`);
      }
    }
    return images;
  } catch (err) {
    console.log(`  [WIKI] Error: ${err.message}`);
    return images;
  }
}

async function fetchMultipleImages(searchQuery, maxImages = 6) {
  const images = [];
  try {
    const searchUrl = `https://commons.wikimedia.org/w/api.php?action=query&list=search` +
      `&srsearch=${encodeURIComponent(searchQuery + ' filetype:jpg|jpeg|png')}` +
      `&srnamespace=6&srlimit=${maxImages * 2}&format=json&origin=*`;

    console.log(`  [COMMONS] Searching: "${searchQuery}"`);
    const searchRes = await fetch(searchUrl, { headers: WIKI_HEADERS });
    const searchData = await searchRes.json();

    if (!searchData.query?.search?.length) {
      console.log(`  [COMMONS] No results`);
      return images;
    }

    for (const result of searchData.query.search) {
      if (images.length >= maxImages) break;
      const fileName = result.title;
      const lowerName = fileName.toLowerCase();

      if (lowerName.endsWith('.svg') || lowerName.includes('map') ||
          lowerName.includes('wappen') || lowerName.includes('logo')) continue;

      const infoUrl = `https://commons.wikimedia.org/w/api.php?action=query` +
        `&titles=${encodeURIComponent(fileName)}` +
        `&prop=imageinfo&iiprop=url|user|size&format=json&origin=*`;

      const infoRes = await fetch(infoUrl, { headers: WIKI_HEADERS });
      const infoData = await infoRes.json();
      const pages = infoData.query?.pages;
      const page = pages ? Object.values(pages)[0] : null;
      const info = page?.imageinfo?.[0];

      if (info?.url && info.width >= 400 && info.height >= 300) {
        images.push({
          url: info.url,
          fileName: fileName.replace('File:', ''),
          width: info.width,
          height: info.height
        });
        console.log(`    + ${fileName.substring(0, 60)}...`);
      }
    }
    return images;
  } catch (err) {
    console.log(`  [COMMONS] Error: ${err.message}`);
    return images;
  }
}

async function analyzeImageQuality(imageUrl, landmarkName, locationContext) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.log(`  [AI] No API key, skipping analysis`);
    return { score: 5, isPhoto: true, description: 'Not analyzed' };
  }

  try {
    const imgRes = await fetch(imageUrl, {
      headers: { 'User-Agent': 'MagicalStory/1.0' },
      signal: AbortSignal.timeout(10000)
    });
    if (!imgRes.ok) return null;

    const buffer = await imgRes.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    const mimeType = imgRes.headers.get('content-type')?.split(';')[0] || 'image/jpeg';

    const locationCheck = locationContext
      ? `\n5. LOCATION_MATCH: Does this appear to be "${landmarkName}" in ${locationContext}? (10 = definitely matches, 1 = clearly different place)`
      : '';

    const prompt = `Analyze this image of "${landmarkName}"${locationContext ? ` (expected: ${locationContext})` : ''}.

Rate 1-10:
1. PHOTO_QUALITY: Clear, well-lit?
2. IS_LANDMARK_PHOTO: Shows building/monument? (not map, logo, portrait)
3. VISUAL_INTEREST: Interesting for children's book?
4. COMPOSITION: Subject visible and well-framed?${locationCheck}

JSON response:
{"photoQuality":<1-10>,"isLandmarkPhoto":<1-10>,"visualInterest":<1-10>,"composition":<1-10>${locationContext ? ',"locationMatch":<1-10>,"detectedLocation":"where is this"' : ''},"description":"one sentence"}`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType, data: base64 } }] }],
        generationConfig: { maxOutputTokens: 300, temperature: 0.1 }
      }),
      signal: AbortSignal.timeout(15000)
    });

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!text) return null;

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const analysis = JSON.parse(jsonMatch[0]);
    const locationMatch = analysis.locationMatch || 10;
    const locationPenalty = locationMatch < 5 ? 0.3 : 1.0;

    const baseScore = (analysis.photoQuality * 0.2) + (analysis.isLandmarkPhoto * 0.35) +
      (analysis.visualInterest * 0.25) + (analysis.composition * 0.2);
    const score = Math.round(baseScore * locationPenalty);

    return {
      score,
      isPhoto: analysis.isLandmarkPhoto >= 5,
      locationMatch,
      detectedLocation: analysis.detectedLocation,
      description: analysis.description
    };
  } catch (err) {
    console.log(`  [AI] Error: ${err.message}`);
    return null;
  }
}

async function testLandmark(name, type, lang, pageId, qid, canton) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`TESTING: ${name} (${type}) - ${canton}, Switzerland`);
  console.log(`Wikipedia: ${lang}:${pageId} | Wikidata: ${qid || 'none'}`);
  console.log('='.repeat(70));

  let candidates = [];

  // STEP 1: Try Commons category via Wikidata (NEW - best source)
  if (qid) {
    console.log(`\nSTEP 1: Commons category via Wikidata QID (${qid})`);
    const categoryName = await getCommonsCategoryFromWikidata(qid);
    if (categoryName) {
      candidates = await fetchImagesFromCommonsCategory(categoryName, 6);
    }
  } else {
    console.log(`\nSTEP 1: Skipped (no Wikidata QID)`);
  }

  // STEP 2: Try Wikipedia article images (if we need more)
  if (candidates.length < 4 && lang && pageId) {
    console.log(`\nSTEP 2: Wikipedia article images`);
    const wikiImages = await fetchWikipediaArticleImages(lang, pageId, 6 - candidates.length);
    // Add images that aren't already in candidates (by URL)
    const existingUrls = new Set(candidates.map(c => c.url));
    for (const img of wikiImages) {
      if (!existingUrls.has(img.url)) {
        candidates.push(img);
        existingUrls.add(img.url);
      }
    }
    console.log(`  Total candidates so far: ${candidates.length}`);
  }

  // STEP 3: Fallback to Commons search with location (if still not enough)
  if (candidates.length < 4) {
    console.log(`\nSTEP 3: Fallback to Commons search with location`);
    const searchQuery = `${name} ${canton} Switzerland`;
    const searchImages = await fetchMultipleImages(searchQuery, 6 - candidates.length);
    const existingUrls = new Set(candidates.map(c => c.url));
    for (const img of searchImages) {
      if (!existingUrls.has(img.url)) {
        candidates.push(img);
        existingUrls.add(img.url);
      }
    }
    console.log(`  Total candidates: ${candidates.length}`);
  }

  // Analyze all candidates
  if (candidates.length > 0) {
    console.log(`\n📊 Analyzing ${candidates.length} images with AI...`);
    const locationContext = `${canton}, Switzerland`;
    for (const img of candidates) {
      const analysis = await analyzeImageQuality(img.url, name, locationContext);
      if (analysis) {
        const locNote = analysis.locationMatch < 5 ? ` [WRONG LOCATION: ${analysis.detectedLocation}]` : '';
        console.log(`  Score: ${analysis.score}/10${locNote} - ${analysis.description?.substring(0, 50)}...`);
        img.analysis = analysis;
      }
    }

    // Filter and sort
    const good = candidates
      .filter(c => c.analysis?.score >= 5 && c.analysis?.isPhoto && (c.analysis?.locationMatch || 10) >= 5)
      .sort((a, b) => (b.analysis?.score || 0) - (a.analysis?.score || 0));

    if (good.length >= 1) {
      console.log(`\n✅ Found ${good.length} good images:`);
      good.slice(0, 4).forEach((g, i) => {
        console.log(`  ${i+1}. Score ${g.analysis.score}: ${g.fileName.substring(0, 60)}...`);
        console.log(`     URL: ${g.url.substring(0, 80)}...`);
      });
    } else {
      console.log(`\n❌ No good images passed quality filter`);
    }
  } else {
    console.log(`\n❌ No images found from any source`);
  }
}

async function lookupWikidataQid(lang, pageId) {
  try {
    const url = `https://${lang}.wikipedia.org/w/api.php?action=query&pageids=${pageId}&prop=pageprops&format=json&origin=*`;
    const res = await fetch(url, { headers: WIKI_HEADERS });
    const data = await res.json();
    return data.query?.pages?.[pageId]?.pageprops?.wikibase_item || null;
  } catch (err) {
    return null;
  }
}

async function lookupPageIdAndQid(lang, title) {
  try {
    const url = `https://${lang}.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=pageprops&format=json&origin=*`;
    const res = await fetch(url, { headers: WIKI_HEADERS });
    const data = await res.json();
    const pages = data.query?.pages;
    if (!pages) return { pageId: null, qid: null };
    const page = Object.values(pages)[0];
    if (page.pageid < 0) return { pageId: null, qid: null };
    return {
      pageId: page.pageid,
      qid: page.pageprops?.wikibase_item || null
    };
  } catch (err) {
    return { pageId: null, qid: null };
  }
}

async function main() {
  console.log('Landmark Image Search Test - NEW STRATEGY');
  console.log('=========================================');
  console.log('Strategy: Commons category (via Wikidata) → Wikipedia article → Commons search\n');

  // Test case 1: Ruine Stein (the problematic one)
  console.log('Looking up Ruine Stein (Baden)...');
  const ruineStein = await lookupPageIdAndQid('de', 'Ruine_Stein_(Baden)');
  console.log(`  Page ID: ${ruineStein.pageId}, QID: ${ruineStein.qid}`);

  if (ruineStein.pageId) {
    await testLandmark('Ruine Stein', 'Castle', 'de', ruineStein.pageId, ruineStein.qid, 'AG');
  } else {
    console.log('Could not find Ruine Stein Wikipedia page');
  }

  // Test case 2: Holzbrücke (usually works well)
  console.log('\n\nLooking up Holzbrücke (Baden)...');
  const holzbruecke = await lookupPageIdAndQid('de', 'Holzbrücke_(Baden)');
  console.log(`  Page ID: ${holzbruecke.pageId}, QID: ${holzbruecke.qid}`);

  if (holzbruecke.pageId) {
    await testLandmark('Holzbrücke Baden', 'Bridge', 'de', holzbruecke.pageId, holzbruecke.qid, 'AG');
  }

  // Test case 3: Stadtturm (popular landmark)
  console.log('\n\nLooking up Stadtturm (Baden)...');
  const stadtturm = await lookupPageIdAndQid('de', 'Stadtturm_(Baden)');
  console.log(`  Page ID: ${stadtturm.pageId}, QID: ${stadtturm.qid}`);

  if (stadtturm.pageId) {
    await testLandmark('Stadtturm', 'Monument', 'de', stadtturm.pageId, stadtturm.qid, 'AG');
  }
}

main().catch(console.error);
