#!/usr/bin/env node
/**
 * Build the REAL prompts of two text stages over STORED stories and parse the answers with the REAL parsers
 * (docs/decisions.md 2026-10-18 "The world is told"). Free: no model call is made here. The answers come from
 * wherever the caller gets them (an agent standing in for the model, or a real call); each phase only builds or parses.
 *
 *   node scripts/admin/replay-story-world.js writer-prompts --db=prod|staging --out=<dir> --arm=<name> <storyId>...
 *       the beats text writer prompt (buildStoryTextFromBeatsPrompt, the Lab's story_text_replay arguments) -> <dir>/<arm>/<id>.prompt.txt
 *   node scripts/admin/replay-story-world.js arc-prompts --db=... --out=<dir> <storyId>...
 *       the arc-create prompt (buildArcCreatePrompt) -> <dir>/arc/<id>.prompt.txt
 *   node scripts/admin/replay-story-world.js parse-writer --out=<dir> --arm=<name> <storyId>...
 *       <dir>/<arm>/<id>.answer.txt -> <id>.pages.json (parseRefinedText, as beatsPipeline parses it)
 *   node scripts/admin/replay-story-world.js parse-arc --out=<dir> <storyId>...
 *       <dir>/arc/<id>.answer.txt -> <id>.owed.json (parseArcCreate: the OWED list the text stages read)
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const phase = args[0];
const opt = (k) => (args.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1];
const ids = args.slice(1).filter(a => !a.startsWith('--'));
const out = opt('out');
const arm = opt('arm');
if (!out) throw new Error('--out=<dir> required');

async function loadStory(id) {
  const { Pool } = require('pg');
  const url = opt('db') === 'staging' ? process.env.STAGING_DATABASE_URL : process.env.DATABASE_URL;
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  try {
    const r = await pool.query('SELECT data FROM stories WHERE id = $1', [id]);
    if (!r.rows.length) throw new Error(`story ${id} not found`);
    return typeof r.rows[0].data === 'string' ? JSON.parse(r.rows[0].data) : r.rows[0].data;
  } finally { await pool.end(); }
}

(async () => {
  const { loadPromptTemplates } = require('../../server/services/prompts');
  await loadPromptTemplates();
  const PB = require('../../server/lib/promptBuilders');
  const { resolveReplayInputData, buildReplayTextArgs } = require('../../server/lib/beatsReplayInputs');
  const { resolveStoryBeats } = require('../../server/lib/testlab');
  const { getPageText, extractSceneMetadata, parseBeats } = require('../../server/lib/storyHelpers');
  for (const id of ids) {
    if (phase === 'writer-prompts') {
      const storyData = resolveReplayInputData(await loadStory(id));
      const { beats } = resolveStoryBeats(storyData, { getPageText, extractSceneMetadata });
      const a = buildReplayTextArgs(storyData, beats, { parseBeats });
      const prompt = PB.buildStoryTextFromBeatsPrompt(storyData, a.beats, a.expansions, a.arc, { arcHints: a.arcHints, storyLogic: a.storyLogic, visualBible: storyData.visualBible, clothingRequirements: storyData.clothingRequirements });
      if (!prompt) throw new Error('writer template unavailable');
      if (/\{[A-Z_]{4,}\}/.test(prompt)) console.warn(`${id}: UNFILLED placeholder(s): ${[...new Set(prompt.match(/\{[A-Z_]{4,}\}/g))].join(', ')}`);
      fs.mkdirSync(path.join(out, arm), { recursive: true });
      fs.writeFileSync(path.join(out, arm, `${id}.prompt.txt`), prompt);
      console.log(`${id}: writer prompt ${prompt.length} chars, ${a.beats.length} pages, owed lines ${PB.buildOwedFacts(a.storyLogic).split('\n').length}`);
    } else if (phase === 'arc-prompts') {
      const storyData = resolveReplayInputData(await loadStory(id));
      const pages = (storyData.sceneImages || []).length || storyData.pages || 10;
      const { section } = PB.drawChallengeIdeas(storyData, {});
      const prompt = PB.buildArcCreatePrompt(storyData, pages, { challengeIdeas: section });
      fs.mkdirSync(path.join(out, 'arc'), { recursive: true });
      fs.writeFileSync(path.join(out, 'arc', `${id}.prompt.txt`), prompt);
      console.log(`${id}: arc prompt ${prompt.length} chars, ${pages} pages`);
    } else if (phase === 'parse-writer') {
      const raw = fs.readFileSync(path.join(out, arm, `${id}.answer.txt`), 'utf8');
      const stored = PB.parseRefinedText;
      const beats = (raw.match(/---\s*Page\s+(\d+)\s*---/gi) || []).map(m => Number(m.match(/\d+/)[0]));
      const parsed = stored(raw, beats.length ? beats : [], 'STORY TEXT', ['TITLE']);
      fs.writeFileSync(path.join(out, arm, `${id}.pages.json`), JSON.stringify({ pages: parsed.pages, missing: parsed.missing }, null, 1));
      console.log(`${id}: ${parsed.pages.length} pages parsed, missing ${parsed.missing.join(',') || 'none'}`);
    } else if (phase === 'parse-arc') {
      const raw = fs.readFileSync(path.join(out, 'arc', `${id}.answer.txt`), 'utf8');
      const parsed = PB.parseArcCreate(raw);
      fs.writeFileSync(path.join(out, 'arc', `${id}.owed.json`), JSON.stringify({ owed: parsed.logic.owed, facts: parsed.logic.text }, null, 1));
      console.log(`${id}: owed ${parsed.logic.owed.length}`);
    } else throw new Error(`unknown phase ${phase}`);
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
