#!/usr/bin/env node
// Model Comparison: tests scene expansion/iteration prompts across AI models.
// Usage: node scripts/test-models.js <story-id> <page-number> [expansion|iterate|both]
require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const { loadPromptTemplates } = require('../server/services/prompts');
const { buildSceneExpansionPrompt, buildSceneDescriptionPrompt, getPageText,
  buildAvailableAvatarsForPrompt, parseClothingCategory } = require('../server/lib/storyHelpers');
const { callTextModel } = require('../server/lib/textModels');
const { TEXT_MODELS } = require('../server/config/models');

const TEST_MODELS = {
  'claude-sonnet': { provider: 'anthropic', modelId: 'claude-sonnet-4-6' },
  'claude-haiku': { provider: 'anthropic', modelId: 'claude-haiku-4-5-20251001' },
  'grok-4-fast': { provider: 'xai', modelId: 'grok-4-1-fast-non-reasoning' },
  'grok-4': { provider: 'xai', modelId: 'grok-4' },
  'grok-3-fast': { provider: 'xai', modelId: 'grok-3-fast' },
  'gemini-2.5-flash': { provider: 'google', modelId: 'gemini-2.5-flash' },
};

// Register missing models in TEXT_MODELS so callTextModel can use them
for (const [key, cfg] of Object.entries(TEST_MODELS)) {
  if (!TEXT_MODELS[key]) TEXT_MODELS[key] = { ...cfg, maxOutputTokens: 65536, description: `Test: ${cfg.modelId}` };
}
const OUTPUT_DIR = path.join(__dirname, '..', 'tests', 'model-comparison');

function getRawPageBlock(outlineText, pageNumber) {
  const pattern = new RegExp(
    `---\\s*(?:Page|Seite)\\s+${pageNumber}\\s*---\\s*([\\s\\S]*?)(?=---\\s*(?:Page|Seite)\\s+\\d+\\s*---|$)`, 'i'
  );
  const match = outlineText.match(pattern);
  return match ? `--- Page ${pageNumber} ---\n${match[1].trim()}` : null;
}

