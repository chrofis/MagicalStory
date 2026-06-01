#!/usr/bin/env node
/**
 * Reindex Swiss cities that landmark_index has zero coverage for.
 *
 * For each city in scripts/admin/reindex-targets.json:
 *   1. Add a city-overview entry — fetches the city's own Wikipedia page
 *      and saves the lead photo as a "distant" fallback. This guarantees
 *      every Swiss city has at least ONE usable photo (an aerial / town
 *      view), even small ones with no recognized landmarks.
 *   2. Run the existing landmarkPhotos.indexLandmarksForCities pipeline
 *      for just this city, with country='Switzerland' to prevent the
 *      IP-geocoding leakage that polluted past runs.
 *   3. Classify each newly-added photo via Gemini Vision into one of
 *      five categories (distant / close / interior / view_from / bad)
 *      — same prompt as scripts/admin/classify-landmark-photos.js.
 *
 * Defaults to DRY-RUN. Pass --push to write to DB. Pass --max=N to
 * process only the first N cities (useful for testing).
 *
 * Usage:
 *   node scripts/admin/reindex-missing-cities.js                    # dry-run, all 78 cities
 *   node scripts/admin/reindex-missing-cities.js --max=5 --push    # write 5 cities to DB
 *   node scripts/admin/reindex-missing-cities.js --push            # write all 78
 *   node scripts/admin/reindex-missing-cities.js --skip-classify   # skip Gemini Vision calls
 *
 * Cost: ~$0.001 per photo via Gemini. 78 cities × ~5 landmarks × ~3
 * photos = ~1200 photos ≈ $1.20. Wikipedia/Commons calls are free.
 *
 * Decision context: docs/decisions.md → "landmark_index audit + reindex"
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { indexLandmarksForCities } = require('../../server/lib/landmarkPhotos');

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)=(.*)$/);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), 'true'];
}));
const PUSH = args.push === 'true';
const MAX_CITIES = args.max ? parseInt(args.max, 10) : Infinity;
const SKIP_CLASSIFY = args['skip-classify'] === 'true';
const ONLY_CITY = args.city ? String(args.city) : null;

const VALID_CATEGORIES = ['distant', 'close', 'interior', 'view_from', 'bad'];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── Pass 1: City-overview entry ──────────────────────────────────────
// Fetches the city's own Wikipedia page and uses its lead image as a
// distant/aerial fallback. Saved as "<City> (Stadt)" so it doesn't clash
// with any landmark named after the city.
async function fetchCityOverview(cityName, lang) {
  const url = `https://${lang}.wikipedia.org/w/api.php?` + new URLSearchParams({
    action: 'query', titles: cityName,
    prop: 'pageimages|coordinates|extracts|pageprops',
    piprop: 'original', pithumbsize: '1600',
    exintro: 'true', explaintext: 'true',
    coprimary: 'primary', format: 'json', formatversion: '2', origin: '*',
  });
  const res = await fetch(url, { headers: { 'User-Agent': 'MagicalStory reindex/1.0 (info@magicalstory.ch)' } });
  if (!res.ok) return null;
  const data = await res.json();
  const page = data?.query?.pages?.[0];
  if (!page || page.missing) return null;
  const photoUrl = page.original?.source;
  if (!photoUrl) return null;
  return {
    pageid: page.pageid,
    wikidata: page.pageprops?.wikibase_item || null,
    title: page.title,
    photoUrl,
    photoDescription: (page.extract || '').slice(0, 600),
    lat: page.coordinates?.[0]?.lat ?? null,
    lon: page.coordinates?.[0]?.lon ?? null,
  };
}

async function upsertCityOverview(pool, city, overview) {
  if (!overview) return false;
  // Use a synthetic "<City> (Stadt)" / "<City> (ville)" / "<City> (città)"
  // name to avoid clashing with same-named landmark.
  const synthSuffix = { de: '(Stadt)', fr: '(ville)', it: '(città)' }[city.lang] || '(Stadt)';
  const synthName = `${city.canonicalName} ${synthSuffix}`;

  const exists = await pool.query(
    `SELECT id FROM landmark_index WHERE name = $1 OR (wikidata_qid IS NOT NULL AND wikidata_qid = $2) LIMIT 1`,
    [synthName, overview.wikidata]
  );
  if (exists.rowCount > 0) {
    if (PUSH) {
      await pool.query(
        `UPDATE landmark_index
           SET photo_url = COALESCE(photo_url, $1),
               photo_description = COALESCE(photo_description, $2),
               nearest_city = COALESCE(nearest_city, $3),
               photo_type = COALESCE(photo_type, 'distant'),
               updated_at = NOW()
         WHERE id = $4`,
        [overview.photoUrl, overview.photoDescription, city.canonicalName, exists.rows[0].id]
      );
    }
    return false; // not new
  }
  if (PUSH) {
    await pool.query(
      `INSERT INTO landmark_index
        (name, wikipedia_page_id, wikidata_qid, lang, latitude, longitude,
         nearest_city, country, photo_url, photo_description, photo_source,
         photo_type, type, score, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'Switzerland',$8,$9,'wikipedia',
               'distant','City','40',NOW(),NOW())`,
      [synthName, overview.pageid, overview.wikidata, city.lang,
       overview.lat, overview.lon, city.canonicalName,
       overview.photoUrl, overview.photoDescription]
    );
  }
  return true;
}

// ─── Pass 2: Geosearch via existing pipeline ──────────────────────────
async function indexOneCity(city) {
  // Use the canonical Swiss-Spanish name as the indexer's "city" param.
  // country = 'Switzerland' prevents the IP-geocoding leakage bug.
  return await indexLandmarksForCities({
    cities: [{ city: city.canonicalName, country: 'Switzerland', region: city.canton }],
    maxLandmarks: 30,
    analyzePhotos: true,
    useMultiImageAnalysis: true,
    dryRun: !PUSH,
  });
}

// ─── Pass 3: Photo-type classification (Gemini Vision) ────────────────
async function classifyPhotoUrl(url, landmarkName) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY missing — set in .env');
  await sleep(800); // throttle (Wikimedia + Gemini both rate-limit)

  let imgRes;
  try { imgRes = await fetch(url); } catch { return { category: 'bad', reason: 'fetch failed' }; }
  if (!imgRes.ok) return { category: 'bad', reason: `HTTP ${imgRes.status}` };
  const buf = Buffer.from(await imgRes.arrayBuffer());
  const mimeType = imgRes.headers.get('content-type') || 'image/jpeg';

  const prompt = `Classify this photo of "${landmarkName}" into EXACTLY ONE of these categories. Respond with ONLY the single lowercase word.

  distant    — wide / contextual exterior shot, landmark sits in its surroundings
  close      — close-up exterior, landmark fills most of the frame
  interior   — INSIDE the landmark
  view_from  — taken FROM the landmark looking OUT
  bad        — engraving, illustration, painting, B&W historic, blurred, wrong subject

Respond with just one word.`;

  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
  let apiRes;
  try {
    apiRes = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [
          { text: prompt },
          { inlineData: { mimeType, data: buf.toString('base64') } },
        ] }],
        generationConfig: { maxOutputTokens: 20, temperature: 0.0 },
      }),
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    return { category: 'bad', reason: 'gemini timeout/fail' };
  }
  if (!apiRes.ok) return { category: 'bad', reason: `Gemini ${apiRes.status}` };
  const data = await apiRes.json();
  const raw = (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim().toLowerCase();
  const cleaned = raw.replace(/[^a-z_]/g, '');
  if (!VALID_CATEGORIES.includes(cleaned)) return { category: 'bad', reason: `unparseable: "${raw}"` };
  return { category: cleaned, reason: 'classified' };
}

async function classifyNewPhotos(pool, cityName, sinceTimestamp) {
  if (SKIP_CLASSIFY) return { classified: 0, skipped: 0 };
  const rows = await pool.query(
    `SELECT id, name,
            photo_url, photo_url_2, photo_url_3, photo_url_4, photo_url_5, photo_url_6,
            photo_type, photo_type_2, photo_type_3, photo_type_4, photo_type_5, photo_type_6
       FROM landmark_index
      WHERE nearest_city = $1 AND updated_at >= $2`,
    [cityName, sinceTimestamp]
  );
  let classified = 0, skipped = 0;
  for (const r of rows.rows) {
    for (const slot of [1, 2, 3, 4, 5, 6]) {
      const urlField = slot === 1 ? 'photo_url' : `photo_url_${slot}`;
      const typeField = slot === 1 ? 'photo_type' : `photo_type_${slot}`;
      const url = r[urlField];
      const type = r[typeField];
      if (!url) continue;
      if (type) { skipped++; continue; }
      const result = await classifyPhotoUrl(url, r.name);
      if (PUSH) {
        await pool.query(`UPDATE landmark_index SET ${typeField} = $1 WHERE id = $2`, [result.category, r.id]);
      }
      classified++;
    }
  }
  return { classified, skipped };
}

// ─── Main ─────────────────────────────────────────────────────────────
async function main() {
  const targetsPath = path.join(__dirname, 'reindex-targets.json');
  if (!fs.existsSync(targetsPath)) {
    console.error('Missing reindex-targets.json — run sync-swiss-cities.js first.');
    process.exit(1);
  }
  let { cities: targets } = JSON.parse(fs.readFileSync(targetsPath, 'utf8'));
  if (ONLY_CITY) targets = targets.filter(c => c.canonicalName === ONLY_CITY);
  targets = targets.slice(0, MAX_CITIES);

  console.log(PUSH ? '⚠️  PUSH MODE — writes to DB' : 'DRY-RUN — no writes');
  console.log(`Processing ${targets.length} cities…\n`);

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  let totalAdded = 0, totalOverview = 0, totalClassified = 0;

  for (let i = 0; i < targets.length; i++) {
    const city = targets[i];
    console.log(`\n━━━ [${i+1}/${targets.length}] ${city.canonicalName} (${city.lang}, ${city.canton}) ━━━`);
    const sinceTs = new Date(Date.now() - 60_000); // anything updated in the last minute counts as "new"

    // Step 1: city-overview
    try {
      const overview = await fetchCityOverview(city.canonicalName, city.lang);
      if (overview) {
        const added = await upsertCityOverview(pool, city, overview);
        if (added) { totalOverview++; console.log(`  ✓ city-overview added (lead photo from Wikipedia)`); }
        else console.log(`  = city-overview already present`);
      } else {
        console.log(`  ⚠ no Wikipedia page found for "${city.canonicalName}" in ${city.lang}.wikipedia.org`);
      }
    } catch (err) {
      console.log(`  ✗ city-overview failed: ${err.message}`);
    }

    // Step 2: geosearch via existing pipeline
    try {
      const result = await indexOneCity(city);
      console.log(`  ✓ geosearch indexed: total=${result.total||0}, saved=${result.saved||0}, errors=${result.errors||0}`);
      totalAdded += (result.saved || 0);
    } catch (err) {
      console.log(`  ✗ geosearch failed: ${err.message}`);
    }

    // Step 3: classify new photos
    try {
      const { classified } = await classifyNewPhotos(pool, city.canonicalName, sinceTs);
      console.log(`  ✓ classified ${classified} photo slots`);
      totalClassified += classified;
    } catch (err) {
      console.log(`  ✗ classify failed: ${err.message}`);
    }
  }

  console.log(`\n━━━ SUMMARY ━━━`);
  console.log(`  Cities processed:       ${targets.length}`);
  console.log(`  City-overview entries:  ${totalOverview}`);
  console.log(`  Landmarks added:        ${totalAdded}`);
  console.log(`  Photo slots classified: ${totalClassified}`);
  if (!PUSH) console.log(`\n  Re-run with --push to write to DB.`);

  await pool.end();
}

main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
