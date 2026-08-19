#!/usr/bin/env node
/**
 * Pre-push tripwire: a Gemini 3.x model on Google's NATIVE API must not be given
 * sampling parameters.
 *
 * WHY — Google deprecated `temperature`, `top_p` and `top_k` on 2026-07-21,
 * starting with Gemini 3.6 Flash and 3.5 Flash-Lite. On those models the
 * parameters are SILENTLY IGNORED, and a later model generation returns HTTP
 * 400. Their guidance is to steer determinism through system instructions.
 *
 * Why it matters HERE specifically: this repo pins `temperature: 0` on every
 * judgment call precisely so eval tuning is reproducible (docs/decisions.md,
 * "temperature: 0 is not determinism" and the EVAL_TEMPERATURE note in
 * config/models.js). There are 61 `temperature:` settings under server/. The
 * moment an eval call site is repointed at a 3.x model, its temperature: 0 stops
 * doing anything — with no error and no log line — and every measurement built
 * on it silently degrades. That is not a failure you notice; it is one you
 * discover months later in a variance experiment.
 *
 * SCOPE — deliberately narrow, so this passes today and fires exactly at the
 * migration:
 *   - only models reaching Google's NATIVE endpoint (provider/backend gemini),
 *     because a 3.x model behind OpenRouter is that vendor's problem, not ours;
 *   - only entries that actually carry a sampling parameter.
 * Today `gemini-3.7-flash` and `gemini-3.1-pro` are provider:'openrouter' and so
 * are correctly ignored.
 *
 * Usage:
 *   node scripts/admin/check-gemini-sampling.js          # gate
 *   node scripts/admin/check-gemini-sampling.js --list   # show what was scanned
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const models = require(path.join(ROOT, 'server/config/models'));

const IS_GEMINI_3 = (id) => /^gemini-3(\.\d+)?[-.]/.test(String(id || '')) || /^gemini-3$/.test(String(id || ''));
const SAMPLING = ['temperature', 'topP', 'top_p', 'topK', 'top_k'];
const NATIVE = (m) => {
  const via = String(m?.provider || m?.backend || '').toLowerCase();
  return via === 'gemini' || via === 'google';
};

// BLOCKING for text/eval models, WARNING for image models — on purpose.
// The determinism this protects is an EVAL property: temperature 0 is pinned on
// every judgment call so tuning is reproducible. An image model's temperature is
// a quality knob, not a guarantee, and stripping it there is not a no-op — the
// call site reads `IMAGE_MODELS[id]?.temperature ?? 0.8`, so deleting 0.5 would
// silently become 0.8 if that model were ever pointed at a backend that honours
// it. Not a change to make unasked, so it is reported, not enforced.
const failures = [];
const warnings = [];
const scanned = [];

const scanTable = (label, table) => {
  for (const [key, m] of Object.entries(table || {})) {
    if (!m || typeof m !== 'object') continue;
    const id = m.modelId || key;
    if (!IS_GEMINI_3(id)) continue;
    const native = NATIVE(m);
    const params = SAMPLING.filter(p => m[p] !== undefined);
    scanned.push({ label, key, id, native, params });
    if (native && params.length) {
      const msg = `${label}.${key} (modelId "${id}") reaches Google's native API and sets ${params.join(', ')}. ` +
        `Gemini 3.x ignores sampling parameters silently and a later generation returns HTTP 400 — remove them ` +
        `and steer via system instructions.`;
      (label === 'IMAGE_MODELS' ? warnings : failures).push(msg);
    }
  }
};

scanTable('TEXT_MODELS', models.TEXT_MODELS);
scanTable('IMAGE_MODELS', models.IMAGE_MODELS);
scanTable('MODELS', models.MODELS);

if (process.argv.includes('--list')) {
  if (!scanned.length) console.log('no Gemini 3.x model configured anywhere');
  for (const s of scanned) {
    console.log(`${s.label}.${s.key.padEnd(28)} id=${String(s.id).padEnd(30)} native=${s.native ? 'YES' : 'no '} sampling=${s.params.join(',') || '(none)'}`);
  }
}

for (const w of warnings) console.warn(`check-gemini-sampling: WARN — ${w}`);

if (failures.length) {
  console.error('\n✗ GEMINI 3.x SAMPLING PARAMETERS\n');
  for (const f of failures) console.error(`  • ${f}`);
  console.error('\nSee docs/decisions.md 2026-08-19 ("temperature: 0 is not determinism").\n');
  process.exit(1);
}

console.log(`check-gemini-sampling: OK (${scanned.length} Gemini 3.x model(s) scanned, ${warnings.length} warning(s), no eval/text path affected)`);
