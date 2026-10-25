/**
 * Pyjama (nightwear) sheets on 20 stored staging characters: the REAL generateOneCallSheet (kind costume, MODEL_DEFAULTS refs face+body),
 * description = the real TRIAL_NIGHTWEAR text (server/config/trialCostumes.js getTrialNightwear, by gender). Generation only: the sheet
 * judge needs GEMINI_API_KEY (none available), so judge acceptance is NOT measured. USD 0.04/call, cap USD 0.80 here.
 * Run with the Master keys preloaded: node -r <preload> evals/runs/2026-10-25_pyjama-sheets/run.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });
const fs = require('fs'); const path = require('path');
const { Pool } = require('pg');
const { loadPromptTemplates } = require('../../../server/services/prompts');
const { generateOneCallSheet } = require('../../../server/lib/character2x4Sheet');
const { getTrialNightwear } = require('../../../server/config/trialCostumes');
const PRICE = 0.04, CAP = 0.80, CONC = 4;
const LEDGER = path.join(__dirname, 'ledger.jsonl');
(async () => {
  await loadPromptTemplates();
  const sel = JSON.parse(fs.readFileSync(path.join(__dirname, 'selection.json'), 'utf8'));
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  let spend = 0; try { spend = fs.readFileSync(LEDGER, 'utf8').trim().split('\n').filter(Boolean).reduce((s, l) => s + (JSON.parse(l).ok ? JSON.parse(l).usd : 0), 0); } catch {}
  const fails = [];
  const queue = sel.filter(s => !fs.existsSync(path.join(__dirname, `${s.id}.jpg`)));
  async function work(s) {
    if (spend + PRICE > CAP + 1e-9 || fails.length >= 3) return;
    const r = await pool.query("select c from characters, jsonb_array_elements(data->'characters') c where id=$1 and c->>'id'=$2", [s.row, String(s.id)]);
    const ch = r.rows[0].c;
    const nw = getTrialNightwear({ storyCategory: 'life-challenge', storyTopic: 'going-to-bed', gender: ch.gender });
    spend += PRICE; // reserve before the call: a failed call may still be billed
    try {
      const res = await generateOneCallSheet(ch, { artStyle: 'watercolor', kind: 'costume', costumeDescription: nw.description });
      fs.writeFileSync(path.join(__dirname, `${s.id}.jpg`), Buffer.from(String(res.imageData).replace(/^data:image\/\w+;base64,/, ''), 'base64'));
      fs.appendFileSync(LEDGER, JSON.stringify({ ts: new Date().toISOString(), id: s.id, name: s.name, age: s.age, gender: s.gender, desc: nw.description, usd: PRICE, ok: true }) + '\n');
      console.log('ok', s.name, s.age, 'spend', spend.toFixed(2));
    } catch (e) {
      fails.push(e.message); fs.appendFileSync(LEDGER, JSON.stringify({ ts: new Date().toISOString(), id: s.id, name: s.name, usd: PRICE, ok: false, err: e.message.slice(0, 300) }) + '\n');
      console.log('FAIL', s.name, e.message.slice(0, 200));
    }
  }
  for (let i = 0; i < queue.length; i += CONC) await Promise.all(queue.slice(i, i + CONC).map(work));
  await pool.end(); console.log('done spend', spend.toFixed(2));
})().catch(e => { console.error(e); process.exit(1); });
