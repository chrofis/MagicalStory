#!/usr/bin/env node
/**
 * Smoke-test the production composite-cover module end-to-end.
 * Loads a real story's characters + hint + landmark and runs the
 * composite generator. Saves outputs to tests/composite-prod-test/.
 */
'use strict';
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const STORY_ID = process.argv[2] || 'job_1778268595639_n3v7erasi';
const HINT_KEY = process.argv[3] || 'initialPage';

async function main() {
  const dbUrl = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  if (!dbUrl) throw new Error('DATABASE_PUBLIC_URL or DATABASE_URL required');
  const pool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

  console.log(`📖 story: ${STORY_ID}, hint: ${HINT_KEY}`);

  // Fetch what we need from stories.data (narrow projection)
  const r = await pool.query({
    text: `
      SELECT
        data->>'title' AS title,
        data->>'artStyle' AS art_style,
        data->'characters' AS characters,
        data->'coverHints'->$2 AS hint,
        data->'visualBible'->'artifacts' AS artifacts,
        (SELECT array_agg(loc) FROM jsonb_array_elements(data->'visualBible'->'locations') loc
          WHERE (loc->>'isRealLandmark')::boolean = true
            AND (loc->>'referenceImageUrl' IS NOT NULL OR loc->>'referenceImageData' IS NOT NULL)) AS locations
      FROM stories WHERE id = $1
    `,
    values: [STORY_ID, HINT_KEY],
    statement_timeout: 600000,
  });
  const row = r.rows[0];
  if (!row) { console.error('story not found'); process.exit(1); }
  console.log(`   title: "${row.title}"  artStyle: ${row.art_style}`);
  console.log(`   chars: ${row.characters?.length || 0}  hint chars: ${row.hint?.characters?.length || 0}`);

  // Load a landmark photo (from VB locations or, if those are empty, from
  // historical_locations matched against the hint's LOC objects).
  let landmarkBuf = null;
  let landmarkName = null;
  const vbLocs = row.locations || [];
  const hintLocIds = (row.hint?.objects || []).filter(id => /^LOC\d+/i.test(String(id)));
  // Try VB location with matching id first
  for (const id of hintLocIds) {
    const loc = vbLocs.find(l => l?.id === id);
    if (!loc) continue;
    landmarkName = loc.name;
    const r2 = require('../server/lib/r2');
    for (const src of [loc.referenceImageUrl, loc.referenceImageData]) {
      if (!src) continue;
      try { const buf = await r2.bytesFromAnyImage(src); if (buf) { landmarkBuf = buf; break; } } catch {}
    }
    if (landmarkBuf) break;
  }
  // Fall back to historical_locations
  if (!landmarkBuf) {
    const hist = await pool.query(`
      SELECT id, location_name, photo_url, photo_data
      FROM historical_locations
      WHERE (photo_url IS NOT NULL OR photo_data IS NOT NULL)
        AND (location_name ILIKE 'Zurich%' OR location_query ILIKE '%zurich%')
      ORDER BY photo_score DESC NULLS LAST LIMIT 1
    `);
    if (hist.rows[0]) {
      const r2 = require('../server/lib/r2');
      landmarkName = hist.rows[0].location_name;
      for (const src of [hist.rows[0].photo_url, hist.rows[0].photo_data]) {
        if (!src) continue;
        try { const buf = await r2.bytesFromAnyImage(src); if (buf) { landmarkBuf = buf; break; } } catch {}
      }
    }
  }
  console.log(`🏞️  landmark: ${landmarkName || '(none)'}  ${landmarkBuf ? `(${(landmarkBuf.length/1024).toFixed(0)} KB)` : 'NO BYTES'}`);

  // Inject artifact images into the hint so coverComposite can pick them up
  const enrichedHint = { ...(row.hint || {}) };
  enrichedHint._artifactImages = {};
  enrichedHint._artifactNames = {};
  for (const id of (enrichedHint.objects || [])) {
    if (!/^ART\d+/.test(String(id))) continue;
    const art = (row.artifacts || []).find(a => a?.id === id);
    if (!art) continue;
    enrichedHint._artifactNames[id] = art.name || id;
    const src = art.referenceImageUrl || art.referenceImageData;
    if (src) enrichedHint._artifactImages[id] = src;
  }

  await pool.end();

  // Call the production module
  const { generateCoverViaComposite } = require('../server/lib/coverComposite');
  console.log('🚀 calling generateCoverViaComposite...');
  const result = await generateCoverViaComposite({
    coverKey: HINT_KEY === 'titlePage' ? 'frontCover' : HINT_KEY,
    characters: row.characters || [],
    coverHint: enrichedHint,
    landmarkBuf,
    artStyle: row.art_style || 'watercolor',
    title: row.title || '',
    styleHint: 'traditional watercolor in the style of Inga Moore — textured paper with pencil underpainting, soft paint edges, visible artistic brushstrokes, luminous flowing colors',
    usageTracker: (provider, usage, fn, modelId) => console.log(`   usage: ${provider} ${fn} cost=$${usage.cost}`),
  });
  console.log(`✅ result modelId=${result.modelId} totalAttempts=${result.totalAttempts}`);

  // Save outputs
  const outDir = path.resolve(__dirname, '..', 'tests', `composite-prod-${Date.now()}`);
  fs.mkdirSync(outDir, { recursive: true });
  const finalBytes = Buffer.from(String(result.imageData).replace(/^data:image\/\w+;base64,/, ''), 'base64');
  fs.writeFileSync(path.join(outDir, 'final.jpg'), finalBytes);
  if (result.debug?.pass1Input) fs.writeFileSync(path.join(outDir, 'pass1-input.jpg'), result.debug.pass1Input);
  if (result.debug?.pass1Output) fs.writeFileSync(path.join(outDir, 'pass1-output.jpg'), result.debug.pass1Output);
  if (result.debug?.pass2Input) fs.writeFileSync(path.join(outDir, 'pass2-input.jpg'), result.debug.pass2Input);
  if (result.debug?.pass2Output) fs.writeFileSync(path.join(outDir, 'pass2-output.jpg'), result.debug.pass2Output);
  fs.writeFileSync(path.join(outDir, 'prompt.txt'), result.prompt);
  fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify({
    storyId: STORY_ID, hintKey: HINT_KEY, title: row.title,
    sequence: result.debug?.sequence, modelId: result.modelId,
  }, null, 2));
  console.log(`📂 ${outDir}`);
}

main().catch(e => { console.error('💥', e.message); console.error(e.stack); process.exit(1); });
