// Builds the REAL arc-panel prompt (buildArcPanelPrompt, as arc_panel_replay does)
// for every stored arc, once with the current code ("new") and once with the
// obstacle clause removed ("old" = the prompt as it was before 2026-11-07).
// Free: DB reads only. usage: node build-prompts.js <ids.json> <outDir>
require('dotenv').config({ path: 'C:/Users/roger/MagicalStory/.env' });
const path = require('path'); const fs = require('fs');
const ROOT = 'C:/Users/roger/MagicalStory';
const { Pool } = require(ROOT + '/node_modules/pg');
const { loadPromptTemplates } = require(ROOT + '/server/services/prompts');
const PB = require(ROOT + '/server/lib/promptBuilders');
const { resolveReplayInputData } = require(ROOT + '/server/lib/beatsReplayInputs');

const [idsFile, outDir] = process.argv.slice(2);
const rows = JSON.parse(fs.readFileSync(idsFile, 'utf8'));
const OLD_SEVERITY = 'a want or quarrel given and never answered, an action at the turn';
const NEW_SEVERITY = 'a want or quarrel given and never answered, an obstacle that the climax act of the main character does not remove, an action at the turn';

(async () => {
  await loadPromptTemplates();
  const pools = { prod: new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }),
                  staging: new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } }) };
  fs.mkdirSync(outDir + '/new', { recursive: true }); fs.mkdirSync(outDir + '/old', { recursive: true });
  const manifest = []; const failed = [];
  for (const r of rows) {
    let data = null;
    for (const env of r.envs.split('+')) {
      const q = await pools[env].query('SELECT data FROM stories WHERE id=$1', [r.id]);
      if (q.rows[0] && q.rows[0].data && q.rows[0].data.arcReviewReport && q.rows[0].data.arcReviewReport.committed) { data = q.rows[0].data; break; }
    }
    if (!data) { failed.push({ id: r.id, why: 'no stored arcReviewReport.committed' }); continue; }
    const inputData = resolveReplayInputData(data);
    const committed = String(data.arcReviewReport.committed).trim();
    const nw = PB.buildArcPanelPrompt(inputData, committed);
    if (!nw || /\{[A-Z_]{4,}\}/.test(nw.replace(committed, ''))) { failed.push({ id: r.id, why: 'unfilled placeholder or null' }); continue; }
    let old = nw.split(' ' + PB.OBSTACLE_REMOVED_BY_CLIMAX_RULE).join('').split(PB.OBSTACLE_REMOVED_BY_CLIMAX_RULE + ' ').join('').replace(NEW_SEVERITY, OLD_SEVERITY);
    if (old === nw || old.includes('OBSTACLE') || old.includes('climax act of the main character')) { failed.push({ id: r.id, why: 'old build mismatch' }); continue; }
    const k = r.id.split('_')[2];
    fs.writeFileSync(`${outDir}/new/${k}.txt`, nw); fs.writeFileSync(`${outDir}/old/${k}.txt`, old);
    manifest.push({ k, id: r.id });
  }
  fs.writeFileSync(outDir + '/manifest.json', JSON.stringify(manifest, null, 1));
  console.log('built', manifest.length, 'failed', JSON.stringify(failed));
  await pools.prod.end(); await pools.staging.end();
})().catch(e => { console.error(e); process.exit(1); });
