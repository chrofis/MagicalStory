'use strict';
// Replay check (no model call, USD 0): render the PRODUCTION book-audit prompt for the 3 stored books of test I and
// compare its six per-story values with packets/bookNN/prompt-D2.txt (they must appear verbatim).
// Usage: node scripts/analysis/replay-book-audit-d3-fill.js   (needs STAGING_DATABASE_URL in .env)
require('dotenv').config();
const fs = require('fs'); const path = require('path'); const { Pool } = require('pg');
const REPO = path.resolve(__dirname, '../..');
const ROOT = path.join(REPO, 'evals/runs/2026-11-08_quality-tests-I');
const key = require(path.join(ROOT, 'key.json'));
const SIX = ['MAIN_CHARACTERS', 'LOGIC_OBSTACLE', 'LOGIC_KNOWLEDGE', 'LOGIC_PLACE', 'LOGIC_CONTRADICTION', 'BUY_CRITERION'];
(async () => {
  const prompts = require('../../server/services/prompts'); await prompts.loadPromptTemplates();
  const bookAudit = require('../../server/lib/bookAudit');
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  let bad = 0;
  for (const b of ['book13', 'book06', 'book15']) {
    const sd = (await pool.query('SELECT data FROM stories WHERE id=$1', [key.books[b].storyId])).rows[0].data;
    const fill = bookAudit.bookAuditStoryFill(sd);
    const chunk = (sd.sceneImages || []).filter(s => typeof s.pageNumber === 'number').map(s => ({ pageNumber: s.pageNumber, text: s.text, part: {}, brief: null }));
    const text = bookAudit.buildChunkInstructions(prompts.PROMPT_TEMPLATES.bookAudit, chunk, null, fill).instructions;
    const packet = fs.readFileSync(path.join(ROOT, 'packets', b, 'prompt-D2.txt'), 'utf8');
    const left = text.match(/\{[A-Z_]+\}/g);
    const res = SIX.map(k => `${k}:${packet.includes(fill[k]) && text.includes(fill[k]) ? 'ok' : 'DIFF'}`);
    if (left || res.some(r => r.endsWith('DIFF'))) bad++;
    console.log(b, key.books[b].storyId, res.join(' '), left ? 'LEFTOVER ' + left : 'no leftover placeholders');
  }
  await pool.end();
  if (bad) { console.error('FAIL'); process.exit(1); }
  console.log('ALL OK');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
