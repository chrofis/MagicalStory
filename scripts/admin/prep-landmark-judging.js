#!/usr/bin/env node
/**
 * Prepare landmark photos for VISUAL judging by Claude agents ($0 — no model API).
 *
 * The agents read the downloaded images with the Read tool and score them. That
 * is the same pattern the 2026-06 A→Z photo gap-fill used, and it is free: the
 * only paid alternative is Haiku, and the built-in `findBestLandmarkImage` path
 * routes every candidate through Gemini.
 *
 * THE UNIT IS AN IMAGE, NOT A LANDMARK. An earlier version prepped only the
 * top-ranked landmark per town, and only its lead photo. Both limits were
 * wrong, for the same reason: "top" was decided by fame_pageviews, the proxy
 * that ranks a building site above a castle, so the castle was never looked at.
 * You cannot know which candidate is best until you have seen them. And a fine
 * landmark whose LEAD image is poor (Lenzburg, 35 — a close crop of bare wall)
 * was thrown away while four usable photos of it sat unjudged in slots 2..6.
 *
 * Files are <out>/<landmarkId>_<slot>.jpg — never a loop index. The row set
 * shrinks as images get judged, so on a restart index 0 is a DIFFERENT image
 * and an index-named file would be scored as somewhere else entirely.
 *
 *   node scripts/admin/prep-landmark-judging.js [--limit=N] [--out=DIR] [--gaps] [--town=Baden]
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const { Pool } = require('pg');
const fs = require('fs');

const args = process.argv.slice(2);
const limitArg = args.find(a => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;
const outArg = args.find(a => a.startsWith('--out='));
const OUT = outArg ? outArg.split('=')[1]
  : path.join(process.env.TEMP || '/tmp', 'lm_judge');
const BATCH = 25;
// Wikimedia throttles sustained thumbnail pulls — a 120ms run lost 862 of 1100
// downloads on 2026-08-27. Slower finishes sooner because failures are retried
// on the next pass anyway.
const delayArg = args.find(a => a.startsWith('--delay='));
const DELAY = delayArg ? parseInt(delayArg.split('=')[1], 10) : 700;

// An EVENT or an ORGANISATION can never be a scene setting — a championship, a
// federation, a company. City/Village rows stay: they are the deliberate
// `<Town> (Stadt)` overview aerials for towns with nothing iconic of their own.
const NEV = `coalesce(type,'x') NOT IN ('Event','Organisation','Other')`;

// Mirrors MIN_USABLE_PHOTO in server/lib/landmarkPhotos.js — the cutoff below
// which a picture is not printable in a child's book. Kept in step so the queue
// treats a town as covered on exactly the terms production serves it.
const MIN_USABLE_PHOTO = 40;

// The town a row is actually in — the narrowest name known, so a merger does not
// move a village: Turgi stays Turgi inside Baden.
//
// This is the QUEUE's notion of a town, deliberately narrower than the live
// lookup's. Serving matches either name (TOWN_MATCHES_SQL in
// server/lib/landmarkPhotos.js), so a village can also be covered by its
// commune's landmarks; counting it that way here would mark villages "done"
// while they still have nothing of their own to show. --gaps should keep
// pushing until the village itself has a picture.
const TOWN = `coalesce(locality, municipality, nearest_city)`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Ask Commons for a width-limited rendering instead of the stored original.
 *
 * photo_url points at the FULL-SIZE file, and some are enormous: the ETH aerial
 * behind landmark 13593 is a 137 MB TIFF, which blows the download timeout and
 * sharp's decode — the row then looks "unfetchable" and its town keeps showing
 * as uncovered. Special:FilePath?width= serves a JPEG rendering of any Commons
 * file, so a huge master costs the same as a small one. Everything is judged at
 * 480px anyway, so nothing is lost.
 */
