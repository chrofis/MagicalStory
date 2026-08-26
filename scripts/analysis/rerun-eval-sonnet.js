// Re-run the three-stage compliance eval with Sonnet on Stage 2 instead of Haiku.
// Stage 1 (vision inventory) stays on Gemini Flash-Lite.
require('dotenv').config();
const path = require('path');
const { Pool } = require('pg');

(async () => {
  const storyId = process.argv[2];
  const pageNumber = parseInt(process.argv[3] || '4', 10);
  const versionIndex = parseInt(process.argv[4] || '0', 10);
  if (!storyId) { console.error('Usage: <storyId> <pageNum> [versionIndex]'); process.exit(1); }

  const pool = new Pool({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const imgR = await pool.query(
    `SELECT image_data FROM story_images WHERE story_id=$1 AND page_number=$2 AND image_type='scene' AND version_index=$3`,
    [storyId, pageNumber, versionIndex]
  );
  if (!imgR.rows[0]) { console.error('image not found'); await pool.end(); process.exit(1); }
  const imageData = imgR.rows[0].image_data;

  const sceneR = await pool.query(
    `SELECT scene->>'sceneDescription' AS sd, scene->>'prompt' AS p
     FROM stories, jsonb_array_elements(data::jsonb->'sceneImages') AS scene
     WHERE id=$1 AND (scene->>'pageNumber')::int=$2`,
    [storyId, pageNumber]
  );
  await pool.end();
  if (!sceneR.rows[0]) { console.error('scene not found'); process.exit(1); }
  const sceneDescription = sceneR.rows[0].sd;
  const storedPrompt = sceneR.rows[0].p || sceneDescription;

  const { loadPromptTemplates, PROMPT_TEMPLATES } = require(path.resolve(__dirname, '..', '..', 'server', 'services', 'prompts'));
  await loadPromptTemplates();
  const { callTextModel } = require(path.resolve(__dirname, '..', '..', 'server', 'lib', 'textModels'));
  const { extractJsonFromText, extractSceneMetadata } = require(path.resolve(__dirname, '..', '..', 'server', 'lib', 'storyHelpers'));

  // Extract interactions from sceneHint for Stage 2
  let interactionsBlock = '(none declared)';
  try {
    const meta = extractSceneMetadata(sceneDescription || storedPrompt);
    const interactions = meta?.interactions || (Array.isArray(meta?.fullData?.interactions) ? meta.fullData.interactions : null);
    if (interactions && interactions.length > 0) {
      interactionsBlock = interactions.map(i => `- ${i.character || '?'} + ${i.object || '?'}: ${i.where || '(no placement given)'}`).join('\n');
    }
  } catch {}

  // --- Stage 1: vision inventory (Gemini flash-lite, with image) ---
  const apiKey = process.env.GEMINI_API_KEY;
  const visionPrompt = PROMPT_TEMPLATES.imageVisionInventory;
  const b64 = imageData.replace(/^data:image\/\w+;base64,/, '');
  const visionUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`;
  const visionBody = {
    contents: [{ parts: [
      { inline_data: { mime_type: 'image/jpeg', data: b64 } },
      { text: visionPrompt }
    ] }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 4096 }
  };
  console.log('Stage 1: vision inventory (gemini-flash-lite)...');
  const t1 = Date.now();
  const visionResp = await fetch(visionUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(visionBody) });
  const visionJson = await visionResp.json();
  const visionText = visionJson.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!visionText) { console.error('Stage 1 failed:', JSON.stringify(visionJson).slice(0, 500)); process.exit(1); }
  console.log(`Stage 1 done in ${((Date.now()-t1)/1000).toFixed(1)}s — ${visionText.length} chars`);

  // --- Stage 2: compliance (CLAUDE-SONNET, text only) ---
  const complianceTemplate = PROMPT_TEMPLATES.imagePromptCompliance;
  const complianceInput = complianceTemplate
    .replace('{ORIGINAL_PROMPT}', (storedPrompt || '').substring(0, 3000))
    .replace('{VISUAL_INVENTORY}', visionText)
    .replace('{INTERACTIONS_BLOCK}', interactionsBlock);

  console.log('Stage 2: compliance (claude-sonnet)...');
  const t2 = Date.now();
  const sonnetResult = await callTextModel(complianceInput, 4096, 'claude-sonnet');
  console.log(`Stage 2 done in ${((Date.now()-t2)/1000).toFixed(1)}s — input ${sonnetResult.usage?.input_tokens} / output ${sonnetResult.usage?.output_tokens} tokens`);

  const parsed = extractJsonFromText(sonnetResult.text);
  if (!parsed) { console.error('could not parse JSON\n' + sonnetResult.text.slice(0, 1500)); process.exit(1); }

  console.log(`\n=== RESULT (Sonnet) ===`);
  console.log(`score: ${parsed.score}/10  verdict: ${parsed.verdict}`);
  console.log(`issues_summary: ${parsed.issues_summary || '(none)'}`);
  if (parsed.fixable_issues?.length) {
    console.log(`fixable_issues: ${parsed.fixable_issues.length}`);
    for (const f of parsed.fixable_issues) {
      console.log(`  [${f.severity}] (${f.type}) ${f.description}`);
      console.log(`    fix: ${f.fix}`);
    }
  } else {
    console.log('fixable_issues: 0');
  }
})().catch(e => { console.error(e.message); console.error(e.stack); process.exit(1); });
