#!/usr/bin/env node
/**
 * Prepare landmark photos that have NO description for describing by Claude
 * agents ($0 — no model API).
 *
 * WHY: `fetch-landmark-photos-free.js` (photo_source 'wikipedia-lead') fills
 * photo_url[_2..6] but never photo_description[_2..6] — ~10,000 slots on prod
 * hold a picture the illustrator is handed with no words about it. The paid
 * path (`analyzeLandmarkPhoto`, Gemini) would cost a run per slot; the judging
 * pipeline already proved agents can look at a thumbnail with the Read tool
 * for free, so this mirrors prep-landmark-judging.js / merge-landmark-judgments.js.
 *
 * THE UNIT IS A SLOT, NOT A LANDMARK: slot 2 can be described while slot 1
 * already is. Files are <out>/<landmarkId>_<slot>.jpg — never a loop index, so
 * a restart with a shrunken set cannot mislabel an image.
 *
 * The agent writes descs_<batch>.json — `{ "<landmarkId>_<slot>": "text" }` —
 * in the SAME shape analyzeLandmarkPhoto produces (3-5 sentences: appearance
 * + layout in frame, which zones are empty sky / ground / open square). The
 * exact brief is printed by --brief. merge-landmark-descriptions.js applies it.
 *
 *   node scripts/admin/prep-landmark-descriptions.js [--limit=N] [--staging] [--dry-run]
 *        [--ids=a,b,c] [--out=DIR] [--delay=MS] [--brief]
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const { Pool } = require('pg');
const fs = require('fs');
const { ch } = require('../lib/chTime');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const STAGING = args.includes('--staging');
const flag = name => { const a = args.find(x => x.startsWith(`--${name}=`)); return a ? a.split('=').slice(1).join('=') : null; };
const LIMIT = flag('limit') ? parseInt(flag('limit'), 10) : null;
const IDS = flag('ids') ? flag('ids').split(',').map(s => parseInt(s, 10)).filter(Number.isFinite) : null;
const OUT = flag('out') || path.join(process.env.TEMP || '/tmp', 'lm_describe');
const DELAY = flag('delay') ? parseInt(flag('delay'), 10) : 700;
const BATCH = 25;

const BRIEF = `For each image in the batch, write a description of the landmark photo for use in
children's book illustration, 3-5 sentences, covering BOTH of:
1. APPEARANCE - main architectural/natural features, colours, materials, textures, distinctive recognizable elements.
2. LAYOUT IN FRAME - where the landmark sits and where the open space is, in rough zones
   ("tower fills the right 60% of the frame", "open sky fills the upper third"). Name which
   thirds/halves/corners are EMPTY GROUND, EMPTY SKY or OPEN SQUARE - downstream prompts use
   this to place props without mounting them on the landmark.
Be specific and visual. Do NOT mention the photo itself ("the image shows").
Write descs_<batch>.json: { "<landmarkId>_<slot>": "description" } with every key of the batch.`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Width-limited Commons rendering — photo_url can be a 100 MB master (see
// prep-landmark-judging.js thumbUrl).
function thumbUrl(url, width = 900) {
  const m = /\/wikipedia\/commons\/(?:thumb\/)?[0-9a-f]\/[0-9a-f]{2}\/([^/?]+)/.exec(url || '');
  if (!m) return url;
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${m[1]}?width=${width}`;
}

(async () => {
  if (args.includes('--brief')) { console.log(BRIEF); return; }
  const url = STAGING ? process.env.STAGING_DATABASE_URL : process.env.DATABASE_URL;
  if (!url) throw new Error(`${STAGING ? 'STAGING_DATABASE_URL' : 'DATABASE_URL'} is not set`);
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });

  // One row per (landmark, slot) that has a picture and no words for it.
  // Slot 1's columns carry no suffix.
  const rows = (await pool.query(`
    SELECT id, name, type, coalesce(locality, municipality, nearest_city) town, s.slot, s.url
      FROM landmark_index
      CROSS JOIN LATERAL unnest(
        ARRAY[1,2,3,4,5,6],
        ARRAY[photo_url, photo_url_2, photo_url_3, photo_url_4, photo_url_5, photo_url_6],
        ARRAY[photo_description, photo_description_2, photo_description_3,
              photo_description_4, photo_description_5, photo_description_6]
      ) AS s(slot, url, description)
     WHERE s.url IS NOT NULL AND s.description IS NULL
       ${IDS ? 'AND id = ANY($1)' : ''}
     -- Best-judged places first: agents work batch by batch, and a run that
     -- stops early should have covered the landmarks stories actually use.
     ORDER BY story_score DESC NULLS LAST, id, s.slot${LIMIT ? ` LIMIT ${LIMIT}` : ''}`, IDS ? [IDS] : [])).rows;

  console.log(`${ch(new Date())}  ${STAGING ? 'STAGING' : 'PROD'}: ${rows.length} photo slot(s) with a picture and no description${LIMIT ? ` (limit ${LIMIT})` : ''}`);
  if (DRY) {
    rows.slice(0, 20).forEach(r => console.log(`   #${r.id}_${r.slot}  ${r.name} [${r.type}] ${r.town || ''}  ${r.url}`));
    await pool.end();
    return;
  }

  fs.mkdirSync(OUT, { recursive: true });
  const sharp = require('sharp');
  const manifest = [];
  let ok = 0, failed = 0;
  for (const [i, l] of rows.entries()) {
    const file = `${l.id}_${l.slot}.jpg`;
    const dest = path.join(OUT, file);
    const entry = { id: l.id, slot: l.slot, file, name: l.name, type: l.type, city: l.town };
    if (fs.existsSync(dest) && fs.statSync(dest).size > 2000) {   // resume
      manifest.push(entry); ok++;
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
      await sharp(buf).resize(640, 640, { fit: 'inside' }).jpeg({ quality: 75 }).toFile(dest);
      manifest.push(entry); ok++;
    } catch (e) {
      // An image that cannot be downloaded cannot be described; it stays NULL
      // and is selected again next run.
      failed++;
      console.log(`  #${l.id}_${l.slot} ${l.name}: download failed (${e.message})`);
    }
    if (manifest.length && manifest.length % BATCH === 0) writeManifest();
    if ((i + 1) % 100 === 0) console.log(`  ${ok}/${i + 1} downloaded`);
    await sleep(DELAY);
  }
  writeManifest();

  function writeManifest() {
    fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1));
    const batches = [];
    for (let i = 0; i < manifest.length; i += BATCH) batches.push(manifest.slice(i, i + BATCH));
    // Batch id keyed on content (first image's id+slot), never the loop index.
    fs.writeFileSync(path.join(OUT, 'batches.json'), JSON.stringify(batches.map(b => ({
      batch: b[0].id * 10 + b[0].slot, dir: OUT, brief: BRIEF,
      items: b.map(x => ({ id: x.id, slot: x.slot, file: x.file, name: x.name, type: x.type, city: x.city })),
    })), null, 1));
  }

  console.log(`\n${ch(new Date())}  ${ok} thumbnail(s) in ${Math.ceil(manifest.length / BATCH)} batch(es) of ${BATCH} -> ${OUT}; ${failed} download failure(s)`);
  console.log('Next: agents describe each batch (see --brief), then node scripts/admin/merge-landmark-descriptions.js --dir=' + OUT + (STAGING ? ' --staging' : ''));
  await pool.end();
  if (failed) process.exit(1);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
