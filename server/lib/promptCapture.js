/**
 * Per-experiment prompt sink via AsyncLocalStorage.
 *
 * WHY: the Test Lab exists to judge prompts, but only a handful of its 33 stages
 * stored the prompt they actually sent — the rest showed a char count or nothing,
 * so "the model ignored a rule" and "we never sent that rule" looked identical.
 * Patching all 33 runners to stash their own prompt would guarantee drift: every
 * new stage would have to remember, and the ones that forgot would fail silently.
 *
 * So capture happens at the SAME chokepoints that already exist for accounting:
 * callTextModel / callTextModelStreaming for text, and the image-prompt entry
 * points. Any stage that sends a prompt gets it recorded, including stages nobody
 * has written yet. Mirrors usageContext.js exactly.
 *
 * Concurrency-safe: each experiment runs in its own async context, so parallel
 * redos never mix prompts.
 */
const { AsyncLocalStorage } = require('async_hooks');

const promptContext = new AsyncLocalStorage();

// One prompt can be the whole story draft; a stage can send many. Cap both so a
// runaway stage can't bloat the experiment row (results are JSONB).
const MAX_PROMPT_CHARS = 60000;
const MAX_PROMPTS = 40;

/**
 * Run `fn` with a fresh prompt collector active. Returns { result, prompts }.
 * If `fn` throws, the prompts collected before the throw are attached to the
 * error as `capturedPrompts` and it is rethrown — a failed run is exactly when
 * you need to see what was sent.
 */
async function runWithPromptCapture(fn) {
  const prompts = [];
  try {
    const result = await promptContext.run({ prompts }, fn);
    return { result, prompts };
  } catch (err) {
    if (err && typeof err === 'object') err.capturedPrompts = prompts;
    throw err;
  }
}

/**
 * Record one prompt sent during the active experiment. No-op outside one
 * (production pipeline, scripts, tests) and never throws — capture is a
 * debugging aid and must never break a render.
 *
 * @param {string} label - what this prompt is for (usageLabel, or a stage name)
 * @param {string} modelId - resolved model id, when known
 * @param {string} text - the prompt verbatim
 * @param {object} [extra] - e.g. { kind: 'image', aspect: '3:4' }
 */
function recordPrompt(label, modelId, text, extra = {}) {
  const store = promptContext.getStore();
  if (!store || !Array.isArray(store.prompts)) return;
  try {
    if (store.prompts.length >= MAX_PROMPTS) return;
    const t = typeof text === 'string' ? text : String(text ?? '');
    if (!t) return;
    store.prompts.push({
      label: label || 'prompt',
      modelId: modelId || null,
      chars: t.length,
      truncated: t.length > MAX_PROMPT_CHARS,
      text: t.length > MAX_PROMPT_CHARS ? t.slice(0, MAX_PROMPT_CHARS) + '\n…[truncated for storage]' : t,
      ...extra,
    });
  } catch {
    // never surface
  }
}

/** True when a capture context is active — lets callers skip expensive assembly. */
function isCapturing() {
  return !!promptContext.getStore();
}

module.exports = { runWithPromptCapture, recordPrompt, isCapturing };
