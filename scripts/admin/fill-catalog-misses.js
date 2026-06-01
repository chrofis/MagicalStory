#!/usr/bin/env node
/**
 * Hand-curated rescue script for the 14 swiss-cities.json catalog cities
 * that broad-coverage + fallback both missed. Each has a known Wikipedia
 * title; we just need to point the fetcher at the right page.
 *
 * Causes the broader scripts missed each:
 *   - Disambiguation suffix needed: "Burgdorf BE", "Rheinfelden AG"
 *   - Different French Wikipedia title: "Bulle (Fribourg)"
 *   - Article exists but lead pageimage is SVG coat-of-arms (rejected by
 *     piprop=original): "Zug", "Appenzell" — work around by accepting
 *     any non-SVG image from the page
 *
 * Usage: node scripts/admin/fill-catalog-misses.js --push
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { Pool } = require('pg');

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)=(.*)$/);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), 'true'];
}));
const PUSH = args.push === 'true';

// Hand-curated mapping: catalog_city → { wikipedia_title, lang }.
// Only entries where we know broad-coverage's exact-name lookup failed.
const FIXES = [
  { catalog: 'Appenzell',     title: 'Appenzell',         lang: 'de' },  // pageimages SVG workaround
  { catalog: 'Brienz',        title: 'Brienz BE',         lang: 'de' },  // disambig from Brienz GR
  { catalog: 'Bulle',         title: 'Bulle (Fribourg)',  lang: 'fr' },
  { catalog: 'Burgdorf',      title: 'Burgdorf BE',       lang: 'de' },
  { catalog: 'Château-d\'Œx', title: 'Château-d\'Œx',     lang: 'fr' },
  { catalog: 'Disentis',      title: 'Disentis/Mustér',   lang: 'de' },  // official Wikipedia title
  { catalog: 'Gruyères',      title: 'Gruyères (FR)',     lang: 'fr' },
  { catalog: 'Guarda',        title: 'Guarda GR',         lang: 'de' },
  { catalog: 'Neuenburg',     title: 'Neuchâtel',         lang: 'fr' },  // French canonical
  { catalog: 'Rheinfelden',   title: 'Rheinfelden AG',    lang: 'de' },  // disambig from Rheinfelden DE
  { catalog: 'Romont',        title: 'Romont (FR)',       lang: 'fr' },
  { catalog: 'Soglio',        title: 'Soglio (Bregaglia)',lang: 'de' },
  { catalog: 'Vals',          title: 'Vals (Schweiz)',    lang: 'de' },
  { catalog: 'Zug',           title: 'Zug',               lang: 'de' },  // pageimages SVG workaround
];

async function fetchPageWithAnyPhoto(title, lang) {
  // Try the standard pageimages path first
  const piUrl = `https://${lang}.wikipedia.org/w/api.php?` + new URLSearchParams({
    action: 'query', titles: title,
    prop: 'pageimages|coordinates|extracts|pageprops|images',
    piprop: 'original', pithumbsize: '1600', imlimit: '20',
    exintro: 'true', explaintext: 'true', coprimary: 'primary',
    format: 'json', formatversion: '2', origin: '*',
  });
  let res;
  try { res = await fetch(piUrl, { headers: { 'User-Agent': 'MagicalStory catalog-fill/1.0 (info@magicalstory.ch)' } }); }
  catch { return null; }
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  const page = data?.query?.pages?.[0];
  if (!page || page.missing) return null;

  let photoUrl = page.original?.source;
  // If pageimages.original is missing OR is an SVG coat-of-arms, walk the
  // images array and pick the first .jpg|.jpeg|.png that's not a flag/coat.
  if (!photoUrl || /\.svg(\?|$)/i.test(photoUrl)) {
    const candidates = (page.images || [])
      .map(im => im.title || '')
      .filter(t => /\.(jpe?g|png)$/i.test(t))
      .filter(t => !/wappen|coat[\s_]?of[\s_]?arms|flag|fahne|drapeau|stemma|logo/i.test(t));
    if (candidates.length === 0) return null;
    // Fetch URL for the first viable image via imageinfo
    const imgTitle = candidates[0];
    const iiRes = await fetch(`https://${lang}.wikipedia.org/w/api.php?` + new URLSearchParams({
      action: 'query', titles: imgTitle,
      prop: 'imageinfo', iiprop: 'url',
      format: 'json', formatversion: '2', origin: '*',
    }), { headers: { 'User-Agent': 'MagicalStory catalog-fill/1.0 (info@magicalstory.ch)' } });
    const iiData = await iiRes.json().catch(() => null);
    photoUrl = iiData?.query?.pages?.[0]?.imageinfo?.[0]?.url;
    if (!photoUrl) return null;
  }
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

async function main() {
  console.log(PUSH ? '⚠️  PUSH MODE — writes to DB' : 'DRY-RUN — no writes');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

  let added = 0, missing = 0;
  for (const fx of FIXES) {
    process.stdout.write(`  ${fx.catalog.padEnd(20)} → "${fx.title}"  `);
    const result = await fetchPageWithAnyPhoto(fx.title, fx.lang);
    if (!result) {
      console.log('✗ no photo found');
      missing++;
      continue;
    }
    console.log(`✓ photo: ${result.photoUrl.split('/').pop().slice(0, 50)}`);
    if (!PUSH) continue;
    const suffix = { de: '(Stadt)', fr: '(ville)', it: '(città)' }[fx.lang] || '(Stadt)';
    const synthName = `${fx.catalog} ${suffix}`;
    const exists = await pool.query(
      `SELECT id FROM landmark_index WHERE name = $1 OR (wikidata_qid IS NOT NULL AND wikidata_qid = $2) LIMIT 1`,
      [synthName, result.wikidata]
    );
    if (exists.rowCount > 0) {
      console.log('    (already exists, skipping insert)');
      continue;
    }
    await pool.query(
      `INSERT INTO landmark_index
        (name, wikipedia_page_id, wikidata_qid, lang, latitude, longitude,
         nearest_city, country, photo_url, photo_description, photo_source,
         photo_type, type, score, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'Switzerland',$8,$9,'wikipedia',
               'distant','City','40',NOW(),NOW())`,
      [synthName, result.pageid, result.wikidata, fx.lang,
       result.lat, result.lon, fx.catalog,
       result.photoUrl, result.photoDescription]
    );
    added++;
  }

  console.log(`\n━━━ SUMMARY ━━━`);
  console.log(`  ${PUSH ? 'Added' : 'Would add'}: ${added}`);
  console.log(`  Still missing: ${missing}`);
  await pool.end();
}

main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
