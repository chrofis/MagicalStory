#!/usr/bin/env node
/**
 * Lector (text proofread) recall on a KEYED set: the injected-grammar stories of
 * evals/datasets/jev-text-audit-v1 (one mutated sentence per story, the original
 * sentence is the key). The prompt is the production lector's own
 * (buildTextProofreadPrompt) and the findings are read by the production
 * parser (parseLectorFindings); only the model differs.
 *
 *   node scripts/analysis/haiku55-lector-eval.js --model claude-haiku-5-5 --effort medium --rep 1 [--n 12] [--originals 3]
 *   node scripts/analysis/haiku55-lector-eval.js --model gemini-3.1-pro --rep 1      # production lector, LECTOR_OPTS as shipped
 *
 * Hit (loose): a finding on the mutated page whose quote overlaps the mutated
 * sentence. Hit (exact): that finding's correction equals the original sentence.
 * False positive: a finding whose quote is not the mutated sentence (on the
 * mutated page or on an original-only story) and whose quote exists on its page.
 * Output: evals/runs/2026-10-08_haiku55/lector/<model>_<effort>_r<rep>.json
 */
'use strict';
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const model = flag('model', 'claude-haiku-5-5');
const effort = flag('effort', model.startsWith('claude') ? 'medium' : '');
const rep = Number(flag('rep', '1'));
const N = Number(flag('n', '12'));
const NORIG = Number(flag('originals', '3'));
const REAL = flag('real', '') === '1'; // real labelled pages (real_labels.json) instead of injected stories

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

