'use strict';
// Run a REAL Test Lab experiment: the `cover` stage with composite + borrowed
// background, exactly as the lab UI would (createExperiment → runStageOnTarget
// → store results). Routed to the STAGING DB so it shows in /admin/test-lab.
require('dotenv').config();
process.env.DATABASE_URL = process.env.STAGING_DATABASE_URL; // testlab writes → staging
const fs = require('fs');

const STORY_ID = 'job_1784404956456_ggvjxti9d';
const OUT = 'C:/Users/roger/AppData/Local/Temp/oil-experiment';

(async () => {
  const { runStageOnTarget } = require('../../server/lib/testlab');
  const { dbQuery, initializePool } = require('../../server/services/database');
  initializePool();

  const stage = 'cover';
  const target = { storyId: STORY_ID, coverType: 'initialPage' };
  const params = { composite: true, backgroundStoryId: STORY_ID, backgroundPage: 9, artStyle: 'oil' };
  const label = 'oil composite (borrowed bg p9) — feet-fix verification';

  const rows = await dbQuery(
    `INSERT INTO testlab_experiments (stage, label, prompt_override, params, status, targets, created_by)
     VALUES ($1, $2, NULL, $3, 'running', $4, $5) RETURNING id`,
    [stage, label, JSON.stringify(params), JSON.stringify([target]), 'assistant-verify']);
  const experimentId = rows[0].id;
  console.log(`experiment ${experimentId} created (stage=${stage}) — running...`);

  const startedAt = new Date().toISOString();
  let entry;
  try {
    const result = await runStageOnTarget(stage, target, { params, experimentId });
    entry = { ...target, ok: true, startedAt, ...result };
    console.log(`OK: versionIndex=${result.versionIndex} score=${JSON.stringify(result.scores)} model=${result.modelId} ${result.elapsedMs}ms`);
  } catch (err) {
    entry = { ...target, ok: false, startedAt, error: err.message };
    console.log(`FAILED: ${err.message}`);
  }
  await dbQuery(`UPDATE testlab_experiments SET results = results || $2::jsonb, status=$3, completed_at=NOW() WHERE id=$1`,
    [experimentId, JSON.stringify([entry]), entry.ok ? 'completed' : 'failed']);

  // Fetch the saved lab test version so we can show it locally too
  if (entry.ok && entry.versionIndex != null) {
    const img = await dbQuery(
      "SELECT image_url, image_data FROM story_images WHERE story_id=$1 AND image_type=$2 AND version_index=$3 AND is_test=true ORDER BY id DESC LIMIT 1",
      [STORY_ID, 'initialPage', entry.versionIndex]);
    const r = img[0];
    if (r) {
      const buf = r.image_url ? Buffer.from(await (await fetch(r.image_url)).arrayBuffer()) : Buffer.from(r.image_data, 'base64');
      fs.writeFileSync(`${OUT}/lab_cover_composite.jpg`, buf);
      console.log('saved lab_cover_composite.jpg');
    }
  }
  console.log(`\nLab experiment id: ${experimentId}`);
  console.log('View: https://staging.magicalstory.ch/admin/test-lab (experiment ' + experimentId + ')');
  process.exit(0);
})().catch(e => { console.error('ERR:', e.message, (e.stack || '').split('\n').slice(1, 3).join(' ')); process.exit(1); });
