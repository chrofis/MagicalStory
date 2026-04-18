#!/usr/bin/env node
/**
 * Test scene expansion text-zone avoidance across all pages of a story.
 * Re-runs expansion with the CURRENT prompt template using Haiku and reports
 * whether character positions land in the text zone or opposite it.
 *
 * Usage:
 *   node scripts/test-scene-expansion.js <storyId>
 */
'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const { Pool } = require('pg');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const storyId = process.argv[2];
if (!storyId) { console.error('Usage: node scripts/test-scene-expansion.js <storyId>'); process.exit(1); }

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

function forbiddenSide(textPos) {
  if (!textPos) return null;
  if (textPos.includes('right')) return 'right';
  if (textPos.includes('left')) return 'left';
  if (textPos === 'bottom-full') return 'bottom';
  if (textPos === 'top-full') return 'top';
  return null;
}

function hasConflict(position, forbidden) {
  if (!forbidden || !position) return false;
  return position.toLowerCase().includes(forbidden);
}

(async () => {
  const { loadPromptTemplates } = require(path.join(ROOT, 'server/services/prompts'));
  await loadPromptTemplates();
  const { buildSceneExpansionPrompt } = require(path.join(ROOT, 'server/lib/storyHelpers'));
  const { callTextModel } = require(path.join(ROOT, 'server/lib/textModels'));

  const pool = new Pool({
    connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  // Pull all scenes + story-level data
  const r = await pool.query(`
    SELECT
      (scene->>'pageNumber')::int as page,
      scene->>'textPosition' as text_pos,
      scene->>'outlineExtract' as outline,
      scene->>'text' as page_text,
      scene->'outlineCharacters' as outline_chars,
      data->'characters' as all_characters,
      data->'visualBible' as visual_bible
    FROM stories, jsonb_array_elements(data->'sceneImages') scene
    WHERE stories.id=$1
    ORDER BY (scene->>'pageNumber')::int
  `, [storyId]);
  await pool.end();

  if (!r.rows.length) { console.error('No scenes found for', storyId); process.exit(1); }

  console.log(`\nStory: ${storyId}  (${r.rows.length} pages)`);
  console.log('Model:', HAIKU_MODEL);
  console.log('─'.repeat(70));

  let totalConflicts = 0, totalChars = 0;

  for (const row of r.rows) {
    const { page, text_pos, outline, page_text, outline_chars, all_characters, visual_bible } = row;
    const forbidden = forbiddenSide(text_pos);

    // Filter characters to those in this scene
    const sceneCharNames = new Set((outline_chars || []).map(n => n.toLowerCase()));
    const characters = (all_characters || []).filter(c =>
      sceneCharNames.size === 0 || sceneCharNames.has((c.name || '').toLowerCase())
    );

    if (!outline) {
      console.log(`P${page} [${text_pos}] — no outlineExtract, skipping`);
      continue;
    }

    // Build scene expansion prompt with current template
    let prompt;
    try {
      prompt = buildSceneExpansionPrompt(
        page,
        page_text || '',
        characters,
        'de-ch',
        visual_bible || null,
        '',
        { currentPage: outline }
      );
    } catch (e) {
      console.log(`P${page} [${text_pos}] — prompt build failed: ${e.message}`);
      continue;
    }

    // Show what override was injected (if any)
    const overrideMatch = prompt.match(/TEXT ZONE POSITION FIXES[^\n]*\n([\s\S]*?)\nApply these/);
    if (overrideMatch) console.log(`  [override] ${overrideMatch[1].replace(/\n/g, ' | ')}`);
    else console.log(`  [override] none`);

    // Call Haiku
    let result;
    try {
      result = await callTextModel(prompt, 1200, HAIKU_MODEL);
    } catch (e) {
      console.log(`P${page} [${text_pos}] — Haiku call failed: ${e.message}`);
      continue;
    }

    const text = result.content || result.text || '';

    // Extract metadata JSON
    let chars = [];
    const metaIdx = text.indexOf('---METADATA---');
    if (metaIdx > -1) {
      const metaBlock = text.slice(metaIdx + 14);
      const jsonMatch = metaBlock.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try { chars = JSON.parse(jsonMatch[0]).characters || []; } catch {}
      }
    }

    // Check conflicts
    const conflicts = chars.filter(c => hasConflict(c.position, forbidden));
    totalConflicts += conflicts.length;
    totalChars += chars.length;

    const status = conflicts.length ? `*** ${conflicts.length} CONFLICT(S)` : 'OK';
    console.log(`P${page} [${text_pos}] avoid=${forbidden || 'n/a'}  ${status}`);
    chars.forEach(c => {
      const flag = hasConflict(c.position, forbidden) ? ' ← CONFLICT' : '';
      console.log(`  ${c.name}: ${c.position}${flag}`);
    });
  }

  console.log('─'.repeat(70));
  console.log(`Result: ${totalConflicts} conflict(s) across ${totalChars} character placements`);
  process.exit(0);
})().catch(e => { console.error('ERR:', e.stack || e.message); process.exit(1); });
