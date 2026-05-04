#!/usr/bin/env node
/**
 * Replace all wilhelm-tell rows in historical_locations with our curated
 * watercolor finals + create historical_objects table and seed it with
 * the hat (Gessler's velvet hat) and the Armbrust (crossbow).
 *
 * Run:
 *   node scripts/admin/upload-tell-finals.js               # preview only
 *   node scripts/admin/upload-tell-finals.js --apply       # write to DB
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const DRY_RUN = !process.argv.includes('--apply');
const CURATED_DIR = path.resolve(__dirname, '..', '..', 'tests', 'tell-curated');
const EVENT_ID = 'wilhelm-tell';

// File → row payload. Descriptions written from the image prompts.
const LOCATIONS = [
  {
    folder: 'altdorf-panorama',
    file: 'ai-09-watercolor-v8-anchor-church-mountains-from-photo.jpg',
    location_name: 'Altdorf Panorama',
    location_query: 'Altdorf, Uri, Switzerland — panoramic view',
    location_type: 'Town',
    aliases: ['Altdorf UR', 'Altdorf canton Uri'],
    description: 'Watercolor panorama of Altdorf in canton Uri, based on a real 1900 photograph. The medieval village with its Pfarrkirche St. Martin bell tower nestles below the snow-capped Uri Alps. A wide green alpine meadow opens in the foreground, leaving empty space for characters.',
  },
  {
    folder: 'marktplatz-altdorf',
    file: 'ai-04-composed-v5-pole-somewhat-shorter.jpg',
    location_name: 'Marktplatz Altdorf',
    location_query: 'Marktplatz Altdorf — medieval town square',
    location_type: 'Square',
    aliases: ['Altdorf marketplace', 'Altdorf town square'],
    description: 'The medieval marketplace of Altdorf. A wooden pole stands in the centre of the cobblestoned square, topped with a feathered velvet hat — the hat of authority placed there by the Vogt Gessler. Pfarrkirche St. Martin and the Bristen mountain rise in the background. Soft warm afternoon light, watercolor style.',
  },
  {
    folder: 'apple-shot-altdorf',
    file: 'ai-13-composition-v10-crowd-market-chaotic.jpg',
    location_name: 'Apple Shot Scene (Altdorf)',
    location_query: 'Apple shot scene, Altdorf marketplace',
    location_type: 'Scene',
    aliases: ['Apfelschuss', 'apple-shot scene'],
    description: 'The apple-shot scene at Altdorf. A small child stands with his back against a tall lime tree in the right background, an apple balanced on his head. A scattered, market-like crowd of medieval Swiss observers fills the left side of the square; the foreground cobblestones and the area around the tree are empty, waiting for the archer.',
  },
  {
    folder: 'lake-uri-storm-boat',
    file: 'ai-02-watercolor-v2-stormier-boat-clearly-left.jpg',
    location_name: 'Lake Uri storm crossing',
    location_query: 'Lake Uri (Urnersee) in storm',
    location_type: 'Lake',
    aliases: ['Urnersee', 'Vierwaldstättersee', 'Lake Lucerne (Uri arm)'],
    description: 'A medieval wooden rowboat crosses Lake Uri in a heavy alpine storm. The boat points and moves to the left, cutting across whitecapped waves under dark stormy clouds with diagonal rain. Steep alpine cliffs rise on the far shore.',
  },
  {
    folder: 'tellsplatte-boat-jump',
    file: 'ai-21-watercolor-v19-stone-lower-stronger-waves.jpg',
    location_name: 'Tellsplatte (boat jump)',
    location_query: 'Tellsplatte rock, Lake Uri',
    location_type: 'Landmark',
    aliases: ['Tells Platte', 'Tell\'s Leap'],
    description: 'The Tellsplatte rock projects out from the alpine cliff on the left side of Lake Uri. A weather-worn boulder with a small flat shelf tilting toward the water sits low above the choppy storm-tossed lake; a wooden rowboat hovers beside it, near enough that a person could leap from boat to rock. Heavy rain and dark stormy sky.',
  },
  {
    folder: 'hohle-gasse-kuessnacht',
    file: 'ai-15-watercolor-v13-rider-same-size-further-back.jpg',
    location_name: 'Hohle Gasse Küssnacht',
    location_query: 'Hohle Gasse near Küssnacht — sunken forest road',
    location_type: 'Historic',
    aliases: ['Hohle Gasse', 'Sunken road of Küssnacht'],
    description: 'The Hohle Gasse near Küssnacht — a deep V-shape forest ravine running diagonally through the canvas. Mossy banks rise steeply on both sides over a meandering animal trail. A cluster of dense bushes in the foreground forms a natural hiding spot. At the far end of the trail, a small horse and rider descend toward the viewer.',
  },
  {
    folder: 'tellshaus-buerglen',
    file: 'ai-01-watercolor.jpg',
    location_name: 'Tellshaus Bürglen',
    location_query: 'Tellshaus Bürglen — Wilhelm Tell\'s house',
    location_type: 'House',
    aliases: ['Tell\'s house', 'Bürglen Tell house'],
    description: 'The Tellshaus in Bürglen, traditional birthplace of Wilhelm Tell. A medieval Swiss timber house in an alpine village setting, watercolor illustration.',
  },
];

const OBJECTS = [
  {
    folder: 'story-asset-hat',
    file: 'ai-01-watercolor-v1-hat-isolated.jpg',
    object_name: 'Gessler\'s feathered hat',
    object_type: 'symbol',
    aliases: ['Gessler hat', 'Vogt\'s hat', 'feathered velvet hat on the pole'],
    description: 'A wide-brimmed velvet hat with a long ostrich plume — the hat of authority placed on a pole in Altdorf marketplace by the Vogt (governor) Gessler, who demanded that every passer-by bow before it.',
  },
  {
    folder: 'story-asset-armbrust',
    file: 'ai-11-watercolor-v11-pointing-top-right.jpg',
    object_name: 'Armbrust (medieval crossbow)',
    object_type: 'weapon',
    aliases: ['Wilhelm Tell\'s crossbow', 'Armbrust', 'medieval crossbow'],
    description: 'A heavy battle-worn medieval Armbrust with a thick wooden stock, steel prod, and a single taut bowstring (Bogensehne). The weapon used by Wilhelm Tell, including for the famous shot of an apple from his son\'s head.',
  },
];

function encodeFile(p) {
  const buf = fs.readFileSync(p);
  return { bytes: buf.length, b64: buf.toString('base64'), mime: 'image/jpeg' };
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL env var required');
    process.exit(1);
  }
  console.log(DRY_RUN ? '🟡 DRY RUN — no writes will be made (rerun with --apply to commit)' : '🔴 APPLY MODE — will write to PROD');
  console.log('Target host:', (process.env.DATABASE_URL.match(/@([^/:]+)/) || [])[1]);

  // Resolve and pre-load all files
  const locRows = LOCATIONS.map(l => {
    const p = path.join(CURATED_DIR, l.folder, l.file);
    if (!fs.existsSync(p)) throw new Error(`Missing file: ${p}`);
    return { ...l, ...encodeFile(p), photoUrl: `magicalstory://tell-curated/${l.folder}/${l.file}` };
  });
  const objRows = OBJECTS.map(o => {
    const p = path.join(CURATED_DIR, o.folder, o.file);
    if (!fs.existsSync(p)) throw new Error(`Missing file: ${p}`);
    return { ...o, ...encodeFile(p), photoUrl: `magicalstory://tell-curated/${o.folder}/${o.file}` };
  });

  console.log('\nLocations to insert:');
  locRows.forEach(r => console.log(`  ${r.location_name} (${r.location_type}) — ${(r.bytes/1024).toFixed(0)}KB`));
  console.log('\nObjects to insert:');
  objRows.forEach(r => console.log(`  ${r.object_name} (${r.object_type}) — ${(r.bytes/1024).toFixed(0)}KB`));

  if (DRY_RUN) {
    console.log('\n(dry run — exiting before any DB write)');
    return;
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('rlwy.net') ? { rejectUnauthorized: false } : false,
  });

  // ─── 1. Delete all existing wilhelm-tell rows ───
  const before = await pool.query('SELECT COUNT(*)::int AS c FROM historical_locations WHERE event_id = $1', [EVENT_ID]);
  console.log(`\nDeleting ${before.rows[0].c} existing historical_locations rows for ${EVENT_ID}...`);
  await pool.query('DELETE FROM historical_locations WHERE event_id = $1', [EVENT_ID]);

  // ─── 2. Insert curated locations ───
  for (const r of locRows) {
    await pool.query(
      `INSERT INTO historical_locations
         (event_id, location_name, location_query, location_type, aliases,
          photo_url, photo_data, photo_attribution, photo_description, photo_score, photo_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        EVENT_ID, r.location_name, r.location_query, r.location_type, JSON.stringify(r.aliases),
        r.photoUrl, r.b64, 'MagicalStory curated watercolor', r.description, 10, 'hand-curated',
      ]
    );
    console.log(`  ✅ ${r.location_name}`);
  }

  // ─── 3. Create historical_objects table if missing ───
  console.log('\nEnsuring historical_objects table exists...');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS historical_objects (
      id SERIAL PRIMARY KEY,
      event_id VARCHAR(100) NOT NULL,
      object_name VARCHAR(255) NOT NULL,
      object_type VARCHAR(100),
      aliases JSONB DEFAULT '[]',
      photo_url TEXT NOT NULL DEFAULT '',
      photo_data TEXT,
      photo_attribution TEXT,
      photo_description TEXT,
      photo_score INT,
      photo_reason TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(event_id, object_name)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_historical_objects_event ON historical_objects(event_id)`);

  // ─── 4. Replace wilhelm-tell objects ───
  await pool.query('DELETE FROM historical_objects WHERE event_id = $1', [EVENT_ID]);
  for (const r of objRows) {
    await pool.query(
      `INSERT INTO historical_objects
         (event_id, object_name, object_type, aliases, photo_url, photo_data,
          photo_attribution, photo_description, photo_score, photo_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        EVENT_ID, r.object_name, r.object_type, JSON.stringify(r.aliases),
        r.photoUrl, r.b64, 'MagicalStory curated watercolor', r.description, 10, 'hand-curated',
      ]
    );
    console.log(`  ✅ ${r.object_name}`);
  }

  // ─── 5. Verify ───
  const locCount = await pool.query('SELECT location_name, length(photo_data) AS bytes FROM historical_locations WHERE event_id = $1 ORDER BY location_name', [EVENT_ID]);
  const objCount = await pool.query('SELECT object_name, length(photo_data) AS bytes FROM historical_objects WHERE event_id = $1 ORDER BY object_name', [EVENT_ID]);
  console.log(`\n=== Verification ===`);
  console.log(`historical_locations / ${EVENT_ID}: ${locCount.rowCount} rows`);
  locCount.rows.forEach(r => console.log(`  ${r.location_name} (${r.bytes} chars base64)`));
  console.log(`historical_objects / ${EVENT_ID}: ${objCount.rowCount} rows`);
  objCount.rows.forEach(r => console.log(`  ${r.object_name} (${r.bytes} chars base64)`));

  await pool.end();
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
