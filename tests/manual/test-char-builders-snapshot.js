/**
 * Snapshot test for the 4 character description builders.
 * Exercises each builder against real story data from the DB so we can
 * diff output BEFORE vs AFTER the refactor.
 *
 * Usage:
 *   node tests/manual/test-char-builders-snapshot.js > /tmp/snapshot.txt
 */

require('dotenv').config();

async function main() {
  const { loadPromptTemplates } = require('../../server/services/prompts');
  await loadPromptTemplates();

  const helpers = require('../../server/lib/storyHelpers');
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

  try {
    const { rows } = await pool.query("SELECT data FROM stories WHERE id = 'job_1776103841918_28azabqbf'");
    if (!rows.length) throw new Error('test story not found');
    const data = rows[0].data;
    const chars = data.characters || [];

    console.log('='.repeat(80));
    console.log('BUILDER 1: buildCharacterPhysicalDescription');
    console.log('='.repeat(80));
    for (const char of chars) {
      console.log(`\n--- ${char.name} ---`);
      console.log(helpers.buildCharacterPhysicalDescription(char));
    }

    console.log('\n' + '='.repeat(80));
    console.log('BUILDER 3: buildCharacterReferenceList');
    console.log('='.repeat(80));
    // Build photos array mimicking what callers pass
    const photos = chars.map(c => ({
      name: c.name,
      clothingDescription: c.avatars?.clothing?.standard || null,
    }));
    console.log(helpers.buildCharacterReferenceList(photos, chars));

    console.log('\n' + '='.repeat(80));
    console.log('BUILDER 2 (indirect via buildSceneExpansionPrompt)');
    console.log('='.repeat(80));
    // Exercise all characters at once to see the numbered list
    const expansionPrompt = helpers.buildSceneExpansionPrompt(
      2, 'test page content', chars, 'de', null, '', null, {}
    );
    // Extract just the CHARACTER_DESCRIPTIONS section (numbered items)
    const m = expansionPrompt.match(/(\d+\.\s[^\n]+(?:\n|$))+/);
    if (m) {
      console.log(m[0].trim());
    } else {
      console.log('(no numbered character list found in expansion prompt — raw snippet:)');
      const idx = expansionPrompt.indexOf('1. ');
      if (idx >= 0) console.log(expansionPrompt.substring(idx, idx + 3000));
    }

    console.log('\n' + '='.repeat(80));
    console.log('BUILDER 4 (indirect via buildImagePrompt)');
    console.log('='.repeat(80));
    // buildImagePrompt isn't exported; exercise it indirectly.
    // Most pipelines call it via buildImagePromptForPage or similar.
    // If not exported, skip with a note.
    if (typeof helpers.buildImagePrompt === 'function') {
      const imgPrompt = helpers.buildImagePrompt('test scene', data, chars, false, null, 2, false, photos);
      // Grab the numbered character list section
      const m2 = imgPrompt.match(/(\d+\.\s[^\n]+(?:\n|$))+/);
      console.log(m2 ? m2[0].trim() : '(no numbered list found)');
    } else {
      console.log('(buildImagePrompt not exported — refactored thin wrapper will be exercised via integration tests)');
    }
  } finally {
    await pool.end();
  }
}

main().catch(e => { console.error('FAIL:', e.message); console.error(e.stack); process.exit(1); });
