'use strict';
/**
 * Recompute a stored story's cost with the current pricer (priceUsage) and show
 * the delta against what was booked. Read-only, no paid calls.
 *
 *   node scripts/analysis/recompute-story-cost.js staging <storyId> [<storyId>...]
 *   node scripts/analysis/recompute-story-cost.js prod <storyId>
 *
 * Stories stored before the per-call ledger (costLedger.js, 2026-10-08) keep
 * only per-function AGGREGATES, so a bucket that mixed models cannot be priced
 * per call; it is priced at each of its models and reported as a range, and the
 * old booking (first model of the set) is shown beside it. Stories recorded by
 * the ledger (bucket.ledger === 2) already carry their exact per-call cost.
 */
require('dotenv').config();
const { Pool } = require('pg');
const { priceUsage, pricingKnown } = require('../../server/config/models');

const env = process.argv[2];
const ids = process.argv.slice(3);
if (!['staging', 'prod'].includes(env) || ids.length === 0) {
  console.error('usage: recompute-story-cost.js <staging|prod> <storyId>...');
  process.exit(1);
}
const url = env === 'prod' ? process.env.DATABASE_URL : process.env.STAGING_DATABASE_URL;
const f = (n) => `$${n.toFixed(4)}`;

function priceBucket(b) {
  if (b.ledger === 2) return { low: b.cost || 0, high: b.cost || 0, note: 'ledger' };
  const usage = {
    input_tokens: b.input_tokens || 0, output_tokens: b.output_tokens || 0, thinking_tokens: b.thinking_tokens || 0,
    cached_input_tokens: b.cached_input_tokens || 0, cache_write_tokens: b.cache_write_tokens || 0,
  };
  if ((b.direct_cost || 0) > 0) return { low: b.direct_cost, high: b.direct_cost, note: 'provider charge' };
  const models = (b.models || []).filter(pricingKnown);
  if (!models.length) return { low: 0, high: 0, note: (b.models || []).length ? 'UNPRICED ' + b.models.join(',') : 'no model' };
  const perModel = models.map((m) => {
    // per-image models are priced per call; token models from the bucket tokens
    const per = priceUsage(m, { ...usage });
    return require('../../server/config/models').findModelPricing(m)?.perImage ? per * (b.calls || 0) : per;
  });
  return { low: Math.min(...perModel), high: Math.max(...perModel), note: models.length > 1 ? `mixed: ${models.join(' | ')}` : models[0] };
}

(async () => {
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  for (const id of ids) {
    const r = await pool.query("SELECT id, data->'tokenUsage' AS tu FROM stories WHERE id = $1", [id]);
    const tu = r.rows[0]?.tu;
    if (!tu?.byFunction) { console.log(`${id}: no tokenUsage`); continue; }
    let oldTotal = 0, newLow = 0, newHigh = 0;
    const rows = [];
    for (const [fn, b] of Object.entries(tu.byFunction)) {
      if (!(b.calls > 0)) continue;
      const old = b.cost != null ? b.cost : (b.direct_cost || 0);
      const nw = priceBucket(b);
      oldTotal += old; newLow += nw.low; newHigh += nw.high;
      rows.push({ fn, old, ...nw });
    }
    console.log(`\n=== ${env} ${id}: booked ${f(oldTotal)} -> recomputed ${f(newLow)}${newHigh > newLow + 1e-9 ? ' .. ' + f(newHigh) : ''}  (delta ${f(newLow - oldTotal)})`);
    for (const x of rows.filter((x) => Math.abs(x.low - x.old) > 0.0005 || Math.abs(x.high - x.low) > 0.0005).sort((a, b) => Math.abs(b.low - b.old) - Math.abs(a.low - a.old))) {
      console.log(`  ${x.fn.padEnd(34)} ${f(x.old)} -> ${f(x.low)}${x.high > x.low + 1e-9 ? '..' + f(x.high) : ''}  ${x.note}`);
    }
  }
  await pool.end();
})();
