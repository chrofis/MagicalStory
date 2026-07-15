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

  const { runStageOnTarget } = require('../../server/lib/testlab');

  // Production two-pass flow, split: Pass 1 (realistic anchor) runs ONCE per
  // character and is reused by every style; Pass 2 (style transfer) is
  // per-style. Existing realistic anchors from prior experiments are reused
  // unless --fresh-realistic is passed.
  const realisticByChar = new Map(); // name -> versionIndex
  if (flags['fresh-realistic'] !== 'true') {
    const prior = await dbQuery(
      `SELECT e.value AS entry FROM testlab_experiments x, jsonb_array_elements(x.results) e
       WHERE x.stage IN ('avatars', 'avatar_realistic') AND (e.value->>'ok')::boolean
       ORDER BY x.id, (e.value->>'versionIndex')::int`);
    for (const r of prior) {
      const e = r.entry;
      if (e.storyId !== storyId) continue;
      if (x_isRealistic(e)) realisticByChar.set(e.character, x_realIdx(e));
    }
  }
  function x_isRealistic(e) { return e.pass === 1 || e.realisticVersionIndex != null; }
  function x_realIdx(e) { return e.pass === 1 ? e.versionIndex : e.realisticVersionIndex; }

  let failures = 0;
  const record = async (experimentId, entry) => dbQuery(
    `UPDATE testlab_experiments SET results = results || $2::jsonb WHERE id = $1`,
    [experimentId, JSON.stringify([entry])]);

  // Phase 1: realistic anchors for characters that don't have one yet.
  const missing = names.filter(n => !realisticByChar.has(n));
  if (missing.length) {
    const ins1 = await dbQuery(
      `INSERT INTO testlab_experiments (stage, label, params, status, targets, created_by)
       VALUES ('avatar_realistic', $1, $2, 'running', $3, 'testlab-cli') RETURNING id`,
      [`realistic anchors (${missing.length} chars)`, JSON.stringify({ pages }), JSON.stringify(missing.map(n => ({ storyId, character: n })))]);
    const exp1 = ins1[0].id;
    console.log(`Experiment ${exp1} started (avatar_realistic): ${missing.join(', ')}`);
    for (const name of missing) {
      try {
        const result = await runStageOnTarget('avatar_realistic', { storyId, character: name }, { experimentId: exp1 });
        realisticByChar.set(name, result.versionIndex);
        await record(exp1, { storyId, ok: true, ...result });
        console.log(`  ✅ ${name} realistic → v${result.versionIndex} score=${result.finalScore ?? '—'}`);
      } catch (err) {
        failures++;
        await record(exp1, { storyId, character: name, ok: false, error: err.message });
        console.log(`  ❌ ${name} realistic: ${err.message}`);
      }
    }
    await dbQuery(`UPDATE testlab_experiments SET status = 'completed', completed_at = NOW() WHERE id = $1`, [exp1]);
  } else {
    console.log(`Reusing existing realistic anchors: ${names.map(n => `${n}(v${realisticByChar.get(n)})`).join(', ')}`);
  }

  // Phase 2: style transfer per character, reusing the anchors.
  const ins2 = await dbQuery(
    `INSERT INTO testlab_experiments (stage, label, params, status, targets, created_by)
     VALUES ('avatar_style', $1, $2, 'running', $3, 'testlab-cli') RETURNING id`,
    [flags.label || `${artStyle} avatars (pass 2)`, JSON.stringify({ artStyle, pages }), JSON.stringify(names.map(n => ({ storyId, character: n })))]);
  const exp2 = ins2[0].id;
  console.log(`Experiment ${exp2} started (avatar_style, ${artStyle})`);
  for (const name of names) {
    const realisticVersionIndex = realisticByChar.get(name);
    if (realisticVersionIndex === undefined) {
      failures++;
      await record(exp2, { storyId, character: name, ok: false, error: 'no realistic anchor', artStyle });
      continue;
    }
    try {
      const result = await runStageOnTarget('avatar_style', { storyId, character: name }, {
        experimentId: exp2,
        params: { artStyle, realisticVersionIndex },
      });
      await record(exp2, { storyId, ok: true, ...result });
      console.log(`  ✅ ${name} ${artStyle} → v${result.versionIndex} (anchor v${realisticVersionIndex}) score=${result.finalScore ?? '—'}`);
    } catch (err) {
      failures++;
      await record(exp2, { storyId, character: name, ok: false, error: err.message, artStyle, realisticVersionIndex });
      console.log(`  ❌ ${name} ${artStyle}: ${err.message}`);
    }
  }
  await dbQuery(`UPDATE testlab_experiments SET status = $2, completed_at = NOW() WHERE id = $1`,
    [exp2, failures >= names.length ? 'failed' : 'completed']);
  console.log(`\n${failures ? '⚠️' : '✅'} Done (${names.length - failures}/${names.length} styled ok). Review experiment ${exp2} in /admin/test-lab.`);
  process.exit(failures ? 2 : 0);
}

main().catch(e => die(e.stack || e.message));
