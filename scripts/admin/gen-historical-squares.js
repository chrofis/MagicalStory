#!/usr/bin/env node
/**
 * Generate SQUARE (1:1) versions of the historical landmark images.
 *
 * The historical_locations databank stores A4-portrait Wikimedia landmark
 * photos (~880x1168). When the empty-scene step stylizes an A4 landmark into a
 * square page, the portrait content gets centered with grey side margins (the
 * letterbox bars seen on square stories). This script produces a square variant
 * of every landmark by Grok magenta-extending the existing A4 photo outward —
 * the landmark stays pixel-faithful in the centre, the sides are extended to
 * fill 1:1. No re-fetch; uses the stored input pictures.
 *
 * Output: NEW files in drafts/historical-squares/<event_id>__<basename>.jpg
 * (does NOT overwrite the A4 originals, does NOT upload to R2, does NOT touch
 * the DB). Review the drafts, then a follow-up step uploads the approved set to
 * R2 (/landmarks/historical/square/) + sets historical_locations.photo_url_square.
 *
 * Usage:
 *   node scripts/admin/gen-historical-squares.js [--event=wilhelm-tell] [--limit=N] [--force]
 *   --event   only this event_id (default: all)
 *   --limit   stop after N images (default: all)
 *   --force   regenerate even if the draft file already exists (default: skip existing)
 */
'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { editWithGrok, GROK_MODELS } = require('../../server/lib/grok');
const r2 = require('../../server/lib/r2');

function arg(name, dflt = null) {
  const m = process.argv.find(a => a.startsWith(`--${name}=`));
  return m ? m.split('=')[1] : dflt;
}
const flag = name => process.argv.includes(`--${name}`);

const ONLY_EVENT = arg('event');
const LIMIT = arg('limit') ? parseInt(arg('limit'), 10) : Infinity;
const FORCE = flag('force');
const CONCURRENCY = 4;

const OUT_DIR = path.resolve(__dirname, '..', '..', 'drafts', 'historical-squares');

// Keep the landmark photographic + faithful; only extend the scene to fill the
// square. The magenta-extension prefix is auto-prepended by editWithGrok.
const EXTEND_PROMPT = 'Photographic, realistic. Keep the landmark and all existing buildings, structures, terrain, and scenery exactly as they are in the centre — same architecture, same proportions, same lighting, same era. Only extend the scene outward to fill the square frame with matching surroundings.';

function basenameFromUrl(url) {
  try { return path.basename(new URL(url).pathname); } catch { return path.basename(url); }
}

async function genOne(row) {
  const base = basenameFromUrl(row.photo_url);
  const outFile = path.join(OUT_DIR, `${row.event_id}__${base}`);
  if (!FORCE && fs.existsSync(outFile)) return { skipped: true, outFile };

  const bytes = await r2.bytesFromAnyImage(row.photo_url);
  if (!bytes) throw new Error(`could not fetch ${row.photo_url}`);
  const uri = 'data:image/jpeg;base64,' + bytes.toString('base64');

  const result = await editWithGrok(EXTEND_PROMPT, [uri], {
    aspectRatio: '1:1',
    padInputWithExtension: true,
    model: GROK_MODELS.STANDARD,
  });
  const b64 = result.imageData.replace(/^data:image\/\w+;base64,/, '');
  fs.writeFileSync(outFile, Buffer.from(b64, 'base64'));
  return { skipped: false, outFile };
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const where = ONLY_EVENT ? 'WHERE event_id = $1' : '';
  const params = ONLY_EVENT ? [ONLY_EVENT] : [];
  const { rows } = await pool.query(
    `SELECT event_id, location_name, photo_url FROM historical_locations
     ${where} ORDER BY event_id, location_name`, params);
  await pool.end();

  const targets = rows.filter(r => r.photo_url).slice(0, LIMIT);
  console.log(`Generating ${targets.length} square landmark(s) → ${OUT_DIR}`);

  let done = 0, made = 0, skipped = 0, failed = 0;
  // Simple concurrency pool
  const queue = [...targets];
  async function worker() {
    while (queue.length) {
      const row = queue.shift();
      try {
        const r = await genOne(row);
        if (r.skipped) { skipped++; } else { made++; }
        done++;
        console.log(`[${done}/${targets.length}] ${r.skipped ? 'skip' : 'OK  '} ${row.event_id} · ${row.location_name}`);
      } catch (e) {
        failed++; done++;
        console.error(`[${done}/${targets.length}] FAIL ${row.event_id} · ${row.location_name}: ${e.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`\nDone. made=${made} skipped=${skipped} failed=${failed}. Review: ${OUT_DIR}`);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
