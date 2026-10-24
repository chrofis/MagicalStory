#!/usr/bin/env node
/**
 * Free replay (USD 0, no model call): over STORED visual bibles, how many reference-sheet batches the real
 * buildReferenceSheetBatches + referenceSheetBatchModel route to vbStateCellModel (Grok 2, $0.04) after the
 * 2026-10-24 change (docs/decisions.md). Reports batches and stories, and extra cost per story (Grok 2 $0.04 vs
 * Grok 1 pageImage price, per MODEL_PRICING).
 * Usage: node scripts/analysis/replay-state-sheet-routing.js [--limit 200]
 */
require('dotenv').config();
const { Pool } = require('pg');
const argv = process.argv.slice(2);
const LIMIT = parseInt((argv.indexOf('--limit') >= 0 ? argv[argv.indexOf('--limit') + 1] : '200'), 10);
const RS = require('../../server/lib/referenceSheets');
const { getElementsNeedingReferenceImages } = require('../../server/lib/visualBible');
const { MODEL_DEFAULTS, IMAGE_MODELS } = require('../../server/config/models');

const SQL = `select id, (data->>'trialMode') as trial, data->'visualBible' as vb from stories
  where data->'visualBible' is not null and jsonb_typeof(data->'visualBible')='object'
  order by created_at desc nulls last limit $1`;

(async () => {
  const rows = [];
  for (const [label, url] of [['staging', process.env.STAGING_DATABASE_URL], ['prod', process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL]]) {
    if (!url) { console.log(`[skip] ${label}`); continue; }
    const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
    try { rows.push(...(await pool.query(SQL, [LIMIT])).rows.map(r => ({ ...r, env: label }))); } finally { await pool.end(); }
  }
  const { MODEL_PRICING } = require('../../server/config/models');
  const price = (k) => MODEL_PRICING?.[IMAGE_MODELS[k]?.modelId]?.perImage ?? null;
  let stories = 0, withState = 0, batchesTotal = 0, stateBatches = 0, stateCells = 0, mixed = 0;
  const per = [];
  for (const row of rows) {
    const vb = row.vb;
    let need;
    try { need = getElementsNeedingReferenceImages(vb, 2, 1, 1); } catch (e) { continue; }
    const batches = RS.buildReferenceSheetBatches(need, vb, 4);
    stories++; batchesTotal += batches.length;
    const sb = batches.filter(b => RS.referenceSheetBatchModel(b, null) === MODEL_DEFAULTS.vbStateCellModel && RS.isStateCellBatch(b));
    if (batches.some(b => !RS.isStateCellBatch(b) && b.some(c => c.stateName))) mixed++;
    if (sb.length) { withState++; per.push(sb.length); }
    stateBatches += sb.length; stateCells += sb.reduce((n, b) => n + b.length, 0);
  }
  console.log(`stories replayed: ${stories} (${rows.filter(r => r.env === 'staging').length} staging, ${rows.filter(r => r.env === 'prod').length} prod)`);
  console.log(`stories with >=1 state batch: ${withState}/${stories} (${(100 * withState / stories).toFixed(1)}%)`);
  console.log(`state batches: ${stateBatches}/${batchesTotal} (${(100 * stateBatches / batchesTotal).toFixed(1)}%), state cells ${stateCells}, mixed batches ${mixed}`);
  console.log(`state batches per affected story: mean ${(per.reduce((a, b) => a + b, 0) / (per.length || 1)).toFixed(2)}, max ${Math.max(0, ...per)}`);
  console.log(`price/image: grok-imagine-2 ${price('grok-imagine-2')}, pageImage(${MODEL_DEFAULTS.pageImage}) ${price(MODEL_DEFAULTS.pageImage)}`);
})();
