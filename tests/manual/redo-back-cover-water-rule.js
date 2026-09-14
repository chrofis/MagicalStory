/**
 * Regenerate the back cover of prod story job_1789227389389_z18dmvnt6 with the
 * new cover solid-ground exception in place.
 *
 * WHAT THIS DOES AND DOES NOT TEST
 * It reuses the story's STORED cover hint, which already names the open-water
 * location and the lit quay lamp. So it tests rule A only — the water/air
 * exception added to prompts/cover-composition.txt. Rule B (a cover backdrop
 * must be a LOC the cast can stand in, and its props must belong there) acts
 * when the Art Director AUTHORS the hint, which this does not re-run.
 *
 * The question: given the same contradictory brief that produced a dry cobbled
 * quay with a lit gas lamp underwater, does the exception stop the model
 * inventing paved ground?
 *
 * Paid: one cover generation.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const OUT = 'C:/Users/roger/AppData/Local/Temp/claude/C--Users-roger-MagicalStory/7c09c544-3c41-4f8c-9a49-e4d09a0c3db8/scratchpad/img';
const JOB = 'job_1789227389389_z18dmvnt6';
const DRY = process.argv.includes('--dry');

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const r = await pool.query('select data from stories where data::text like $1 limit 1', ['%' + JOB + '%']);
  await pool.end();
  const storyData = r.rows[0].data;

  // Prove the rule is in the template the run will use.
  const tpl = fs.readFileSync(path.join(__dirname, '..', '..', 'prompts', 'cover-composition.txt'), 'utf8');
  const exceptions = (tpl.match(/Unless the scene is set in water or in the air/g) || []).length;
  console.log(`cover-composition.txt sections carrying the water/air exception: ${exceptions} (want 3)`);
  if (exceptions !== 3) { console.log('ABORT: the rule is not in the template'); process.exit(1); }

  const hint = storyData.coverHints?.backCover || storyData.coverHints?.back || null;
  console.log('stored back-cover hint:', JSON.stringify(hint).slice(0, 400));

  if (DRY) { console.log('--dry: stopping before the paid call.'); return; }

  const { iterateCover } = require('../../server/lib/coverIterate.js');
  const usage = [];
  const t0 = Date.now();
  const res = await iterateCover('backCover', storyData, {
    usageTracker: (provider, tokens, label, model) => usage.push({ provider, label, model }),
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(0);

  const data = res?.imageData || res?.image || res?.output;
  if (!data) { console.log('no image returned; keys:', Object.keys(res || {}).join(',')); return; }
  const b64 = String(data).replace(/^data:image\/\w+;base64,/, '');
  const file = path.join(OUT, 'new_backcover.jpg');
  fs.writeFileSync(file, Buffer.from(b64, 'base64'));
  console.log(`OK in ${secs}s → ${file} (${Math.round(fs.statSync(file).size / 1024)} KB), ${usage.length} model call(s)`);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
