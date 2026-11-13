#!/usr/bin/env node
/**
 * Replays the trial PLANNER (story-trial-arc.txt, the call that fixes the plot) on stored trial stories with the
 * current templates, and writes each arc so it can be rated for a setback (owner 2026-11-03: "the story writer should
 * write one setback"; evals/runs/2026-11-03_trial-story-setback is the baseline over the shipped stories).
 *
 * The commission is rebuilt from the story record (the job rows are pruned), the same fields
 * routes/admin/jobs.js rerun-full rebuilds. Paid: one trial arc call per story on MODEL_DEFAULTS.trialArcModel.
 *
 *   DBU=<postgres url> node scripts/analysis/trial-setback-replay.js <outDir> [--dry] [--limit=N] [--ids=jobId,jobId] [--cap=USD]
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function main() {
  const outDir = process.argv[2];
  if (!outDir) throw new Error('usage: trial-setback-replay.js <outDir> [--dry] [--limit=N]');
  const dry = process.argv.includes('--dry');
  const limit = parseInt((process.argv.find(a => a.startsWith('--limit=')) || '').split('=')[1], 10) || 20;
  fs.mkdirSync(outDir, { recursive: true });
  await require('../../server/services/prompts').loadPromptTemplates();
  const PB = require('../../server/lib/promptBuilders');
  const { callTextModelStreaming } = require('../../server/lib/textModels');
  const { MODEL_DEFAULTS, MODEL_PRICING } = require('../../server/config/models');
  const price = (MODEL_PRICING || {})[`google/${MODEL_DEFAULTS.trialArcModel}`];
  if (!dry && !price) throw new Error(`no price for ${MODEL_DEFAULTS.trialArcModel}`);
  const capUsd = parseFloat((process.argv.find(a => a.startsWith('--cap=')) || '').split('=')[1]) || 0;
  if (!dry && !capUsd) throw new Error('a paid run needs --cap=<USD>');
  // --ids=a,b: replay only these stored trials (e.g. the ones whose special details name a relative).
  const idsArg = (process.argv.find(a => a.startsWith('--ids=')) || '').split('=')[1];
  const ids = idsArg ? idsArg.split(',') : null;
  const pool = new Pool({ connectionString: process.env.DBU, ssl: { rejectUnauthorized: false } });
  const rows = (await pool.query(
    `SELECT id, data FROM stories WHERE (data->>'trialMode')='true'
       AND jsonb_array_length(COALESCE(data->'sceneImages','[]'))>0
       AND ($2::text[] IS NULL OR id = ANY($2)) ORDER BY created_at DESC LIMIT $1`, [limit, ids])).rows;
  await pool.end();

  let spent = 0;
  for (const { id, data: d } of rows) {
    const inputData = {
      trialMode: true, pages: (d.sceneImages || []).length || 6, language: d.language, languageLevel: d.languageLevel,
      artStyle: d.artStyle, season: d.season, storyType: d.storyType, storyCategory: d.storyCategory,
      storyTopic: d.storyTopic, storyTheme: d.storyTheme, storyDetails: d.storyDetails, mainCharacters: d.mainCharacters,
      characters: d.characters, relationships: d.relationships, relationshipTexts: d.relationshipTexts, userLocation: d.userLocation,
      costumeType: d.costumeType,
    };
    const prompt = PB.buildTrialArcPrompt(inputData, inputData.pages);
    const unfilled = [...new Set(prompt.match(/\{[A-Z_]{3,}\}/g) || [])];
    if (!prompt.includes(PB.TRIAL_SETBACK_RULE)) throw new Error(`${id}: built prompt lacks TRIAL_SETBACK_RULE`);
    fs.writeFileSync(path.join(outDir, `${id}.prompt.txt`), prompt);
    if (dry) { console.log(id, prompt.length, 'chars', unfilled.length ? `UNFILLED ${unfilled.join(',')}` : 'ok'); continue; }
    // The production planner call, as runTrialWriter makes it (trialWriter.js).
    const r = await callTextModelStreaming(prompt, null, () => {}, MODEL_DEFAULTS.trialArcModel,
      { usageLabel: 'unified_story', reasoning: { effort: MODEL_DEFAULTS.trialArcEffort } });
    const u = r.usage || {};
    const cost = ((u.input_tokens || 0) * price.input + (u.output_tokens || 0) * price.output + (u.thinking_tokens || 0) * (price.thinking || price.output)) / 1e6;
    spent += cost;
    fs.writeFileSync(path.join(outDir, `${id}.arc.txt`), String(r.text || ''));
    console.log(id, 'arc', String(r.text || '').length, 'chars', JSON.stringify(u), `USD ${cost.toFixed(4)}`, `running USD ${spent.toFixed(3)}`);
    if (spent > capUsd) { console.log(`STOP: cap USD ${capUsd} reached`); break; }
  }
}

main().catch(e => { console.error('ERR', e.stack); process.exit(1); });
