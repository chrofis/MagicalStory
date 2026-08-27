#!/usr/bin/env node
/**
 * Prepare landmark photos for VISUAL judging by Claude agents ($0 — no model API).
 *
 * The agents read the downloaded images with the Read tool and score how good
 * each place is as a setting in a young child's picture book. That is the same
 * pattern the 2026-06 A→Z photo gap-fill used, and it is free: the only paid
 * alternative is Haiku, and the built-in `findBestLandmarkImage` path routes
 * every candidate through Gemini.
 *
 * Only rows that can ACTUALLY REACH A STORY are prepped — the top few per town
 * under the live ranking. Judging the other ~4,500 rows would be looking at
 * pictures no reader will ever see.
 *
 * Writes <out>/NN.jpg thumbnails + manifest.json + batches.json.
 *
 *   node scripts/admin/prep-landmark-judging.js [--top=3] [--limit=N] [--out=DIR]
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const { Pool } = require('pg');
const fs = require('fs');

const args = process.argv.slice(2);
const topArg = args.find(a => a.startsWith('--top='));
const TOP = topArg ? parseInt(topArg.split('=')[1], 10) : 3;
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

const CLASS = `(CASE WHEN coalesce(type,'x') IN ('City','Village','Event','Organisation','Other') THEN 0
  WHEN coalesce(type,'x') IN ('Cathedral','Church','Abbey','Monastery','Castle','Palace','Museum','Bridge','Tower','Fountain','Square','Theatre','Park','Monument','Library') THEN 2 ELSE 1 END)`;
const SAME = `(municipality IS NULL OR LOWER(translate(municipality,'üùäàâöôéèêëîïçñß','uuaaaooeeeeiicns'))
  = LOWER(translate(nearest_city,'üùäàâöôéèêëîïçñß','uuaaaooeeeeiicns')))`;
const NEV = `coalesce(type,'x') NOT IN ('Event','Organisation','Other')`;
const RANK = `(photo_url IS NOT NULL) DESC, ${CLASS} DESC, fame_pageviews DESC NULLS LAST, fame_sitelinks DESC NULLS LAST, score DESC`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  fs.mkdirSync(OUT, { recursive: true });

  const rows = (await pool.query(`
    WITH ranked AS (
      SELECT id, name, type, nearest_city, photo_url, wikipedia_extract,
             row_number() OVER (PARTITION BY nearest_city ORDER BY ${RANK}) rn
        FROM landmark_index
       WHERE country ILIKE '%switzerland%' AND ${SAME} AND ${NEV}
         AND photo_url IS NOT NULL AND story_score IS NULL)
    SELECT id, name, type, nearest_city, photo_url, wikipedia_extract
      FROM ranked WHERE rn <= $1 ORDER BY rn, id${LIMIT ? ` LIMIT ${LIMIT}` : ''}`, [TOP])).rows;

  console.log(`${rows.length} reachable, photographed, unjudged landmark(s) → ${OUT}`);

  const sharp = require('sharp');
  const manifest = [];
  let ok = 0;
  for (const [i, l] of rows.entries()) {
    // Filename is the LANDMARK ID, never the loop index. The row set shrinks as
    // rows get judged, so on a restart index 0 is a DIFFERENT landmark — an
    // index-named file would be reused for the wrong one and the agent would
    // score a picture of somewhere else.
    const file = `${l.id}.jpg`;
    // Resume: a prep that died or was throttled must not re-download what it has.
    const dest = path.join(OUT, file);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 2000) {
      manifest.push({ id: l.id, file, name: l.name, type: l.type, city: l.nearest_city,
        extract: (l.wikipedia_extract || '').slice(0, 180) });
      ok++;
      if (manifest.length % BATCH === 0) writeManifest();
      continue;
    }
    try {
      const r = await fetch(l.photo_url, {
        headers: { 'User-Agent': 'MagicalStory/1.0 (https://magicalstory.ch) landmark-QA' },
        signal: AbortSignal.timeout(25000),
      });
      if (!r.ok) throw new Error(String(r.status));
      const buf = Buffer.from(await r.arrayBuffer());
      await sharp(buf).resize(480, 480, { fit: 'inside' }).jpeg({ quality: 70 }).toFile(path.join(OUT, file));
      manifest.push({
        id: l.id, file, name: l.name, type: l.type, city: l.nearest_city,
        extract: (l.wikipedia_extract || '').slice(0, 180),
      });
      ok++;
    } catch (e) {
      // A thumbnail we cannot download is one an agent cannot judge — skip it
      // rather than hand the agent a missing file and get an invented score.
    }
    // Write the manifest AS WE GO. Wikimedia throttles a long run, so a prep
    // can crawl or stall for many minutes; writing only at the end means the
    // file→id mapping never lands and no agent can start on the images that
    // already downloaded. Flushing per batch lets judging begin immediately and
    // makes an interrupted prep still useful.
    if (manifest.length && manifest.length % BATCH === 0) writeManifest();
    if ((i + 1) % 100 === 0) { console.log(`  ${ok}/${i + 1} downloaded`); }
    await sleep(DELAY);
  }

  writeManifest();

  function writeManifest() {
    fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1));
    const batches = [];
    for (let i = 0; i < manifest.length; i += BATCH) batches.push(manifest.slice(i, i + BATCH));
    fs.writeFileSync(path.join(OUT, 'batches.json'), JSON.stringify(batches.map((b, i) => ({
      batch: i, dir: OUT, items: b.map(x => ({ id: x.id, file: x.file, name: x.name, type: x.type, city: x.city })),
    })), null, 1));
  }

  console.log(`\n✅ ${ok} thumbnails, ${Math.ceil(manifest.length / BATCH)} batches of ${BATCH} in ${OUT}`);
  await pool.end();
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
