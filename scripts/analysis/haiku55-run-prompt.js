#!/usr/bin/env node
/**
 * Send a stored prompt file to a TEXT_MODELS key through the production text
 * path (callTextModelStreaming) and write the reply, the model id the API
 * reported and the priced usage next to it. Used by the 2026-10-08 Haiku 5.5
 * bake-off (docs/decisions.md 2026-10-08); the arms and numbers are in
 * evals/results/results.jsonl.
 *
 *   node scripts/analysis/haiku55-run-prompt.js <promptFile> <outFile> [--model claude-haiku-5-5] [--effort medium] [--reps 1]
 */
'use strict';
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

(async () => {
  const [promptFile, outFile, ...rest] = process.argv.slice(2);
  const flag = (n, d) => { const i = rest.indexOf('--' + n); return i >= 0 ? rest[i + 1] : d; };
  const model = flag('model', 'claude-haiku-5-5');
  const effort = flag('effort', 'medium');
  const reps = Number(flag('reps', '1'));
  const { callTextModelStreaming } = require('../../server/lib/textModels');
  const { priceUsage } = require('../../server/config/models');
  const prompt = fs.readFileSync(promptFile, 'utf8');
  for (let i = 1; i <= reps; i++) {
    const res = await callTextModelStreaming(prompt, null, null, model, { usageLabel: 'haiku55_bakeoff', effort });
    const out = reps > 1 ? outFile.replace(/(\.\w+)$/, `_r${i}$1`) : outFile;
    fs.writeFileSync(out, res.text || '');
    const meta = { model, effort, modelId: res.modelId, stop_reason: res.stop_reason || null, usage: res.usage, usd: priceUsage(res.modelId || '', res.usage || {}), truncation: res.truncation?.suspected || false };
    fs.writeFileSync(out + '.meta.json', JSON.stringify(meta, null, 1));
    console.log(out, JSON.stringify(meta));
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
