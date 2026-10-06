#!/usr/bin/env node
/**
 * Free replay of the FIRST-DIVISION planner prompt (promptBuilders.buildBeatsPrompt, the production beats planner) over a
 * STORED staging story, and the count of an agent's reply with the real counters — for agent-as-model runs
 * (.claude/skills/running-prompts-on-agents). No model call. docs/decisions.md 2026-10-06 "Every named figure leads a page".
 *
 *   node scripts/analysis/replay-beats-prompt.js build <storyId> <out.txt>   write the planner prompt
 *   node scripts/analysis/replay-beats-prompt.js count <storyId> <reply.txt> per-figure pages in the planner's reply
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '../..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
if (!process.env.STAGING_DATABASE_URL) require('dotenv').config({ path: path.join(ROOT, '../../../.env') });

/** The reply's lead/coverage numbers per listed figure, counted by the production parsers and counters. */
function countReply(d, reply) {
  const PB = require('../../server/lib/promptBuilders');
  const CC = require('../../server/lib/castCoverage');
  const PC = require('../../server/lib/planCounters');
  const listed = (d.characters || []).map(c => String(c.name).trim()).filter(Boolean);
  const pageCount = parseInt(d.pages, 10) || (d.sceneImages || []).filter(s => s.pageNumber > 0).length;
  const parsed = PB.parsePlanResponse(reply, Array.from({ length: pageCount }, (_, i) => i + 1));
  if (parsed.missing.length) throw new Error(`reply misses page(s) ${parsed.missing.join(', ')}`);
  const table = CC.parsePlanCastBlock(reply, { listed });
  const cast = { all: listed, aliases: {} };
  const rows = parsed.pages.map(p => ({ pageNumber: p.pageNumber, present: PC.namesIn(PC.whoColumn(p.planLine), listed) }));
  const cov = CC.castCoverage({ pageCount, castCount: listed.length });
  const res = PC.castTablePromises({ rows, castTable: table, actions: null, cast,focalEach: !!(cov && cov.focalEach), leadEach: !!(cov && cov.leadEach) });
  const mainIds = Array.isArray(d.mainCharacters) ? d.mainCharacters : [];
  const mainName = ((d.characters || []).find(c => c.isMainCharacter === true || mainIds.includes(c.id)) || {}).name || listed[0];
  const per = {};
  for (const name of listed) {
    const inFrame = rows.filter(r => r.present.includes(name)).map(r => r.pageNumber);
    const focal = rows.filter(r => r.present.includes(name) && r.present.length <= 2).map(r => r.pageNumber);
    const entry = table.characters.find(c => c.name === name);
    const deed = entry ? entry.deedPage : null;
    const sharedWith = table.characters.filter(c => c.name !== name && c.deedPage === deed).map(c => c.name);
    per[name] = { inFrame: inFrame.length, focalPages: focal, deedPage: deed, deedSharedWith: sharedWith, leads: !!(deed && focal.includes(deed) && !sharedWith.length) };
  }
  const target = Math.ceil(pageCount / 2);
  return { pageCount, cov, mainName, mainPages: per[mainName] ? per[mainName].inFrame : null, mainFloor: target, perFigure: per, sharedLead: res.sharedLead, brokenPromises: res.broken.map(b => `${b.promise}:${b.page}:${b.name || ''}`) };
}

module.exports = { countReply };

if (require.main === module) {
  (async () => {
    const [mode, storyId, file] = process.argv.slice(2);
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL });
    const r = await pool.query('select data from stories where id = $1', [storyId]);
    await pool.end();
    if (!r.rows[0]) throw new Error(`story ${storyId} not found`);
    const d = r.rows[0].data;
    if (mode === 'count') { console.log(JSON.stringify(countReply(d, fs.readFileSync(file, 'utf8')), null, 1)); return; }
    const { loadPromptTemplates } = require('../../server/services/prompts');
    await loadPromptTemplates();
    const PB = require('../../server/lib/promptBuilders');
    const RI = require('../../server/lib/beatsReplayInputs');
    const { parseBeats } = PB;
    const pageCount = parseInt(d.pages, 10) || (d.sceneImages || []).filter(s => s.pageNumber > 0).length;
    const prompt = PB.buildBeatsPrompt(RI.resolveReplayInputData(d), pageCount, {
      finalArc: RI.resolveReplayArc(d, { parseBeats }), arcHints: RI.resolveReplayArcHints(d),
      centralFigure: RI.resolveReplayCentralFigure(d), storyLogic: RI.resolveReplayStoryLogic(d),
    });
    if (!prompt || /\{[A-Z_]{4,}\}/.test(prompt)) throw new Error(`prompt unavailable or unfilled: ${(prompt || '').match(/\{[A-Z_]{4,}\}/)}`);
    fs.writeFileSync(file, prompt);
    console.log(`${prompt.length} chars, ${pageCount} pages -> ${file}`);
  })().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
}