(async () => {
  const { loadPromptTemplates } = require('../../server/services/prompts');
  await loadPromptTemplates();
  const { buildTextProofreadPrompt } = require('../../server/lib/promptBuilders');
  const { parseLectorFindings, LECTOR_OPTS } = require('../../server/lib/textRefine');
  const { callTextModelStreaming } = require('../../server/lib/textModels');
  const { priceUsage, TEXT_MODELS } = require('../../server/config/models');
  if (!TEXT_MODELS[model]) throw new Error('unknown model ' + model);

  const rows = fs.readFileSync(path.resolve(__dirname, '../../evals/datasets/jev-text-audit-v1/items.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const sentences = rows.filter(r => r.check === 'grammar' && r.unit === 'sentence' && r.kind === 'injected');
  const stories = rows.filter(r => r.check === 'grammar' && r.unit === 'story' && r.language === 'de-ch');
  // injected: one per (kind) round robin, deterministic by id
  const injected = stories.filter(r => r.kind === 'injected').sort((a, b) => a.id.localeCompare(b.id));
  const byKind = {};
  for (const r of injected) {
    const s = sentences.find(x => x.story === r.story && x.pageNumber === r.pageNumber && r.state.includes(x.meta.mutated));
    if (!s) continue;
    (byKind[s.meta.kind] ||= []).push({ item: r, mutated: s.meta.mutated, original: s.meta.original, kind: s.meta.kind });
  }
  const picked = [];
  for (let i = 0; picked.length < N; i++) {
    let any = false;
    for (const k of Object.keys(byKind).sort()) { if (byKind[k][i] && picked.length < N) { picked.push(byKind[k][i]); any = true; } }
    if (!any) break;
  }
  const originals = stories.filter(r => r.kind === 'original').sort((a, b) => a.id.localeCompare(b.id)).slice(0, NORIG).map(item => ({ item, kind: 'original' }));

  if (REAL) {
    // REAL defects: pages of real stories labelled by reading them (jev-text-audit-v1 real_labels.json).
    // Each page goes to the lector ALONE; hit = a finding quoting text on a page labelled with a GRAM_ id.
    const pageItems = rows.filter(r => r.check === 'grammar' && r.unit === 'page' && (r.kind === 'real' || r.kind === 'real_writer') && r.language === 'de-ch').sort((a, b) => a.id.localeCompare(b.id));
    const pos = pageItems.filter(r => r.positive.length);
    const neg = pageItems.filter(r => !r.positive.length).slice(0, Number(flag('negatives', String(pos.length))));
    picked.length = 0; originals.length = 0;
    for (const item of pos) picked.push({ item, mutated: null, original: null, kind: 'real-positive', realPositive: true });
    for (const item of neg) originals.push({ item, kind: 'real-clean' });
  }
  const pagesOf = (state) => [...state.matchAll(/--- Page (\d+) ---\n([\s\S]*?)(?=\n--- Page \d+ ---|$)/g)].map(m => ({ pageNumber: Number(m[1]), text: m[2].trim() }));
  const results = [];
  let usd = 0;
  for (const c of [...picked, ...originals]) {
    const pages = REAL ? [{ pageNumber: c.item.pageNumber, text: c.item.state.replace(/^--- Page \d+ ---\n/, '').trim() }] : pagesOf(c.item.state);
    const prompt = buildTextProofreadPrompt({ language: c.item.language }, pages);
    const opts = model.startsWith('claude') ? { usageLabel: 'haiku55_lector', ...(effort ? { effort } : {}) } : { ...LECTOR_OPTS, usageLabel: 'haiku55_lector_ref' };
    let res;
    try { res = await callTextModelStreaming(prompt, null, null, model, opts); } catch (e) { results.push({ id: c.item.id, kind: c.kind, error: e.message }); continue; }
    const cost = priceUsage(res.modelId || '', res.usage || {});
    usd += cost;
    const findings = parseLectorFindings(res.text || '');
    const onPage = (f) => (pages.find(p => p.pageNumber === f.pageNumber)?.text || '');
    const real = findings.filter(f => norm(onPage(f)).includes(norm(f.quote)));
    const isMut = (f) => c.mutated && f.pageNumber === c.item.pageNumber && (norm(c.mutated).includes(norm(f.quote)) || norm(f.quote).includes(norm(c.mutated)));
    const hit = real.find(isMut);
    results.push({
      id: c.item.id, story: c.item.story, kind: c.kind, page: c.item.pageNumber, modelId: res.modelId, stop: res.stop_reason || null,
      findings: findings.length, quoteAbsent: findings.length - real.length,
      hitLoose: c.realPositive ? real.length > 0 : (c.mutated ? !!hit : null),
      hitExact: c.realPositive ? null : (c.mutated ? !!(hit && norm(hit.correction) === norm(c.original)) : null),
      falsePositives: c.realPositive ? 0 : real.filter(f => !isMut(f)).length,
      positiveFindings: c.realPositive ? real.map(f => ({ q: f.quote.slice(0, 140), c: String(f.correction).slice(0, 140) })) : undefined,
      cleanFindings: c.kind === 'real-clean' ? real.map(f => ({ q: f.quote.slice(0, 140), c: String(f.correction).slice(0, 140) })) : undefined,
      fpExamples: real.filter(f => !isMut(f)).slice(0, 3).map(f => ({ p: f.pageNumber, q: f.quote.slice(0, 120), c: String(f.correction).slice(0, 120) })),
      usd: cost, outputTokens: res.usage?.output_tokens, ms: res.usage?.elapsed_ms,
    });
    console.log(c.kind, c.item.id, 'hit', results[results.length - 1].hitLoose, 'fp', results[results.length - 1].falsePositives, '$' + cost.toFixed(4));
  }
  const inj = results.filter(r => r.hitLoose !== null && !r.error);
  const summary = {
    model, effort: effort || null, rep, injectedItems: inj.length,
    hitLoose: inj.filter(r => r.hitLoose).length, hitExact: inj.filter(r => r.hitExact).length,
    realPositivePagesHit: results.filter(r => r.kind === 'real-positive' && r.hitLoose).length, realPositivePages: results.filter(r => r.kind === 'real-positive').length,
    realCleanPagesWithFindings: results.filter(r => r.kind === 'real-clean' && r.findings > 0).length, realCleanPages: results.filter(r => r.kind === 'real-clean').length,
    falsePositivesInjected: inj.reduce((a, r) => a + r.falsePositives, 0),
    originalItems: results.filter(r => r.kind === 'original' && !r.error).length,
    falsePositivesOriginal: results.filter(r => r.kind === 'original').reduce((a, r) => a + (r.falsePositives || 0), 0),
    errors: results.filter(r => r.error).length, usd,
    byKind: Object.fromEntries(Object.keys(byKind).map(k => [k, `${inj.filter(r => r.kind === k && r.hitLoose).length}/${inj.filter(r => r.kind === k).length}`])),
  };
  const dir = path.resolve(__dirname, '../../evals/runs/2026-10-08_haiku55/lector');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${model}_${effort || 'default'}${REAL ? '_real' : ''}_r${rep}.json`), JSON.stringify({ summary, results }, null, 1));
  console.log(JSON.stringify(summary));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
