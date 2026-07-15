#!/usr/bin/env node
/**
 * Test Lab avatar runner — generate styled 2x4 avatar sheets for a story's
 * benchmark characters in a target art style, via the production two-pass
 * pipeline (Pass 1 realistic anchor → Pass 2 style transfer).
 *
 * Sheets are stored as story_images test rows (image_type 'tl_avatar',
 * page_number NULL, is_test=true) and logged as a testlab_experiments row so
 * they're reviewable before any scene generation. Costume descriptions are
 * taken from the story's own scene referencePhotos (per character).
 *
 * Usage:
 *   node scripts/admin/testlab-avatars.js --story <id> --style pixar \
 *     [--pages 2,5,6,8,9,10] [--chars Roger,Lukas] [--env staging]
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const val = (i + 1 < argv.length && !argv[i + 1].startsWith('--')) ? argv[++i] : 'true';
      flags[key] = val;
    }
  }
  return flags;
}
const flags = parseFlags(process.argv.slice(2));
function die(msg) { console.error(`ERROR: ${msg}`); process.exit(1); }

const env = flags.env || 'staging';
if (env === 'staging') {
  if (!process.env.STAGING_DATABASE_URL) die('STAGING_DATABASE_URL not set');
  process.env.DATABASE_URL = process.env.STAGING_DATABASE_URL;
} else if (env !== 'prod') die('--env must be staging or prod');

async function main() {
  const storyId = flags.story;
  const artStyle = flags.style;
  if (!storyId || !artStyle) die('--story and --style required');
  const pages = (flags.pages || '2,5,6,8,9,10').split(',').map(Number);

  const { initializePool, dbQuery, getNextVersionIndex, saveStoryImage } = require('../../server/services/database');
  initializePool();
  const { loadPromptTemplates } = require('../../server/services/prompts');
  await loadPromptTemplates();
  const { generateCharacter2x4Sheet } = require('../../server/lib/character2x4Sheet');

  // Story data: characters + per-character costume description from scene refs.
  const rows = await dbQuery('SELECT data, user_id FROM stories WHERE id = $1', [storyId]);
  if (!rows.length) die(`Story ${storyId} not found in ${env}`);
  const data = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;

  // Prefer the canonical characters-table row (carries photos.face for the
  // identity pass); the story-data copies only hold thumbnails/boxes.
  let characters = data.characters || [];
  const charRows = await dbQuery('SELECT data FROM characters WHERE id = $1', [`characters_${rows[0].user_id}`]);
  if (charRows.length) {
    const cd = typeof charRows[0].data === 'string' ? JSON.parse(charRows[0].data) : charRows[0].data;
    const canonical = Array.isArray(cd) ? cd : (cd.characters || []);
    if (canonical.length) characters = canonical;
  }

  const costumeByChar = new Map(); // name -> {category, description}
  for (const scene of data.sceneImages || []) {
    if (!pages.includes(parseInt(scene.pageNumber, 10))) continue;
    for (const rp of scene.referencePhotos || []) {
      if (rp.name && !costumeByChar.has(rp.name)) {
        costumeByChar.set(rp.name, { category: rp.clothingCategory || 'standard', description: rp.clothingDescription || null });
      }
    }
  }
  let names = [...costumeByChar.keys()];
  if (flags.chars) names = flags.chars.split(',').map(s => s.trim()).filter(n => costumeByChar.has(n) || names.includes(n));
  console.log(`Characters (${names.length}): ${names.join(', ')} — style=${artStyle}, env=${env}`);

  const ins = await dbQuery(
    `INSERT INTO testlab_experiments (stage, label, params, status, targets, created_by)
     VALUES ('avatars', $1, $2, 'running', $3, 'testlab-cli') RETURNING id`,
    [flags.label || `${artStyle} avatars`, JSON.stringify({ artStyle, pages }), JSON.stringify(names.map(n => ({ character: n })))]
  );
  const experimentId = ins[0].id;
  console.log(`Experiment ${experimentId} started (avatars)`);

  let failures = 0;
  for (const name of names) {
    const char = characters.find(c => c.name === name) || characters.find(c => (c.name || '').toLowerCase() === name.toLowerCase());
    const costume = costumeByChar.get(name) || { category: 'standard', description: null };
    const t0 = Date.now();
    let entry;
    if (!char) {
      entry = { character: name, ok: false, error: 'character not found in story data' };
      failures++;
      console.log(`  ❌ ${name}: not found`);
    } else {
      try {
        const result = await generateCharacter2x4Sheet(char, {
          clothingCategory: costume.category,
          costumeDescription: costume.description || 'standard outfit',
          artStyle,
        });
        if (!result?.imageData) throw new Error('no sheet returned');
        const styledIdx = await getNextVersionIndex(storyId, 'tl_avatar', null);
        await saveStoryImage(storyId, 'tl_avatar', null, result.imageData, {
          versionIndex: styledIdx, isTest: true, experimentId, generatedAt: new Date().toISOString(),
          qualityScore: result.finalScore != null ? Math.round(result.finalScore) : null,
        });
        let realisticIdx = null;
        if (result.realisticImageData && result.realisticImageData !== result.imageData) {
          realisticIdx = await getNextVersionIndex(storyId, 'tl_avatar', null);
          await saveStoryImage(storyId, 'tl_avatar', null, result.realisticImageData, {
            versionIndex: realisticIdx, isTest: true, experimentId, generatedAt: new Date().toISOString(),
          });
        }
        entry = {
          character: name, ok: true, artStyle, storyId,
          clothingCategory: costume.category,
          imageType: 'tl_avatar', versionIndex: styledIdx, realisticVersionIndex: realisticIdx,
          finalScore: result.finalScore ?? null, passes: result.passes ?? null,
          elapsedMs: Date.now() - t0,
        };
        console.log(`  ✅ ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s) → styled v${styledIdx}${realisticIdx !== null ? `, realistic v${realisticIdx}` : ''} score=${result.finalScore ?? '—'}`);
      } catch (err) {
        failures++;
        entry = { character: name, ok: false, error: err.message, artStyle };
        console.log(`  ❌ ${name}: ${err.message}`);
      }
    }
    await dbQuery(`UPDATE testlab_experiments SET results = results || $2::jsonb WHERE id = $1`,
      [experimentId, JSON.stringify([entry])]);
  }
  await dbQuery(`UPDATE testlab_experiments SET status = $2, completed_at = NOW() WHERE id = $1`,
    [experimentId, failures === names.length ? 'failed' : 'completed']);
  console.log(`\n${failures ? '⚠️' : '✅'} Experiment ${experimentId} done (${names.length - failures}/${names.length} ok)`);
  process.exit(failures ? 2 : 0);
}

main().catch(e => die(e.stack || e.message));
