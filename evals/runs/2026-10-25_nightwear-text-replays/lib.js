// Shared plumbing for the 2026-10-25 nightwear text replays.
// Keys: loaded at runtime from the owner's key file, never printed or written.
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '../../..');
process.chdir(ROOT);
require('dotenv').config({ path: path.join(ROOT, '.env') });
for (const line of fs.readFileSync('C:/Users/roger/Master/.env.txt', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^(ANTHROPIC_API_KEY|OPENROUTER_API_KEY)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
process.env.PGSSLMODE = 'no-verify';
const { Pool } = require('pg');

const CAP_USD = 2.60;
const LEDGER = path.join(__dirname, 'ledger.jsonl');

function spent() {
  if (!fs.existsSync(LEDGER)) return 0;
  return fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).reduce((a, l) => a + (JSON.parse(l).cost || 0), 0);
}

// Selection notes: selection/*.js (read-only SELECT surveys). Positives are the only stored stories whose plan
// lines or pages put someone in bed; negatives are plan-line-clean stories (no bed/pyjama/sleep word in any plan line).
const SETS = {
  positivesClean: [['prod', 'job_1792859316244_6429d0n83'], ['prod', 'job_1791918618204_ssjxzvmp4']],
  positivesProse: [['staging', 'job_1788725396265_p3dh87hsv'], ['staging', 'job_1778881997472_2plcswn7d'], ['prod', 'job_1792584180547_gr4cnr0u8']],
  negatives: [
    ['staging', 'job_1792482580699_3iiy0v4dj'], ['staging', 'job_1791315635053_t0t8qpebu'], ['staging', 'job_1791222889407_ypl33vk8u'],
    ['staging', 'job_1790536739048_ruynosw80'], ['staging', 'job_1790446348343_z3fw660ie'], ['staging', 'job_1789420511893_zly5rcdej'],
    ['staging', 'job_1788641639919_mpjwlzkf1'], ['staging', 'job_1788555701112_99txp8evx'], ['staging', 'job_1786998860057_o6deqtv5s'],
    ['staging', 'job_1786917840874_rur4nskfv'], ['prod', 'job_1792767471259_4b7gfwc04'], ['prod', 'job_1791786057698_79n8x82wd'],
    ['prod', 'job_1790747154374_7f2t99tk6'], ['prod', 'job_1790702181821_o8ynpdjw6'], ['staging', 'job_1789163494908_kc2joi4ax'],
  ],
};
const ALL = [
  ...SETS.positivesClean.map(([e, id]) => ({ env: e, id, kind: 'positive' })),
  ...SETS.positivesProse.map(([e, id]) => ({ env: e, id, kind: 'positive-prose' })),
  ...SETS.negatives.map(([e, id]) => ({ env: e, id, kind: 'negative' })),
];

const pools = {};
async function loadStory(env, id) {
  const url = env === 'prod' ? (process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL) : process.env.STAGING_DATABASE_URL;
  pools[env] = pools[env] || new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 2 });
  const r = await pools[env].query('SELECT data FROM stories WHERE id = $1', [id]); // SELECT only
  if (!r.rows.length) throw new Error('story not found ' + id);
  return typeof r.rows[0].data === 'string' ? JSON.parse(r.rows[0].data) : r.rows[0].data;
}
async function closePools() { for (const p of Object.values(pools)) await p.end(); }

// One paid call with a pre-call cap check and a ledger line from the response usage.
async function paidCall({ stage, storyId, prompt, model, opts = {}, outGuess }) {
  const { callTextModelStreaming } = require(ROOT + '/server/lib/textModels');
  const { priceUsage, TEXT_MODELS } = require(ROOT + '/server/config/models');
  const est = priceUsage(TEXT_MODELS[model].modelId, { input_tokens: Math.ceil(prompt.length / 3), output_tokens: outGuess });
  if (spent() + est > CAP_USD) throw Object.assign(new Error(`SPEND CAP: ${spent().toFixed(3)} + est ${est.toFixed(3)} > ${CAP_USD}`), { capStop: true });
  const res = await callTextModelStreaming(prompt, null, null, model, opts);
  const cost = priceUsage(res.modelId || TEXT_MODELS[model].modelId, res.usage || {});
  fs.appendFileSync(LEDGER, JSON.stringify({ ts: new Date().toISOString(), stage, storyId, model, modelId: res.modelId, usage: res.usage, cost, cumulative: +(spent() + cost).toFixed(4) }) + '\n');
  if (!String(res.text || '').trim() || res.usage?.output_tokens === 0) throw new Error(`empty response from ${model}`);
  return { res, cost };
}

async function pool(items, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

module.exports = { ROOT, CAP_USD, LEDGER, SETS, ALL, loadStory, closePools, paidCall, spent, pool };
