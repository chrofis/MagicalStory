// Test the full landmark image + Wikipedia extract functionality
// Run with: node scripts/test-landmark-full.js

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const WIKI_HEADERS = {
  'User-Agent': 'MagicalStory/1.0 (https://magicalstory.ch; contact@magicalstory.ch)',
  'Accept': 'application/json'
};

let output = '';
function log(msg) {
  console.log(msg);
  output += msg + '\n';
}

// Fetch Wikipedia extract
async function fetchWikipediaExtract(lang, pageId, maxSentences = 3) {
  if (!lang || !pageId) return null;
  try {
    const url = `https://${lang}.wikipedia.org/w/api.php?action=query&pageids=${pageId}` +
      `&prop=extracts&exintro=1&explaintext=1&exsentences=${maxSentences}` +
      `&format=json&origin=*`;
    const res = await fetch(url, { headers: WIKI_HEADERS });
    const data = await res.json();
    return data.query?.pages?.[pageId]?.extract?.trim() || null;
  } catch (err) {
    return null;
  }
}

// Get Commons category from Wikidata
async function getCommonsCategoryFromWikidata(qid) {
  if (!qid) return null;
  try {
    const url = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${qid}&props=claims&format=json&origin=*`;
    const res = await fetch(url, { headers: WIKI_HEADERS });
    const data = await res.json();
    return data.entities?.[qid]?.claims?.P373?.[0]?.mainsnak?.datavalue?.value || null;
  } catch (err) {
    return null;
  }
}

// Fetch images from Commons category
async function fetchImagesFromCommonsCategory(categoryName, maxImages = 15) {
  const images = [];
  try {
    const url = `https://commons.wikimedia.org/w/api.php?action=query` +
      `&generator=categorymembers&gcmtitle=Category:${encodeURIComponent(categoryName)}` +
      `&gcmtype=file&gcmlimit=${maxImages}` +
      `&prop=imageinfo&iiprop=url|user|size` +
      `&format=json&origin=*`;
    const res = await fetch(url, { headers: WIKI_HEADERS });
    const data = await res.json();
    const pages = data.query?.pages || {};

    for (const page of Object.values(pages)) {
      const title = page.title || '';
      const lowerTitle = title.toLowerCase();
      if (!lowerTitle.endsWith('.jpg') && !lowerTitle.endsWith('.jpeg') && !lowerTitle.endsWith('.png')) continue;
      if (lowerTitle.includes('map') || lowerTitle.includes('wappen') || lowerTitle.includes('logo')) continue;

      const info = page.imageinfo?.[0];
      if (info?.url && info.width >= 400 && info.height >= 300) {
        images.push({ url: info.url, fileName: title.replace('File:', ''), width: info.width, height: info.height });
      }
    }
    return images;
  } catch (err) {
    return images;
  }
}

// Analyze image with AI
async function analyzeImage(imageUrl, landmarkName) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { score: 5, isExterior: true, description: 'Not analyzed (no API key)' };

  try {
    const imgRes = await fetch(imageUrl, {
      headers: { 'User-Agent': 'MagicalStory/1.0' },
      signal: AbortSignal.timeout(15000)
    });
    if (!imgRes.ok) return null;

    const buffer = await imgRes.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    const mimeType = imgRes.headers.get('content-type')?.split(';')[0] || 'image/jpeg';

    const prompt = `Analyze this image of "${landmarkName}" for a children's book.

Rate 1-10:
1. PHOTO_QUALITY: Clear, well-lit?
2. IS_LANDMARK_PHOTO: Shows building/monument? (not map, logo, portrait)
3. VISUAL_INTEREST: Interesting for children?
4. COMPOSITION: Subject visible and well-framed?

JSON response:
{"photoQuality":<1-10>,"isLandmarkPhoto":<1-10>,"visualInterest":<1-10>,"composition":<1-10>,"isExterior":<true/false>,"description":"one sentence"}`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType, data: base64 } }] }],
        generationConfig: { maxOutputTokens: 300, temperature: 0.1 }
      }),
      signal: AbortSignal.timeout(20000)
    });

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!text) return null;

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const analysis = JSON.parse(jsonMatch[0]);
    const score = Math.round(
      (analysis.photoQuality * 0.2) + (analysis.isLandmarkPhoto * 0.35) +
      (analysis.visualInterest * 0.25) + (analysis.composition * 0.2)
    );

    return {
      score,
      isExterior: analysis.isExterior !== false,
      isPhoto: analysis.isLandmarkPhoto >= 5,
      description: analysis.description
    };
  } catch (err) {
    return null;
  }
}

