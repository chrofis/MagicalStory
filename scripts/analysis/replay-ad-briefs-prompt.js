#!/usr/bin/env node
/**
 * RUNG 0 for any Art Director page-brief change (docs/decisions.md 2026-10-06): rebuild the CALL-2 prompt
 * (promptBuilders.buildSceneBriefsAllPrompt) for a STORED staging story with the CURRENT templates and cover beats, and
 * write it to a file for an agent-as-model run (.claude/skills/running-prompts-on-agents). No model call.
 *
 *   node scripts/analysis/replay-ad-briefs-prompt.js <storyId> <out.txt> [--dotenv=<path>]
 *
 * Inputs read from the story: the character/clothing data, the arc, the Visual Bible and the story pages' plan lines with
 * their FIXED lines, all as the run stored them (sceneExpansionReport.prompts[0]); the COVER plan lines are rebuilt by
 * coverBeats.buildCoverBeats (the cover wording is what is under test), with the stored cover FIXED lines under them.
 * Then `--check <reply.txt>` runs the brief checks over an agent's reply: negation_named (sceneBriefCheck) per page.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '../..');
const argv = process.argv.slice(2);
const dotenvArg = argv.find(a => a.startsWith('--dotenv='));
require('dotenv').config({ path: dotenvArg ? dotenvArg.slice(10) : path.join(ROOT, '.env') });
// A worktree has no .env: fall back to the main checkout's.
if (!process.env.STAGING_DATABASE_URL) require('dotenv').config({ path: path.join(ROOT, '../../../.env') });

/** The stored call-2 prompt split into page blocks: { '1': 'PLAN line', FIXED text }. */
function storedBlocks(prompt) {
  const start = prompt.indexOf('ALL LOCKED PLAN LINES');
  const end = prompt.indexOf('**CHARACTER DETAILS', start);
  const section = prompt.slice(prompt.indexOf('\n', start) + 1, end);
  const blocks = {};
  for (const b of section.split(/\n(?=## Page -?\d+\n)/)) {
    const m = b.match(/^## Page (-?\d+)\nPLAN: ([^\n]*)\n?([\s\S]*)$/);
    if (m) blocks[m[1]] = { planLine: m[2], fixed: m[3].replace(/\s+$/, '') };
  }
  return blocks;
}

/** The prompt, rebuilt: real builder, current templates and cover beats, stored FIXED lines. */
async function rebuild(d) {
  const { loadPromptTemplates } = require('../../server/services/prompts');
  await loadPromptTemplates();
  const PB = require('../../server/lib/promptBuilders');
  const { buildCoverBeats } = require('../../server/lib/coverBeats');
  const { coverTypesFor } = require('../../server/lib/coverKeys');
  const stored = d.sceneExpansionReport.prompts[0].prompt;
  const blocks = storedBlocks(stored);
  const cover = buildCoverBeats(d, { coverTypes: coverTypesFor(d), clothingRequirements: d.clothingRequirements || null, centralFigure: (d.arcReviewReport && d.arcReviewReport.centralFigure) || null, placeDecided: true });
  const beats = [
    ...Object.keys(blocks).filter(n => Number(n) > 0).map(Number).sort((a, b) => a - b).map(n => ({ pageNumber: n, planLine: blocks[n].planLine })),
    ...cover.map(c => ({ pageNumber: c.pageNumber, planLine: c.planLine })),
  ];
  const arc = stored.slice(stored.indexOf('\n\n', stored.indexOf('# THE STORY (for judgment')) + 2, stored.indexOf('**ALL LOCKED PLAN LINES')).trim();
  const vbAt = stored.indexOf('```json', stored.indexOf('**THE VISUAL BIBLE'));
  const vb = stored.slice(vbAt + 7, stored.indexOf('```', vbAt + 7)).trim();
  let prompt = PB.buildSceneBriefsAllPrompt(d, beats, { maxCharactersPerScene: 6, finalArc: arc, clothingRequirements: d.clothingRequirements, visualBible: vb });
  // The stored FIXED lines, back under each plan line.
  for (const b of beats) {
    const fixed = blocks[b.pageNumber] && blocks[b.pageNumber].fixed;
    if (!fixed) continue;
    const head = `## Page ${b.pageNumber}\nPLAN: ${b.planLine}`;
    if (!prompt.includes(head)) throw new Error(`page ${b.pageNumber}: plan block not found in the rebuilt prompt`);
    prompt = prompt.replace(head, () => `${head}\n${fixed}`);
  }
  return { prompt, beats, cover };
}

// A sceneIntent that mentions the copy band (it describes the picture only): the band's position words, or the book's text.
const COPY_ECHO = /\b(?:top|bottom|upper|lower)\s+(?:third|fifth|tenth|band|strip)\b|\b(?:empty|clear|bare|blank|open)\b[^.]{0,40}\b(?:third|fifth|tenth|band|space)\b|\bcopy\b|\b(?:title|lettering)\b/i;

/** Per-page brief text of an agent reply, and the covers' copy-space-as-absence findings. */
function coverIntentFindings(reply) {
  const out = [];
  for (const part of reply.split(/\n(?=## Page -?\d+\n)/)) {
    const m = part.match(/^## Page (-?\d+)\n/);
    if (!m || Number(m[1]) > 0) continue;
    const meta = (() => { try { return JSON.parse(part.split('---METADATA---')[1].replace(/```(?:json)?/g, '').trim()); } catch { return null; } })();
    const intent = meta && meta.sceneIntent;
    out.push({ page: Number(m[1]), sceneIntent: intent || null, copySpaceEcho: COPY_ECHO.test(intent || '') });
  }
  return out;
}

module.exports = { storedBlocks, rebuild, coverIntentFindings };

if (require.main === module) {
  (async () => {
    const checkAt = argv.indexOf('--check');
    if (checkAt >= 0) {
      const findings = coverIntentFindings(fs.readFileSync(argv[checkAt + 1], 'utf8'));
      console.log(JSON.stringify(findings, null, 1));
      return;
    }
    const [storyId, out] = argv.filter(a => !a.startsWith('--'));
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL });
    const r = await pool.query('select data from stories where id = $1', [storyId]);
    await pool.end();
    if (!r.rows[0]) throw new Error(`story ${storyId} not found`);
    const { prompt, cover } = await rebuild(r.rows[0].data);
    if (/\{[A-Z_]{4,}\}/.test(prompt)) throw new Error(`unfilled placeholder: ${(prompt.match(/\{[A-Z_]{4,}\}/) || [])[0]}`);
    fs.writeFileSync(out, prompt);
    console.log(`${prompt.length} chars -> ${out}\n` + cover.map(c => `p${c.pageNumber}: ${c.planLine}`).join('\n'));
  })().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
}
