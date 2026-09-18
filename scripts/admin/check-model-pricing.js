#!/usr/bin/env node
/**
 * Is server/config/models.js still charging what the vendors charge?
 *
 * WHY THIS EXISTS — 2026-09-18 (backlog #27). MODEL_PRICING is hand-maintained
 * against rates that move, and nothing ever re-read them. deepseek-v4-pro sat at
 * 0.435/0.87 while OpenRouter billed 1.60/3.20 — 3.68x under, on the reviewer for
 * three stages — so every per-story cost figure that included it was low, and the
 * "DeepSeek is a tenth of Opus" argument that chose it was computed from the
 * wrong number. tests/unit/model-pricing-integrity.test.ts pins the shape of the
 * table; only a live fetch can tell you a well-formed number is wrong.
 *
 * Three independent checks, none of which costs a paid model call:
 *   1. PUBLISHED  — OpenRouter's catalogue (free, no auth) and xAI's models API
 *                   (needs XAI_API_KEY) vs the table, per model.
 *   2. BILLED     — with --db, the effective rate implied by real spend:
 *                   stories.data.tokenUsage.byFunction buckets that carry BOTH
 *                   the provider's own direct_cost and the token counts.
 *   3. STALENESS  — how long ago PRICING_VERIFIED_ON says someone last looked.
 *
 * Anthropic and Google publish prices only as HTML, so they are listed as
 * "check by hand" with the URL rather than guessed at.
 *
 *   node scripts/admin/check-model-pricing.js
 *   node scripts/admin/check-model-pricing.js --db=prod      # + derived rates
 *   node scripts/admin/check-model-pricing.js --db=staging --warn-only
 */
'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });

const { MODEL_PRICING, TEXT_MODELS, PRICING_VERIFIED_ON } = require(path.join(ROOT, 'server/config/models'));

const TOLERANCE = 0.02;               // 2% — rounding in a catalogue, not drift
const STALE_DAYS = 90;

const args = process.argv.slice(2);
const dbArg = (args.find((a) => a.startsWith('--db')) || '').split('=')[1] || (args.includes('--db') ? 'prod' : null);
const warnOnly = args.includes('--warn-only');

const MANUAL_SOURCES = {
  anthropic: 'https://platform.claude.com/docs/en/about-claude/pricing',
  google: 'https://ai.google.dev/gemini-api/docs/pricing',
};

let problems = 0;
const flag = (line) => { problems++; console.log(`  ✗ ${line}`); };
const ok = (line) => console.log(`  ✓ ${line}`);

const off = (a, b) => (b === 0 ? (a === 0 ? 0 : Infinity) : Math.abs(a - b) / b);

async function getJson(url, headers) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

/** Which TEXT_MODELS provider routes each modelId (that is whose price applies). */
function providerByModelId() {
  const m = new Map();
  for (const cfg of Object.values(TEXT_MODELS)) if (cfg.modelId) m.set(cfg.modelId, cfg.provider);
  return m;
}

