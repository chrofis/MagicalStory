#!/usr/bin/env node
require('dotenv').config();
const pg = require('pg');

const jobId = process.argv[2] || 'job_1769251765157_a4qh1nzza';
const pageNum = parseInt(process.argv[3] || '15', 10);

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

(async () => {
  // Try stories table first (finished stories), then story_jobs (in-progress)
  let result = await pool.query(
    `SELECT data->'sceneDescriptions'->${pageNum - 1} as scene FROM stories WHERE id = $1`,
    [jobId]
  );

  if (!result.rows.length || !result.rows[0].scene) {
    result = await pool.query(
      `SELECT result_data->'sceneDescriptions'->${pageNum - 1} as scene FROM story_jobs WHERE id = $1`,
      [jobId]
    );
  }

  if (result.rows.length > 0 && result.rows[0].scene) {
    const scene = result.rows[0].scene;

    // Parse the description JSON from the markdown code block
    const descMatch = scene.description.match(/```json\n([\s\S]*?)\n```/);
    if (descMatch) {
      const parsed = JSON.parse(descMatch[1]);

      console.log(`=== PAGE ${pageNum} ===`);
      console.log('Scene Summary (input):', scene.outlineExtract);
      console.log();
      console.log('Location:', parsed.output.setting.location);
      console.log('Indoor/Outdoor:', parsed.output.setting.indoorOutdoor);
      console.log('Description:', parsed.output.setting.description);
      console.log('Camera:', parsed.output.setting.camera);
      console.log('DepthLayers:', parsed.output.setting.depthLayers);
      console.log();
      console.log('Characters:');
      parsed.output.characters.forEach(c => {
        console.log(`  - ${c.name}: ${c.position}`);
        console.log(`    Pose: ${c.pose}`);
        console.log(`    Action: ${c.action}`);
      });
      console.log();
      console.log('Objects:');
      parsed.output.objects.forEach(o => {
        console.log(`  - ${o.name}: ${o.position}`);
      });
      console.log();
      console.log('Critique issues:', parsed.critique.issues.length > 0 ? parsed.critique.issues : 'None');
    }
  } else {
    console.log('Scene not found');
  }

  await pool.end();
})();
