/**
 * TEST RULE B: does the Art Director still set a cover underwater with land props?
 *
 * Rule B (prompts/scene-expansion-all.txt, 2026-09-14) says every cover backdrop
 * is a LOC the cast can stand in, and a cover's Objects hold only props that
 * belong in that backdrop. It acts when the hint is AUTHORED, so regenerating
 * the cover image cannot exercise it — only re-running the Art Director can.
 *
 * Prod story job_1789227389389_z18dmvnt6 authored:
 *   backCover objects: [LOC003 open water "no floor visible", ART009 quay lamp
 *   "bolted to the stone paving; the lamp is lit", ART007 autumn leaf pile, …]
 *   and character lines saying "stands" four times.
 *
 * This replays that same Art Director call with the same inputs and reports what
 * the cover hints come back as. One text call, no image generation.
 *
 * --dry  asserts the rule is in the template and prints the old hint, no spend.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const JOB = 'job_1789227389389_z18dmvnt6';
const DRY = process.argv.includes('--dry');
const OUT = 'C:/Users/roger/AppData/Local/Temp/claude/C--Users-roger-MagicalStory/7c09c544-3c41-4f8c-9a49-e4d09a0c3db8/scratchpad';

(async () => {
  const tpl = fs.readFileSync(path.join(__dirname, '..', '..', 'prompts', 'scene-expansion-all.txt'), 'utf8');
  const hasBackdropRule = tpl.includes('EVERY cover backdrop is a LOC the cast can stand in');
  const hasPropRule = tpl.includes("A cover's `Objects:` hold only props that belong in that backdrop");
  console.log(`rule B in template — backdrop: ${hasBackdropRule}, props: ${hasPropRule}`);
  if (!hasBackdropRule || !hasPropRule) { console.log('ABORT: rule B is not in the template'); process.exit(1); }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const r = await pool.query('select data from stories where data::text like $1 limit 1', ['%' + JOB + '%']);
  await pool.end();
  const storyData = r.rows[0].data;

  const old = storyData.coverHints?.backCover || {};
  console.log('\nOLD back-cover hint objects:', JSON.stringify(old.objects));

  // Templates are loaded lazily by the server bootstrap; a standalone script
  // must load them or every builder returns null.
  await require('../../server/services/prompts').loadPromptTemplates();
  const { buildSceneExpansionAllPrompt, parseBeats } = require('../../server/lib/storyHelpers');
  const { buildReplaySceneOptions } = require('../../server/lib/beatsReplayInputs');
  const { MODEL_DEFAULTS, IMAGE_MODELS } = require('../../server/config/models');

  // The stored outline is the full writer output with ---PAGE PLAN--- /
  // ---BEATS--- sections; parseBeats returns nothing for it, so read the plan
  // lines straight out of the PAGE PLAN section.
  let beats = parseBeats(String(storyData.outline || '')).beats || [];
  if (!beats.length) {
    const sec = String(storyData.outline || '').split('---PAGE PLAN---')[1] || '';
    const body = sec.split(/^---[A-Z ]+---$/m)[0] || '';
    beats = body.split(/\r?\n/)
      .map(l => l.match(/^\s*(?:Page\s*)?(\d+)\s*[.:)]\s*(.+)$/))
      .filter(Boolean)
      .map(m => ({ pageNumber: parseInt(m[1], 10), planLine: m[2].trim() }))
      .filter(b => b.planLine.length > 15);
    console.log('beats from ---PAGE PLAN--- section:', beats.length);
  }
  console.log('beats resolved:', beats.length);
  if (!beats.length) { console.log('ABORT: no beats'); process.exit(1); }
  console.log('  p1:', beats[0].planLine.slice(0, 100));

  const prompt = buildSceneExpansionAllPrompt(
    { ...storyData, characters: storyData.characters || [], pageClothing: null },
    beats.map(b => ({ pageNumber: b.pageNumber, planLine: b.planLine })),
    buildReplaySceneOptions(storyData, {
      availableAvatars: '',
      maxCharactersPerScene: IMAGE_MODELS[MODEL_DEFAULTS.pageImage]?.maxCharactersPerScene || 3,
      parseBeats,
    })
  );
  if (!prompt) { console.log('ABORT: prompt not built'); process.exit(1); }
  console.log('prompt built:', prompt.length, 'chars; carries rule B:', prompt.includes('EVERY cover backdrop is a LOC the cast can stand in'));

  if (DRY) { console.log('\n--dry: stopping before the paid call.'); return; }

  const textModels = require('../../server/lib/textModels');
  const model = MODEL_DEFAULTS.sceneModel || MODEL_DEFAULTS.scene || 'claude-opus-5';
  console.log(`\ncalling ${model} …`);
  const t0 = Date.now();
  const res = await textModels.callTextModelStreaming(prompt, null, null, model, { usageLabel: 'cover_rule_b_test' });
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  const out = String(res?.text || res?.content || res || '');
  fs.writeFileSync(path.join(OUT, 'rule-b-output.txt'), out);
  console.log(`OK in ${secs}s — ${out.length} chars → rule-b-output.txt`);

  // Report the cover hint section verbatim.
  const cover = out.match(/(Title Page|Front Cover)[\s\S]{0,3000}?(?=##\s*Page\s*1|\n---)/i);
  console.log('\n===== AUTHORED COVER HINTS =====');
  console.log(cover ? cover[0].slice(0, 2600) : '(cover section not matched — inspect rule-b-output.txt)');
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