async function checkOpenRouter(routedBy) {
  console.log('\n── PUBLISHED: OpenRouter catalogue (GET /api/v1/models)');
  let catalogue;
  try {
    catalogue = await getJson('https://openrouter.ai/api/v1/models');
  } catch (e) {
    return flag(`could not reach OpenRouter: ${e.message}`);
  }
  const byId = new Map(catalogue.data.map((m) => [m.id, m]));

  for (const [key, price] of Object.entries(MODEL_PRICING)) {
    if (price.perImage) continue;
    if (!key.includes('/')) continue;                 // vendor-direct id, not an OpenRouter slug
    const live = byId.get(key);
    if (!live) { flag(`${key}: NOT IN THE CATALOGUE — no source for its price, and calls to it have no route`); continue; }
    const pIn = Number(live.pricing.prompt) * 1e6;
    const pOut = Number(live.pricing.completion) * 1e6;
    if (off(price.input, pIn) > TOLERANCE || off(price.output, pOut) > TOLERANCE) {
      flag(`${key}: table $${price.input}/$${price.output}, OpenRouter $${pIn.toFixed(4)}/$${pOut.toFixed(4)}` +
           `  (in x${(pIn / price.input).toFixed(2)}, out x${(pOut / price.output).toFixed(2)})`);
    } else {
      ok(`${key}  $${pIn.toFixed(4)}/$${pOut.toFixed(4)}`);
    }
  }

  // The class of bug that made grok-4.6 free: wired up, never priced.
  for (const [name, cfg] of Object.entries(TEXT_MODELS)) {
    if (cfg.provider !== 'openrouter' || !cfg.modelId) continue;
    if (MODEL_PRICING[cfg.modelId]) continue;
    const live = byId.get(cfg.modelId);
    const says = live
      ? `$${(Number(live.pricing.prompt) * 1e6).toFixed(4)}/$${(Number(live.pricing.completion) * 1e6).toFixed(4)}`
      : 'not in the catalogue either';
    flag(`${name} -> ${cfg.modelId}: NO MODEL_PRICING ENTRY, so it bills as $0.00 — OpenRouter says ${says}`);
  }
  void routedBy;
}

async function checkXai() {
  console.log('\n── PUBLISHED: xAI models API (GET https://api.x.ai/v1/models)');
  const key = process.env.XAI_API_KEY;
  if (!key) return console.log('  (skipped — XAI_API_KEY not set)');
  let live;
  try {
    live = await getJson('https://api.x.ai/v1/models', { Authorization: `Bearer ${key}` });
  } catch (e) {
    return flag(`could not reach xAI: ${e.message}`);
  }
  // xAI reports integers; value / 10_000 = USD per 1M tokens, and
  // image_price / 1e10 = USD per image.
  const byId = new Map();
  for (const m of live.data) {
    byId.set(m.id, m);
    for (const a of m.aliases || []) byId.set(a, m);
  }
  for (const [key2, price] of Object.entries(MODEL_PRICING)) {
    if (key2.includes('/')) continue;
    if (!/^grok/.test(key2)) continue;
    const m = byId.get(key2);
    if (!m) { flag(`${key2}: xAI does not serve this id — its price cannot be verified and calls to it 404`); continue; }
    if (price.perImage !== undefined) {
      // grok.js requests resolution '1k' everywhere and sets no quality tier, so
      // compare against the 1k rows. `image_price` at the top level is the 2k /
      // medium figure on some models, which is not what this repo is charged.
      const tiers1k = (m.pricing || []).filter((r) => String(r.resolution).toLowerCase() === '1k');
      const rates = (tiers1k.length ? tiers1k.map((r) => Number(r.price_per_image)) : [Number(m.image_price)])
        .filter(Number.isFinite).map((v) => v / 1e10).sort((a, b) => a - b);
      if (!rates.length) { console.log(`  · ${key2}: no per-image figure in the API response`); continue; }
      const span = rates[0] === rates[rates.length - 1] ? `$${rates[0].toFixed(4)}` : `$${rates[0].toFixed(4)}-$${rates[rates.length - 1].toFixed(4)}`;
      const matches = rates.some((r) => off(price.perImage, r) <= TOLERANCE);
      if (!matches) flag(`${key2}: table $${price.perImage}/image, xAI 1k tiers ${span}`);
      else ok(`${key2}  ${span}/image at 1k (table: $${price.perImage})`);
    } else {
      const pIn = m.prompt_text_token_price / 1e4;
      const pOut = m.completion_text_token_price / 1e4;
      if (off(price.input, pIn) > TOLERANCE || off(price.output, pOut) > TOLERANCE) {
        flag(`${key2}: table $${price.input}/$${price.output}, xAI $${pIn.toFixed(4)}/$${pOut.toFixed(4)}`);
      } else ok(`${key2}  $${pIn.toFixed(4)}/$${pOut.toFixed(4)}`);
    }
  }
}

