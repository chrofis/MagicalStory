/**
 * One-shot dry run of the post-repair DIFF pass (2026-09-06) against the STORED
 * before/after pairs of a finished story — no story is regenerated, no repair
 * pass re-runs. Same four production calls the pass makes in textRefine.js:
 * buildTextDiffPrompt → callTextModelStreaming(textDiffModel) →
 * parseLectorFindings → applyLectorFindings.
 *
 *   node scripts/analysis/dry-run-text-diff.js <storyId>
 */
require('dotenv').config();
const { Pool } = require('pg');

(async () => {
  const storyId = process.argv[2];
  if (!storyId) throw new Error('usage: dry-run-text-diff.js <storyId>');
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const q = await pool.query('select data from stories where id=$1', [storyId]);
  await pool.end();
  const data = q.rows[0].data;
  const rep = data.textRefineReport;

  const { loadPromptTemplates } = require('../../server/services/prompts');
  await loadPromptTemplates();
  const { buildTextDiffPrompt } = require('../../server/lib/storyHelpers');
  const { callTextModelStreaming } = require('../../server/lib/textModels');
  const { parseLectorFindings, applyLectorFindings } = require('../../server/lib/textRefine');
  const { TEXT_MODELS, MODEL_DEFAULTS, calculateTextCost } = require('../../server/config/models');

  const changed = rep.changedPages || [];
  const pairs = rep.pages.filter(p => changed.includes(p.pageNumber))
    .map(p => ({ pageNumber: p.pageNumber, before: p.before, after: p.after }));
  const pages = rep.pages.map(p => ({ pageNumber: p.pageNumber, text: p.after }));

  const modelKey = MODEL_DEFAULTS.textDiffModel;
  const prompt = buildTextDiffPrompt({ language: data.language }, pairs);
  console.log(`pairs: ${pairs.map(p => p.pageNumber).join(', ')} | model ${modelKey} | prompt ${prompt.length} chars`);
  const t0 = Date.now();
  const r = await callTextModelStreaming(prompt, null, null, modelKey, { temperature: 0, usageLabel: 'text_diff_dryrun' });
  const raw = String(r.text || '').trim();
  console.log('\n===== RAW =====\n' + raw + '\n===============');
  const findings = parseLectorFindings(raw);
  const res = applyLectorFindings(pages, findings);
  console.log('\nfindings:', JSON.stringify(findings, null, 1));
  console.log('applied:', res.applied.map(a => `p${a.pageNumber} "${a.quote}" -> "${a.correction}"`));
  console.log('dropped:', res.dropped.map(d => `p${d.pageNumber} "${d.quote}" (${d.reason})`));
  const cost = r.usage?.direct_cost ?? calculateTextCost(r.modelId || TEXT_MODELS[modelKey].modelId, r.usage || {});
  console.log(`\n${((Date.now() - t0) / 1000).toFixed(0)}s, in ${r.usage?.input_tokens} out ${r.usage?.output_tokens}, $${Number(cost).toFixed(4)}`);
})().catch(e => { console.error(e); process.exit(1); });
