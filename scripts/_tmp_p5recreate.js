// Recreate p5 end-to-end with TODAY'S code: current scene-expansion template
// (450-word budget) + current prompt builders (short preamble, merged
// proportions, short object leads). 3 runs for variability. Reports lengths.
require('dotenv').config();
const { Pool } = require('pg');

(async () => {
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const r = await pool.query(`SELECT data->'sceneImages'->4 AS p5, data->'visualBible' AS vb, data->'characters' AS chars,
    data->'clothingRequirements' AS creq, data->>'artStyle' AS art, data->>'language' AS lang, data->>'languageLevel' AS ll
    FROM stories WHERE id='job_1786397108357_q1fjbdzbx'`);
  await pool.end();
  const { p5, vb, chars, creq, art, lang, ll } = r.rows[0];

  const { loadPromptTemplates } = require('../server/services/prompts');
  await loadPromptTemplates();
  const { buildSceneExpansionPrompt } = require('../server/lib/promptBuilders');
  const { buildAvailableAvatarsForPrompt } = require('../server/lib/clothingResolve');
  const { buildImagePrompt } = require('../server/lib/storyHelpers');
  const { callTextModel } = require('../server/lib/textModels');
  const { IMAGE_MODELS, MODEL_DEFAULTS } = require('../server/config/models');

  const imgModelConfig = IMAGE_MODELS[MODEL_DEFAULTS.pageImage];
  const availableAvatars = buildAvailableAvatarsForPrompt(chars || [], creq || null);
  const expansionPrompt = buildSceneExpansionPrompt(
    5, p5.outlineExtract, chars || [], lang,
    vb, availableAvatars, null,
    {
      maxCharactersPerScene: imgModelConfig?.maxCharactersPerScene || 3,
      artStyleId: art,
      imageBackend: imgModelConfig?.backend,
      referencePhotos: p5.referencePhotos || null,
    }
  );
  console.log('expansion prompt:', expansionPrompt.length, 'chars | model:', MODEL_DEFAULTS.sceneDescription);

  for (let n = 1; n <= 3; n++) {
    const res = await callTextModel(expansionPrompt, 8000, MODEL_DEFAULTS.sceneDescription, { usageLabel: 'scene_descriptions', temperature: undefined });
    const brief = (res?.text || '').trim();
    const proseOnly = brief.split(/```|\{/)[0].trim();
    const words = proseOnly.split(/\s+/).length;
    const finalPrompt = buildImagePrompt(
      brief,
      { artStyle: art, language: lang, languageLevel: ll },
      p5.sceneCharacters || null,
      vb,
      5,
      p5.referencePhotos || null,
      { imageBackend: 'grok', textPositionOverride: p5.textPosition }
    );
    console.log(`run ${n}: prose ${words} words (${proseOnly.length} chars) → FINAL PROMPT ${finalPrompt.length} chars ${finalPrompt.length <= 7500 ? '✓ under cap' : '✗ OVER 7500 (shrink pipeline would fire)'}`);
    require('fs').writeFileSync(`C:/Users/roger/AppData/Local/Temp/claude/C--Users-roger-MagicalStory/5e638703-ea7b-4f0b-86a3-c96876a22612/scratchpad/run6/p5-recreated-${n}.txt`, finalPrompt);
  }
  console.log('\noriginal production prompt was 9439 chars (blind-cut to 7500, ART STYLE lost)');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