// Look up Wikipedia page info
async function lookupPageInfo(lang, title) {
  try {
    const url = `https://${lang}.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=pageprops&format=json&origin=*`;
    const res = await fetch(url, { headers: WIKI_HEADERS });
    const data = await res.json();
    const page = Object.values(data.query?.pages || {})[0];
    if (!page || page.pageid < 0) return null;
    return { pageId: page.pageid, qid: page.pageprops?.wikibase_item || null };
  } catch (err) {
    return null;
  }
}

async function testLandmark(name, wikiTitle) {
  log(`\n${'='.repeat(80)}`);
  log(`${name}`);
  log('='.repeat(80));

  // Get Wikipedia page info
  const pageInfo = await lookupPageInfo('de', wikiTitle);
  if (!pageInfo) {
    log('   ERROR: Could not find Wikipedia page');
    return null;
  }

  // Get Wikipedia extract
  const extract = await fetchWikipediaExtract('de', pageInfo.pageId, 3);

  // Get Commons category
  const category = await getCommonsCategoryFromWikidata(pageInfo.qid);
  if (!category) {
    log('   Wikipedia: ' + (extract || 'None'));
    log('   ERROR: No Commons category found');
    return null;
  }

  // Fetch images from category
  const images = await fetchImagesFromCommonsCategory(category, 12);

  // Analyze images
  const analyzed = [];
  for (const img of images.slice(0, 10)) {
    const analysis = await analyzeImage(img.url, name);
    if (analysis && analysis.score >= 5 && analysis.isPhoto) {
      analyzed.push({ ...img, ...analysis });
    }
  }

  // Separate exterior/interior
  const exterior = analyzed.filter(i => i.isExterior).sort((a, b) => b.score - a.score).slice(0, 2);
  const interior = analyzed.filter(i => !i.isExterior).sort((a, b) => b.score - a.score).slice(0, 2);

  log(`   Wikipedia: ${extract || 'None'}`);
  log('');

  if (exterior.length > 0) {
    log('   EXTERIOR PHOTOS:');
    exterior.forEach((e, i) => {
      log(`   ${i+1}. [Score ${e.score}] ${e.description}`);
      log(`      URL: ${e.url}`);
    });
  } else {
    log('   EXTERIOR PHOTOS: None found');
  }

  log('');

  if (interior.length > 0) {
    log('   INTERIOR PHOTOS:');
    interior.forEach((e, i) => {
      log(`   ${i+1}. [Score ${e.score}] ${e.description}`);
      log(`      URL: ${e.url}`);
    });
  } else {
    log('   INTERIOR PHOTOS: None found');
  }

  return { name, extract, exterior, interior, category };
}

async function main() {
  log('Baden Landmarks - Full Test Results');
  log('Generated: ' + new Date().toISOString().split('T')[0]);
  log('Strategy: Wikipedia extract + Commons category (via Wikidata) + AI analysis');
  log('Photos: Up to 2 exterior + 2 interior per landmark');

  const landmarks = [
    ['Ruine Stein', 'Ruine_Stein'],
    ['Holzbrücke Baden', 'Holzbrücke_(Baden)'],
    ['Stadtturm Baden', 'Stadtturm_(Baden)'],
    ['Kurpark Baden', 'Kurpark_(Baden)'],
    ['Historisches Museum Baden', 'Historisches_Museum_Baden'],
    ['Landvogteischloss Baden', 'Landvogteischloss_Baden'],
    ['Reformierte Kirche Baden', 'Reformierte_Kirche_Baden'],
    ['Stadtpfarrkirche Maria Himmelfahrt', 'Stadtpfarrkirche_Maria_Himmelfahrt_(Baden)'],
  ];

  const results = [];
  for (const [name, wikiTitle] of landmarks) {
    const result = await testLandmark(name, wikiTitle);
    if (result) results.push(result);
    await new Promise(r => setTimeout(r, 500)); // Rate limiting
  }

  // Summary
  log('\n' + '='.repeat(80));
  log('SUMMARY');
  log('='.repeat(80));
  log(`Total landmarks tested: ${landmarks.length}`);
  log(`With Wikipedia extract: ${results.filter(r => r.extract).length}`);
  log(`With exterior photos: ${results.filter(r => r.exterior.length > 0).length}`);
  log(`With interior photos: ${results.filter(r => r.interior.length > 0).length}`);

  // Write to file
  fs.writeFileSync('baden_test_results.txt', output);
  console.log('\n\nResults written to baden_test_results.txt');
}

main().catch(console.error);
