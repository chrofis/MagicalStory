#!/usr/bin/env node
/**
 * End-to-end test of the generic DINO->SAM production path: calls the REAL
 * detectAllBoundingBoxes (grounding-dino backend) + createBboxOverlayImage on
 * a stored story page, and writes the resulting overlay (boxes + red face
 * dots + object boxes + cutout strip) to disk.
 *
 * Usage: FIGURE_DETECTION_BACKEND=grounding-dino node scripts/analysis/test-gdino-production-path.js <storyId> <page> [--staging]
 */
'use strict';
require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

async function main() {
  const [storyId, pageArg, ...flags] = process.argv.slice(2);
  if (!storyId || !pageArg) { console.error('usage: test-gdino-production-path.js <storyId> <page> [--staging]'); process.exit(1); }
  const pn = Number(pageArg);
  const staging = flags.includes('--staging');
  const pool = new Pool({ connectionString: staging ? process.env.STAGING_DATABASE_URL : process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

  const sres = await pool.query('SELECT data FROM stories WHERE id=$1', [storyId]);
  let d = sres.rows[0].data; if (typeof d === 'string') d = JSON.parse(d);
  const scene = (d.sceneImages || []).find(s => s.pageNumber === pn);
  if (!scene) { console.error('page not found'); process.exit(1); }
  const meta = scene.sceneMetadata || {};

  const imgRes = await pool.query(
    "SELECT image_url FROM story_images WHERE story_id=$1 AND image_type='scene' AND page_number=$2 ORDER BY version_index ASC LIMIT 1", [storyId, pn]);
  const url = imgRes.rows[0]?.image_url;
  await pool.end();
  const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
  const imageData = `data:image/jpeg;base64,${buf.toString('base64')}`;

  const { detectAllBoundingBoxes, createBboxOverlayImage, buildExpectedCharactersForBbox, buildObjectGroundingHints } = require('../../server/lib/images');
  const { buildCharacterDescriptionsForBbox } = require('../../server/lib/storyHelpers');

  const expectedPositions = meta.characterPositions || {};
  const descriptions = buildCharacterDescriptionsForBbox(d, expectedPositions);
  const names = (scene.sceneCharacters || []).map(c => (typeof c === 'string' ? c : c?.name)).filter(Boolean);
  const onPage = {};
  for (const n of names) { const k = Object.keys(descriptions).find(x => x.toLowerCase() === n.toLowerCase()); if (k) onPage[k] = descriptions[k]; }
  const expectedCharacters = buildExpectedCharactersForBbox(onPage, expectedPositions, meta.characterClothing || {});
  // Resolve VB IDs -> natural labels, same as production does before enrich.
  const vb = d.visualBible || {};
  const byId = new Map();
  for (const pool of [vb.artifacts, vb.animals, vb.vehicles, vb.secondaryCharacters, vb.locations]) {
    for (const e of (pool || [])) if (e?.id && e?.name) byId.set(String(e.id).toUpperCase(), e.name);
  }
  const expectedObjects = (meta.objects || []).map(o => {
    const m = String(o).trim().match(/^([A-Z]{3}\d{3})(?:\.\d+)?$/);
    return m ? (byId.get(m[1]) || null) : o;
  }).filter(Boolean);
  console.log('expected characters:', expectedCharacters.map(c => `${c.name} (${c.position})`));
  console.log('expected objects:', expectedObjects);

  const t0 = Date.now();
  const det = await detectAllBoundingBoxes(imageData, {
    expectedCharacters, expectedObjects,
    pageContext: `TEST p${pn}`, skipCache: true,
    artStyle: d.artStyle,
    objectGroundingHints: buildObjectGroundingHints(expectedObjects, d.visualBible),
  });
  console.log(`\ndetection in ${((Date.now() - t0) / 1000).toFixed(0)}s, backend=${det?.detectionBackend}`);
  console.log('figures:', JSON.stringify(det?.figures?.map(f => ({ name: f.name, bodyBox: f.bodyBox?.map(v => +v.toFixed(3)), face: !!f.faceBox, conf: f.confidence, score: f.score })), null, 1));
  console.log('objects:', JSON.stringify(det?.objects || []));
  console.log('diag:', JSON.stringify(det?.gdinoDiag || null).slice(0, 1200));
  console.log('has masks:', Array.isArray(det?._gdinoMasks), (det?._gdinoMasks || []).filter(Boolean).length);
  console.log('masks serialized into JSON?', JSON.stringify(det).includes('_gdinoMasks') ? 'YES (BUG)' : 'no (correct)');

  const overlay = await createBboxOverlayImage(imageData, det);
  const out = path.join(require('os').tmpdir(), `gdino-prod-path-p${pn}.jpg`);
  fs.writeFileSync(out, Buffer.from(overlay.split(',')[1], 'base64'));
  console.log(`\noverlay -> ${out}`);
}
main().catch(e => { console.error(e); process.exit(1); });
