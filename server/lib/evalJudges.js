// server/lib/evalJudges.js
// Multi-judge orchestration for image evaluation.
//
// The PRIMARY judge (Gemini) runs inside evaluateImageQuality exactly as before.
// This module runs the EXTRA judges (Grok, Qwen) on the SAME image parts + eval
// prompt, parses each one's fixable_issues, and hands them back so the caller can
// merge all judges via evalBuckets (pure-median per bucket).
//
// Gated by EVAL_JUDGES (default 'gemini' → runExtraJudges returns [] → the caller
// keeps the single-judge path → ZERO behaviour change in prod). Any judge that
// errors or has no API key is skipped (logged), never throws — the jury degrades
// to whoever answered.
const { log } = require('../utils/logger');
const { withRetry } = require('./textModels');
const { TEXT_MODELS } = require('../config/models');

// EVAL_JUDGES=gemini            (default — single judge, no jury)
//            =gemini,grok
//            =gemini,grok,qwen
function getEvalJudges() {
  const raw = (process.env.EVAL_JUDGES || 'gemini')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const seen = new Set(); const out = [];
  for (const j of raw) if (!seen.has(j)) { seen.add(j); out.push(j); }
  return out.length ? out : ['gemini'];
}

// Judge key → model registry key (server/config/models.js TEXT_MODELS).
const JUDGE_MODEL = { grok: 'grok-4-fast', qwen: 'qwen-vl' };

// OpenRouter vision call — mirrors callGrokVisionAPI (Gemini parts → OpenAI
// image_url content), returns the raw text or null on any failure.
async function callOpenRouterVisionAPI(modelId, geminiParts) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) { log.warn('[EVAL JUDGE] OPENROUTER_API_KEY unset — skipping Qwen judge'); return null; }
  const content = [];
  for (const part of geminiParts) {
    if (part.inline_data) content.push({ type: 'image_url', image_url: { url: `data:${part.inline_data.mime_type};base64,${part.inline_data.data}` } });
    else if (part.text) content.push({ type: 'text', text: part.text });
  }
  // Same fastest-provider routing the text path uses: OpenRouter's published p50
  // throughput spans ~18x across providers for one model, and a judge drawing
  // the slow tier stalls the whole eval. Null on lookup failure → sort only.
  const fastOrder = await require('./openrouterRouting').fastProviderOrder(modelId).catch(() => null);
  const res = await withRetry(async () => fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: modelId, max_tokens: 8192, temperature: 0, messages: [{ role: 'user', content }],
      provider: fastOrder ? { order: fastOrder, allow_fallbacks: true } : { sort: 'throughput' },
    }),
    signal: AbortSignal.timeout(120000),
  }), { maxRetries: 2, baseDelay: 2000 });
  if (!res.ok) { log.warn(`[EVAL JUDGE] OpenRouter ${modelId} HTTP ${res.status} — skipping this judge`); return null; }
  const j = await res.json();
  return j.choices?.[0]?.message?.content || '';
}

// Tolerant extraction of fixable_issues[] from a judge's raw JSON text.
function parseFixableIssues(text) {
  if (!text || typeof text !== 'string') return [];
  const t = text.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return [];
  let parsed;
  try { parsed = JSON.parse(t.slice(a, b + 1)); } catch { return []; }
  if (!Array.isArray(parsed.fixable_issues)) return [];
  return parsed.fixable_issues.filter(i => i && i.description).map(i => ({
    description: i.description,
    severity: i.severity || 'MODERATE',
    type: i.type || 'default',
    character: i.character || null,
    fix: i.fix || `Fix: ${i.description}`,
  }));
}

/**
 * Run the extra (non-gemini) judges on the same eval parts, in parallel.
 * @returns {Promise<Array<{judge, model, fixableIssues}>>} — only judges that answered.
 */
async function runExtraJudges({ parts, judges }) {
  const extras = judges.filter(j => j !== 'gemini' && JUDGE_MODEL[j]);
  if (!extras.length) return [];
  const results = await Promise.all(extras.map(async (judge) => {
    const modelKey = JUDGE_MODEL[judge];
    const cfg = TEXT_MODELS[modelKey];
    if (!cfg) { log.warn(`[EVAL JUDGE] unknown model for judge '${judge}' — skipping`); return null; }
    try {
      let text = '';
      if (cfg.provider === 'xai') {
        const { callGrokVisionAPI } = require('./images'); // lazy: avoids load-time cycle
        const resp = await callGrokVisionAPI(modelKey, cfg.modelId, parts, '');
        if (resp?.ok) { const jj = await resp.json(); text = jj.candidates?.[0]?.content?.parts?.[0]?.text || ''; }
      } else if (cfg.provider === 'openrouter') {
        text = await callOpenRouterVisionAPI(cfg.modelId, parts);
      } else {
        log.warn(`[EVAL JUDGE] judge '${judge}' provider ${cfg.provider} not supported as a vision judge — skipping`);
        return null;
      }
      const fixableIssues = parseFixableIssues(text);
      log.info(`🧑‍⚖️ [EVAL JUDGE] ${judge} (${modelKey}) → ${fixableIssues.length} issues`);
      return { judge, model: modelKey, fixableIssues };
    } catch (e) {
      log.warn(`[EVAL JUDGE] ${judge} failed (${e.message}) — skipping this judge`);
      return null;
    }
  }));
  return results.filter(Boolean);
}

module.exports = { getEvalJudges, runExtraJudges, callOpenRouterVisionAPI, parseFixableIssues, JUDGE_MODEL };
