'use strict';
// Verify Part 1: cover eval gated by title mode.
// Mode A (title required) should flag "missing title text" on textless art;
// Mode B (textless note) should NOT. Runs on the showcase front cover v0.
require('dotenv').config();
const { Pool } = require('pg');
(async () => {
  const storyId = 'job_1784404956456_ggvjxti9d';
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const sres = await pool.query('SELECT data FROM stories WHERE id=$1', [storyId]);
  let d = sres.rows[0].data; if (typeof d === 'string') d = JSON.parse(d);
  const ir = await pool.query("SELECT image_url FROM story_images WHERE story_id=$1 AND image_type='frontCover' AND version_index=0", [storyId]);
  const url = ir.rows[0].image_url;
  await pool.end();
  const { loadPromptTemplates } = require('../../server/services/prompts'); await loadPromptTemplates();
  const { evaluateImageQuality } = require('../../server/lib/images');
  const cover = d.coverImages.frontCover;
  const basePrompt = cover.description || cover.prompt || '';
  const title = d.title;
  const refs = cover.referencePhotos || [];
  const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
  const img = `data:image/jpeg;base64,${buf.toString('base64')}`;

  const modeA = basePrompt + `\n\nTEXT REQUIREMENT - CRITICAL: The image MUST include this exact title text: "${title}"`;
  const modeB = basePrompt + '\n\nTEXT NOTE: This cover art is intentionally textless. The title, dedication, and "magicalstory.ch" branding are composited by the app after generation and are NOT part of the image you are evaluating. Never flag missing or absent title/dedication/branding text as a defect.';

  for (const [label, prompt] of [['MODE_A (title required)', modeA], ['MODE_B (textless note)', modeB]]) {
    const res = await evaluateImageQuality(img, prompt, refs, 'scene', null, `cover-${label}`, null, null, null,
      { complianceModelOverride: 'qwen3-max' });
    const issues = (res?.fixableIssues || res?.threeStageResult?.fixableIssues || []).map(i => i.description || i.issue || i);
    const titleFlag = issues.filter(i => /title|text|Loslassen/i.test(String(i)));
    console.log(`\n=== ${label} ===`);
    console.log(`  score=${res?.score} quality=${res?.qualityScore} semantic=${res?.semanticScore}`);
    console.log(`  TITLE/TEXT flags: ${titleFlag.length ? titleFlag.map(x=>String(x).slice(0,90)).join(' | ') : 'NONE ✅'}`);
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