async function checkBilled(which) {
  console.log(`\n── BILLED: effective rates from stored usage (${which})`);
  const url = which === 'staging' ? process.env.STAGING_DATABASE_URL : process.env.DATABASE_URL;
  if (!url) return flag(`no database URL for "${which}"`);
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  try {
    const { rows } = await pool.query(
      `SELECT data->'tokenUsage'->'byFunction' AS bf
         FROM stories
        WHERE data ? 'tokenUsage' AND created_at > NOW() - INTERVAL '120 days'
        ORDER BY created_at DESC LIMIT 400`
    );
    const agg = new Map();
    for (const r of rows) {
      for (const fn of Object.values(r.bf || {})) {
        // Solvable only when the provider reported what it charged AND the
        // bucket names exactly one model.
        if (!fn?.calls || !(fn.direct_cost > 0)) continue;
        const models = Array.isArray(fn.models) ? fn.models : [];
        if (models.length !== 1) continue;
        const inTok = fn.input_tokens || 0;
        const outTok = (fn.output_tokens || 0) + (fn.thinking_tokens || 0);
        if (!(inTok + outTok)) continue;
        const a = agg.get(models[0]) || { in: 0, out: 0, cost: 0, calls: 0 };
        a.in += inTok; a.out += outTok; a.cost += fn.direct_cost; a.calls += fn.calls;
        agg.set(models[0], a);
      }
    }
    if (!agg.size) return console.log('  (no bucket carried both a reported cost and token counts)');
    for (const [model, a] of [...agg.entries()].sort((x, y) => y[1].cost - x[1].cost)) {
      const price = MODEL_PRICING[model];
      if (!price || price.perImage) { console.log(`  · ${model}: billed $${a.cost.toFixed(4)} over ${a.calls} calls — no token entry to compare`); continue; }
      const predicted = (a.in * price.input + a.out * price.output) / 1e6;
      const ratio = predicted === 0 ? Infinity : a.cost / predicted;
      const line = `${model}: ${a.calls} calls, billed $${a.cost.toFixed(4)}, table predicts $${predicted.toFixed(4)} (actual/predicted ${ratio.toFixed(3)})`;
      // 15%: prompt-cache hits and route mixing move this a little; a wrong rate moves it a lot.
      if (Math.abs(ratio - 1) > 0.15) flag(line);
      else ok(line);
    }
  } catch (e) {
    flag(`database check failed: ${e.message}`);
  } finally {
    await pool.end();
  }
}

function checkStaleness() {
  console.log('\n── STALENESS');
  const days = Math.floor((Date.now() - Date.parse(PRICING_VERIFIED_ON)) / 86400000);
  const line = `PRICING_VERIFIED_ON = ${PRICING_VERIFIED_ON} (${days} days ago)`;
  if (days > STALE_DAYS) flag(`${line} — over ${STALE_DAYS} days; re-read the vendor pages and bump it`);
  else ok(line);
  console.log('\n── NOT MACHINE-CHECKABLE (HTML only — open these and compare by hand)');
  for (const [vendor, url] of Object.entries(MANUAL_SOURCES)) {
    const ids = Object.entries(TEXT_MODELS)
      .filter(([, c]) => c.provider === vendor && c.modelId)
      .map(([, c]) => c.modelId);
    console.log(`  ${vendor}: ${url}`);
    console.log(`    ${[...new Set(ids)].join(', ')}`);
  }
}

(async () => {
  console.log('MODEL_PRICING vs the vendors — nothing here makes a paid model call.');
  const routedBy = providerByModelId();
  await checkOpenRouter(routedBy);
  await checkXai();
  if (dbArg) await checkBilled(dbArg);
  checkStaleness();
  console.log(`\n${problems === 0 ? 'No drift found.' : `${problems} problem(s) above.`}`);
  process.exit(problems && !warnOnly ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
