'use strict';
/**
 * FREE replay of the staging book review's parse -> route -> plan chain over a STORED book.
 * No model call, no image call. Reads the story (read-only) from DATABASE_URL, takes a stored
 * reviewer reply (the `raw` field of a JSON file, or a file of fault lines), and prints which
 * page would get which repair method with which instruction.
 *
 *   node scripts/analysis/replay-book-review-routes.js <storyId> <rawJson|linesTxt> [--tagged]
 *
 * With --tagged the file is read as hand-written lines that already carry the route bracket;
 * without it the stored reply (which predates the route tag) is parsed as it is, so every
 * IMG line shows as "no route".
 */
require('dotenv').config();
const fs = require('fs');
const { Pool } = require('pg');
const { parseRoutes, parseBetterVerdicts } = require('../../server/lib/bookAudit');
const bookReview = require('../../server/lib/bookReview');
const { buildRepairNameMap } = require('../../server/lib/repairLogic');

async function main() {
  const [storyId, file] = process.argv.slice(2);
  if (!storyId || !file) throw new Error('usage: replay-book-review-routes.js <storyId> <file>');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const { rows } = await pool.query('SELECT data FROM stories WHERE id = $1', [storyId]);
  await pool.end();
  if (!rows[0]) throw new Error(`story ${storyId} not found`);
  const story = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;

  const text = fs.readFileSync(file, 'utf8');
  const raw = file.endsWith('.json') ? JSON.parse(text).raw : text;
  const parsed = parseRoutes(raw);
  console.log(`story ${storyId}: ${(story.characters || []).length} characters, ${(story.sceneImages || []).length} pages stored`);
  console.log(`reply: ${parsed.IMG.length} IMG fault(s), ${parsed.TEXT.length} TEXT fault(s); routed IMG lines: ${parsed.IMG.filter(f => f.route).length}`);

  const nameMap = buildRepairNameMap({
    characters: story.characters || [], visualBible: story.visualBible || null,
    clothingRequirements: story.clothingRequirements || null, artStyle: story.artStyle || null,
  });
  const { byPage } = bookReview.groupFaultsByPage(parsed.IMG);
  for (const [page, faults] of [...byPage.entries()].sort((a, b) => a[0] - b[0])) {
    const choice = bookReview.chooseMethod(faults);
    console.log(`\np${page}: ${choice.method ? choice.method : 'NO REPAIR'} — ${choice.reason}`);
    for (const u of choice.unroutable) console.log(`    unroutable (no fix route, not repaired): [${u.severity}] ${u.detail}`);
    if (choice.method === 'inpaint') {
      const plan = bookReview.buildTouchupPlan(choice.faults, nameMap);
      if (plan.scene_fix) console.log(`    scene fix [${plan.scene_fix.severity}] types=${plan.scene_fix.types.join('/') || '-'}: ${plan.scene_fix.instruction}`);
      for (const p of plan.per_character_fixes) console.log(`    fix for ${p.characterName} (${p.visual_identifier}) [${p.severity}]: ${p.fix_instruction}`);
    } else if (choice.method === 'iterate') {
      for (const f of bookReview.buildFixableIssues(choice.faults)) console.log(`    redraw brief [${f.severity}] ${f.type || '-'}: ${f.fix}`);
    } else if (choice.method === 'char-fix') {
      console.log(`    character: ${choice.charName}; types=${choice.issueTypes.join('/') || '-'}`);
      for (const f of choice.faults) console.log(`    [${f.severity}]: ${f.detail}`);
    }
  }
  const verdicts = parseBetterVerdicts(raw);
  if (verdicts.size) console.log('\nverdicts', JSON.stringify([...verdicts]));
}
main().catch(e => { console.error(e.message); process.exit(1); });