function thumbUrl(url, width = 900) {
  const m = /\/wikipedia\/commons\/(?:thumb\/)?[0-9a-f]\/[0-9a-f]{2}\/([^/?]+)/.exec(url || '');
  if (!m) return url;
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${m[1]}?width=${width}`;
}

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  fs.mkdirSync(OUT, { recursive: true });

  // --town=Baden inspects one place end to end; --top100 covers the SEO city
  // list in server/data/swiss-cities.json, which is the set that actually has
  // pages built for it. Diacritics are folded on both sides so Zurich finds
  // Zürich. Every alias in the file is used, not just the German name: the list
  // calls Fribourg "Freiburg" and Biel/Bienne "Biel", and matching on one
  // spelling alone finds nothing for them.
  const townArg = args.find(a => a.startsWith('--town='));
  let townNames = null;
  if (townArg) townNames = [townArg.split('=').slice(1).join('=')];
  if (args.includes('--top100')) {
    const { cities } = require(path.resolve(__dirname, '..', '..', 'server', 'data', 'swiss-cities.json'));
    townNames = [...new Set(cities.flatMap(c => Object.values(c.name || {})))];
  }
  const townFilter = townNames
    ? `AND LOWER(translate(${TOWN}, 'üùäàâöôéèêëîïçñßœ', 'uuaaaooeeeeiicnso'))
       = ANY(ARRAY[${townNames.map(n => `LOWER(translate('${String(n).replace(/'/g, "''")}', 'üùäàâöôéèêëîïçñßœ', 'uuaaaooeeeeiicnso'))`).join(',')}])`
    : '';

  // --gaps: only towns with no usable landmark yet. Without it the queue is
  // ordered by id and a town that still has nothing waits behind thousands of
  // extra photos of towns already covered.
  const gapFilter = args.includes('--gaps') ? `AND ${TOWN} IN (
      SELECT ${TOWN} FROM landmark_index l2
       WHERE country ILIKE '%switzerland%' AND ${NEV}
       GROUP BY ${TOWN}
      HAVING count(*) FILTER (WHERE l2.story_score >= ${MIN_USABLE_PHOTO}) = 0)` : '';

  // One row per (landmark, photo slot). unnest keeps the six columns as six
  // candidates without six near-identical queries.
  const rows = (await pool.query(`
    WITH imgs AS (
      SELECT id, name, type, ${TOWN} town, wikipedia_extract,
             s.slot, s.url
        FROM landmark_index
        CROSS JOIN LATERAL unnest(
          ARRAY[1,2,3,4,5,6],
          ARRAY[photo_url, photo_url_2, photo_url_3, photo_url_4, photo_url_5, photo_url_6]
        ) AS s(slot, url)
       WHERE country ILIKE '%switzerland%' AND ${NEV} AND s.url IS NOT NULL ${townFilter} ${gapFilter})
    SELECT i.* FROM imgs i
      LEFT JOIN landmark_photo_scores ps ON ps.landmark_id = i.id AND ps.slot = i.slot
     WHERE ps.landmark_id IS NULL
     ORDER BY i.slot, i.id${LIMIT ? ` LIMIT ${LIMIT}` : ''}`)).rows;

  console.log(`${rows.length} unjudged image(s) → ${OUT}`);

  const sharp = require('sharp');
  const manifest = [];
  let ok = 0;
  for (const [i, l] of rows.entries()) {
    const file = `${l.id}_${l.slot}.jpg`;
    const dest = path.join(OUT, file);
    const entry = {
      id: l.id, slot: l.slot, file, name: l.name, type: l.type, city: l.town,
      extract: (l.wikipedia_extract || '').slice(0, 180),
    };
    // Resume: a prep that died or was throttled must not re-download what it has.
    if (fs.existsSync(dest) && fs.statSync(dest).size > 2000) {
      manifest.push(entry);
      ok++;
      if (manifest.length % BATCH === 0) writeManifest();
      continue;
    }
    try {
      const r = await fetch(thumbUrl(l.url), {
        headers: { 'User-Agent': 'MagicalStory/1.0 (https://magicalstory.ch) landmark-QA' },
        signal: AbortSignal.timeout(25000),
      });
      if (!r.ok) throw new Error(String(r.status));
      const buf = Buffer.from(await r.arrayBuffer());
      await sharp(buf).resize(480, 480, { fit: 'inside' }).jpeg({ quality: 70 }).toFile(dest);
      manifest.push(entry);
      ok++;
    } catch (e) {
      // An image we cannot download is one an agent cannot judge — skip it
      // rather than hand the agent a missing file and get an invented score.
    }
    // Write the manifest AS WE GO. Wikimedia throttles a long run, so a prep can
    // crawl for many minutes; writing only at the end means the file→id mapping
    // never lands and no agent can start on what already downloaded.
    if (manifest.length && manifest.length % BATCH === 0) writeManifest();
    if ((i + 1) % 100 === 0) console.log(`  ${ok}/${i + 1} downloaded`);
    await sleep(DELAY);
  }

  writeManifest();

  function writeManifest() {
    fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1));
    const batches = [];
    for (let i = 0; i < manifest.length; i += BATCH) batches.push(manifest.slice(i, i + BATCH));
    // Batch id is the first image's landmark id + slot, never the loop index:
    // prep restarts with a shrunken set, so index-numbered batches restart at 0
    // and a picks_0.json left from an earlier run makes a brand-new batch look
    // already judged. Keying on content means a batch keeps its number only
    // while it holds the same images.
    fs.writeFileSync(path.join(OUT, 'batches.json'), JSON.stringify(batches.map(b => ({
      batch: b[0].id * 10 + b[0].slot, dir: OUT,
      items: b.map(x => ({ id: x.id, slot: x.slot, file: x.file, name: x.name, type: x.type, city: x.city })),
    })), null, 1));
  }

  console.log(`\n✅ ${ok} thumbnails, ${Math.ceil(manifest.length / BATCH)} batches of ${BATCH} in ${OUT}`);
  await pool.end();
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
