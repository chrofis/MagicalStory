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
 * BATCHES ARE CUT BY LANDMARK: every selected slot of one landmark lands in the
 * same batch (~25 photos, never split), so the agent sees a landmark's photos
 * side by side and can spot duplicates and "this is not the castle at all".
 *
 * The agent writes descs_<batch>.json —
 *   { "<landmarkId>_<slot>": { description, scope, season, timeOfDay, subjectMatch, discard } }
 * (pilot feedback 2026-09-01: 3-5-sentence layout prose was too long and the
 * empty-zone talk unwanted; what matters is WHAT the photo shows, when, whether
 * it is really the named subject, and duplicates across slots). The exact brief
 * is printed by --brief. merge-landmark-descriptions.js applies it.
 *
 *   node scripts/admin/prep-landmark-descriptions.js [--limit=N landmarks] [--staging] [--dry-run]
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

const BRIEF = `For each landmark, view all its photos together. For each photo output an object:
  description: 1-2 sentences, the visible features only (materials, colours, shape, distinctive
    elements). No layout-in-frame, no empty-sky/ground zones, never "the image shows".
  scope: one of whole | tower | entrance | interior | detail | distant | other - what part of
    the landmark is in the photo.
  season: snow | green | autumn | bare | unclear.   timeOfDay: day | dusk | night.
  subjectMatch: yes | uncertain | no - does the photo show the landmark the name promises.
  discard: null, or a short reason. Discard when: subjectMatch is no; the landmark is
    tiny/unrecognisable (distant blur); the image is a map, drawing, print, sign, archival B&W;
    or it duplicates/near-duplicates an earlier slot of the same landmark (keep the lowest slot,
    discard the later one, reason "duplicate of <id>_<slot>").
Write descs_<batch>.json: { "<id>_<slot>": {description, scope, season, timeOfDay, subjectMatch, discard} }
with every key of the batch.`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Group consecutive entries by landmark id, then fill batches of ~BATCH photos
// without ever splitting a landmark: the agent must see all of a landmark's
// slots together to detect duplicates. Input is already ordered by id, slot
// within the score ordering, so one landmark's rows are adjacent.
function cutBatches(entries) {
  const groups = [];
  for (const e of entries) {
    const g = groups[groups.length - 1];
    if (g && g[0].id === e.id) g.push(e); else groups.push([e]);
  }
  const batches = [];
  let cur = [];
  for (const g of groups) {
    if (cur.length && cur.length + g.length > BATCH) { batches.push(cur); cur = []; }
    cur.push(...g);
  }
  if (cur.length) batches.push(cur);
  return batches;
}

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
  // Slot 1's columns carry no suffix. --limit counts LANDMARKS, not slots, so a
  // landmark's slots are never cut in half by the limit (batches must hold all
  // of a landmark's photos for duplicate detection).
  const rows = (await pool.query(`
    WITH slots AS (
      SELECT id, name, type, coalesce(locality, municipality, nearest_city) town, story_score, s.slot, s.url
        FROM landmark_index
        CROSS JOIN LATERAL unnest(
          ARRAY[1,2,3,4,5,6],
          ARRAY[photo_url, photo_url_2, photo_url_3, photo_url_4, photo_url_5, photo_url_6],
          ARRAY[photo_description, photo_description_2, photo_description_3,
                photo_description_4, photo_description_5, photo_description_6]
        ) AS s(slot, url, description)
       WHERE s.url IS NOT NULL AND s.description IS NULL
         ${IDS ? 'AND id = ANY($1)' : ''}
    ),
    -- Best-judged places first: agents work batch by batch, and a run that
    -- stops early should have covered the landmarks stories actually use.
    picked AS (
      SELECT id, max(story_score) story_score FROM slots GROUP BY id
       ORDER BY max(story_score) DESC NULLS LAST, id${LIMIT ? ` LIMIT ${LIMIT}` : ''}
    )
    SELECT s.id, s.name, s.type, s.town, s.slot, s.url
      FROM slots s JOIN picked p USING (id)
     ORDER BY p.story_score DESC NULLS LAST, s.id, s.slot`, IDS ? [IDS] : [])).rows;

  console.log(`${ch(new Date())}  ${STAGING ? 'STAGING' : 'PROD'}: ${rows.length} photo slot(s) with a picture and no description${LIMIT ? ` (limit ${LIMIT} landmarks)` : ''}`);
  if (DRY) {
    const batches = cutBatches(rows);
    console.log(`   -> ${batches.length} batch(es), cut by landmark:`);
    batches.forEach(b => {
      const ids = [...new Set(b.map(x => x.id))];
      console.log(`   batch ${b[0].id * 10 + b[0].slot}: ${b.length} photo(s), ${ids.length} landmark(s)`);
      b.forEach(r => console.log(`      #${r.id}_${r.slot}  ${r.name} [${r.type}] ${r.town || ''}`));
    });
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
    const batches = cutBatches(manifest);
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