function extractJson(text) {
  if (!text) return null;
  // Strip double-brace from prefill artifacts: {{  → {
  let cleaned = text.replace(/^\s*\{\{/, '{').replace(/\}\}\s*$/, '}');
  // Also handle {"scene":{{ → {"scene":{
  cleaned = cleaned.replace(/:\s*\{\{/g, ':{');
  const fence = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fence) { try { return JSON.parse(fence[1].trim()); } catch (e) { /* continue */ } }
  const start = cleaned.indexOf('{');
  if (start === -1) return null;
  const text2 = cleaned;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text2.length; i++) {
    const ch = text2[i];
    if (ch === '\\' && inStr && !esc) { esc = true; continue; }
    if (esc) { esc = false; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (!inStr) {
      if (ch === '{') depth++;
      if (ch === '}' && --depth === 0) {
        try { return JSON.parse(text2.substring(start, i + 1)); } catch (e) { return null; }
      }
    }
  }
  return null;
}

function displayResult(name, result) {
  const time = result.elapsed ? `${(result.elapsed / 1000).toFixed(1)}s` : 'n/a';
  const inTok = result.usage?.input_tokens?.toLocaleString() || '?';
  const outTok = result.usage?.output_tokens?.toLocaleString() || '?';
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  ${name} (${result.modelId || '?'})  ${result.error ? 'FAILED' : 'OK'}  ${time}  [in:${inTok} out:${outTok}]`);
  console.log('='.repeat(70));
  if (result.error) { console.log(`  Error: ${result.error}`); return; }
  console.log(`  JSON parsed: ${result.parsed ? 'YES' : 'NO'}`);
  if (!result.parsed) { console.log(`  Raw: ${(result.text || '').substring(0, 200)}`); return; }

  // Unwrap scene from various wrapper formats
  let scene = result.parsed.scene || result.parsed.output || result.parsed.draft || result.parsed;
  if (scene?.previewMismatches?.[0]?.scene) scene = scene.previewMismatches[0].scene;
  if (scene?.scene && typeof scene.scene === 'object') scene = scene.scene;

  if (scene.imageSummary) {
    console.log(`  imageSummary: ${scene.imageSummary.substring(0, 150)}${scene.imageSummary.length > 150 ? '...' : ''}`);
  }

  if (scene.characters && Array.isArray(scene.characters)) {
    console.log(`  Characters (${scene.characters.length}):`);
    for (const c of scene.characters) {
      const pos = c.position || '';
      const clothing = c.clothing || '';
      const depth = c.depth || '';
      const perspective = c.perspective || '';
      const extras = [clothing, pos, depth, perspective].filter(Boolean).join(', ');
      console.log(`    - ${c.name}${extras ? ': ' + extras : ''}`);
    }
  }

  if (scene.objects && Array.isArray(scene.objects)) {
    const objList = scene.objects.map(o => typeof o === 'string' ? o : o.name || o.id).join(', ');
    console.log(`  Objects: ${objList}`);
  }

  if (scene.setting) {
    const s = scene.setting;
    const parts = [s.shotType, s.location, s.camera].filter(Boolean);
    if (parts.length) console.log(`  Setting: ${parts.join(' | ')}`);
  }

  const mm = result.parsed.previewMismatches;
  if (Array.isArray(mm) && mm.length > 0) {
    console.log(`  previewMismatches (${mm.length}):`);
    for (const m of mm.slice(0, 3)) console.log(`    - ${m.issue || m.description || JSON.stringify(m).substring(0, 100)}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.log('Usage: node scripts/test-models.js <story-id> <page-number> [expansion|iterate|both]');
    process.exit(1);
  }

  const storyId = args[0];
  const pageNumber = parseInt(args[1], 10);
  const mode = args[2] || 'both';

  if (!['expansion', 'iterate', 'both'].includes(mode)) { console.error(`Invalid mode. Use: expansion, iterate, both`); process.exit(1); }
  await loadPromptTemplates();
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

  try {
    const { rows } = await pool.query('SELECT data FROM stories WHERE id = $1', [storyId]);
    if (rows.length === 0) { console.error(`Story ${storyId} not found`); process.exit(1); }
    const storyData = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;
    const characters = storyData.characters || [];
    const visualBible = storyData.visualBible || null;
    const language = storyData.language || 'en';
    const fullStoryText = storyData.storyText || storyData.story || '';
    const sceneDescriptions = storyData.sceneDescriptions || [];
    const clothingRequirements = storyData.clothingRequirements || null;
    const pageClothingData = storyData.pageClothing || null;
    const outline = storyData.outline || '';
    const artStyle = storyData.artStyle || 'watercolor';
    let pageText = getPageText(fullStoryText, pageNumber);
    // Fallback: extract page text from outline (STORY PAGES section)
    if (!pageText && outline) {
      const pageBlock = getRawPageBlock(outline, pageNumber);
      if (pageBlock) {
        const textMatch = pageBlock.match(/TEXT:\s*([\s\S]*?)(?=SCENE HINT:|$)/i);
        if (textMatch) pageText = textMatch[1].trim().replace(/\s*\*\([^)]*\)\*\s*$/g, '').trim();
      }
    }
    if (!pageText) { console.error(`Page ${pageNumber} not found in story text or outline`); process.exit(1); }
    const availableAvatars = buildAvailableAvatarsForPrompt(characters, clothingRequirements);

    console.log(`\nStory: ${storyId}  |  Page: ${pageNumber}  |  Language: ${language}  |  Art: ${artStyle}`);
    console.log(`Characters: ${characters.map(c => c.name).join(', ')}`);
    console.log(`Page text: ${pageText.substring(0, 120)}...`);
    console.log(`Mode: ${mode}  |  Models: ${Object.keys(TEST_MODELS).join(', ')}`);

    // Build rawOutlineContext
    const currentPageBlock = getRawPageBlock(outline, pageNumber);
    const prevBlocks = [];
    for (let p = Math.max(1, pageNumber - 2); p < pageNumber; p++) {
      const b = getRawPageBlock(outline, p); if (b) prevBlocks.push(b);
    }
    const rawOutlineContext = currentPageBlock
      ? { currentPage: currentPageBlock, previousPages: prevBlocks.length > 0 ? prevBlocks.join('\n\n') : null }
      : null;
    console.log(rawOutlineContext
      ? `Outline context: current page found, ${prevBlocks.length} previous page(s)`
      : 'Outline context: not available');
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    const prompts = {};
    if (mode === 'expansion' || mode === 'both') {
      prompts.expansion = {
        prompt: buildSceneExpansionPrompt(pageNumber, pageText, characters, language, visualBible, availableAvatars, rawOutlineContext),
        prefill: '{' };
      console.log(`\nExpansion prompt: ${prompts.expansion.prompt.length} chars`);
    }
    if (mode === 'iterate' || mode === 'both') {
      const existingScene = sceneDescriptions.find(s => s.pageNumber === pageNumber);
      const shortSceneDesc = existingScene ? (existingScene.description || '') : '';
      const previousScenes = [];
      for (let p = Math.max(1, pageNumber - 2); p < pageNumber; p++) {
        const prevText = getPageText(fullStoryText, p);
        if (prevText) {
          let prevClothing = pageClothingData?.pageClothing?.[p] || null;
          if (!prevClothing) { const ps = sceneDescriptions.find(s => s.pageNumber === p); prevClothing = ps ? parseClothingCategory(ps.description) : null; }
          previousScenes.push({ pageNumber: p, text: prevText, sceneHint: '', clothing: prevClothing });
        }
      }
      const expectedClothing = pageClothingData?.pageClothing?.[pageNumber] || pageClothingData?.primaryClothing || 'standard';
      prompts.iterate = {
        prompt: buildSceneDescriptionPrompt(pageNumber, pageText, characters, shortSceneDesc, language, visualBible, previousScenes, expectedClothing, '', availableAvatars, rawOutlineContext),
        prefill: '{"previewMismatches":[' };
      console.log(`Iteration prompt: ${prompts.iterate.prompt.length} chars`);
    }

    for (const [promptType, { prompt, prefill }] of Object.entries(prompts)) {
      console.log(`\n${'#'.repeat(70)}\n  PROMPT TYPE: ${promptType.toUpperCase()}\n${'#'.repeat(70)}`);
      const tasks = Object.entries(TEST_MODELS).map(async ([modelKey]) => {
        const start = Date.now();
        try {
          const result = await callTextModel(prompt, 10000, modelKey, { prefill });
          const elapsed = Date.now() - start;
          const parsed = extractJson(result.text);
          return { modelKey, text: result.text, usage: result.usage, modelId: result.modelId, elapsed, parsed, error: null };
        } catch (err) {
          return { modelKey, elapsed: Date.now() - start, error: err.message, text: null, usage: null, modelId: null, parsed: null };
        }
      });

      const results = await Promise.allSettled(tasks);
      const summaryRows = [];
      for (const settled of results) {
        const r = settled.status === 'fulfilled' ? settled.value
          : { modelKey: '?', error: settled.reason?.message || 'Unknown', elapsed: 0 };
        displayResult(r.modelKey, r);
        summaryRows.push({ model: r.modelKey, modelId: r.modelId || '?',
          time: r.elapsed ? `${(r.elapsed / 1000).toFixed(1)}s` : 'n/a',
          inputTokens: r.usage?.input_tokens || 0, outputTokens: r.usage?.output_tokens || 0,
          jsonParsed: !!r.parsed, error: r.error || null });
        const fname = `${storyId}_p${pageNumber}_${promptType}_${r.modelKey}.json`;
        fs.writeFileSync(path.join(OUTPUT_DIR, fname), JSON.stringify(
          { model: r.modelKey, modelId: r.modelId, promptType, elapsed: r.elapsed, usage: r.usage, parsed: r.parsed, rawText: r.text, error: r.error }, null, 2));
      }
      // Summary table
      console.log(`\n${'─'.repeat(70)}\n  SUMMARY: ${promptType.toUpperCase()}\n${'─'.repeat(70)}`);
      console.log('  Model              Time    In Tok   Out Tok  JSON  Status');
      console.log('  ' + '─'.repeat(65));
      for (const row of summaryRows) {
        const n = row.model.padEnd(18), t = row.time.padStart(6);
        const iT = row.inputTokens.toLocaleString().padStart(8), oT = row.outputTokens.toLocaleString().padStart(8);
        console.log(`  ${n} ${t} ${iT} ${oT}  ${row.jsonParsed ? ' YES' : '  NO'}  ${row.error ? `ERR: ${row.error.substring(0, 30)}` : ' OK'}`);
      }
      const sf = `${storyId}_p${pageNumber}_${promptType}_summary.json`;
      fs.writeFileSync(path.join(OUTPUT_DIR, sf), JSON.stringify(
        { storyId, pageNumber, promptType, models: summaryRows, timestamp: new Date().toISOString() }, null, 2));
    }
    console.log(`\nOutputs saved to: ${OUTPUT_DIR}`);
  } finally {
    await pool.end();
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
