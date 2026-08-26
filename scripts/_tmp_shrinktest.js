// Verify shrinkPromptForModel on the real p5 prompt (9439 chars, budget 7500).
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  const r = await pool.query(`SELECT data->'sceneImages'->4->>'prompt' AS p FROM stories WHERE id='job_1786397108357_q1fjbdzbx'`);
  await pool.end();
  const prompt = r.rows[0].p;
  const images = require('../server/lib/images');
  // shrinkPromptForModel isn't exported — reach it via a tiny eval-free re-require trick:
  // test through the exported surface instead if absent.
  const fn = images.shrinkPromptForModel || images._internals?.shrinkPromptForModel;
  if (!fn) { console.log('NOT EXPORTED — add export'); process.exit(2); }
  const out = await fn(prompt, 7500, 'shrink-test', 'grok-imagine-image');
  console.log('in:', prompt.length, '→ out:', out.length);
  console.log('ART STYLE kept:', out.includes('**ART STYLE:**'));
  console.log('OBJECTS kept:', out.includes('REQUIRED OBJECTS'));
  console.log('key object kept:', out.includes('iron key'));
  console.log('all 5 characters:', ['Emma','Noah','Daniel','Sarah','Hans'].map(n => n + '=' + out.includes(n)).join(' '));
  require('fs').writeFileSync('C:/Users/roger/AppData/Local/Temp/claude/C--Users-roger-MagicalStory/5e638703-ea7b-4f0b-86a3-c96876a22612/scratchpad/run6/p5-shrunk.txt', out);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
