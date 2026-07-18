#!/usr/bin/env node
/**
 * A/B the Stage-2 prompt-compliance evaluator across models on stored pages.
 * Reproduces the over-strict-CRITICAL problem (qwen-plus) and tests whether a
 * stronger model on the SAME prompt fixes it. Counts CRITICALs and flags the
 * two rule-violation classes we saw: left/right-mirror and background/lighting
 * escalated to CRITICAL.
 *
 * Usage: node scripts/analysis/compliance-model-ab.js <storyId> <pages csv> [models csv]
 */
'use strict';
require('dotenv').config();
const { Pool } = require('pg');

const MIRROR_RE = /\bleft\b.*\bright\b|\bright\b.*\bleft\b|left hand|right hand/i;
const BG_RE = /wall|lighting|sunlight|light grey|shadow|background colou?r|overcast/i;

async function main() {
  const [storyId, pagesCsv, modelsCsv, tunedPromptFile] = process.argv.slice(2);
  const pages = (pagesCsv || '1').split(',').map(Number);
  // A "model" token may be "<model>@tuned" to use the tuned prompt file.
  const models = (modelsCsv || 'qwen-plus,gemini-2.5-flash').split(',');
  const tunedPrompt = tunedPromptFile ? require('fs').readFileSync(tunedPromptFile, 'utf8') : null;
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const sres = await pool.query('SELECT data FROM stories WHERE id=$1', [storyId]);
  let d = sres.rows[0].data; if (typeof d === 'string') d = JSON.parse(d);
  const imgRes = await pool.query(
    "SELECT DISTINCT ON (page_number) page_number, image_url FROM story_images WHERE story_id=$1 AND image_type='scene' AND is_test IS NOT TRUE ORDER BY page_number, version_index DESC", [storyId]);
  const urlByPage = new Map(imgRes.rows.map(r => [r.page_number, r.image_url]));
  await pool.end();

  const { loadPromptTemplates } = require('../../server/services/prompts');
  await loadPromptTemplates();
  const { evaluateImageQuality } = require('../../server/lib/images');

  for (const pn of pages) {
    const s = (d.sceneImages || []).find(x => x.pageNumber === pn);
    const url = urlByPage.get(pn);
    if (!s || !url) { console.log(`p${pn}: no data`); continue; }
    const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
    const imageData = `data:image/jpeg;base64,${buf.toString('base64')}`;
    console.log(`\n===== p${pn} (stored final ${s.finalScore})`);
    for (const modelToken of models) {
      const useTuned = modelToken.endsWith('@tuned');
      const model = modelToken.replace('@tuned', '');
      try {
        const res = await evaluateImageQuality(
          imageData, s.prompt || '', s.referencePhotos || s.characterPhotos || [], 'scene', null, `ab-p${pn}-${modelToken}`,
          s.text || null, s.sceneMetadata?.hint || null, s.sceneCharacters || null,
          {
            complianceModelOverride: model === 'qwen-plus' ? null : model,
            compliancePromptOverride: useTuned ? tunedPrompt : null,
          }
        );
        const ts = res?.threeStageResult || {};
        const issues = ts.fixableIssues || ts.issues || [];
        const crit = issues.filter(i => /critical/i.test(String(i.severity)));
        const mirror = crit.filter(i => MIRROR_RE.test(String(i.description || '')));
        const bg = crit.filter(i => BG_RE.test(String(i.description || '')));
        // Validity: a real Stage-2 result has a numeric score AND a verdict.
        // score=? + 0 issues = silent parse/model failure, NOT leniency.
        const valid = typeof ts.score === 'number' && !!ts.verdict;
        console.log(`  ${modelToken.padEnd(22)} ${valid ? `score=${ts.score} ${ts.verdict}` : 'INVALID/EMPTY (no parse)'}  CRIT=${crit.length} (mirror:${mirror.length} bg/light:${bg.length}) total=${issues.length}`);
        crit.forEach(i => console.log(`      [CRIT] ${String(i.description || '').slice(0, 115)}`));
      } catch (e) {
        console.log(`  ${model}: ERROR ${e.message}`);
      }
    }
  }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
