/**
 * Per-job usage sink via AsyncLocalStorage.
 *
 * Token/cost accounting was previously undercounting: every Claude/Gemini/Grok
 * text call had to remember to call the job's `addUsage(...)` closure, and most
 * didn't (or only conditionally). The Anthropic console showed ~10x the tokens
 * the pipeline logged (2026-07-12 investigation).
 *
 * This makes the text-model chokepoint (callTextModel / callTextModelStreaming
 * in textModels.js) the SINGLE source of truth: it records every call into the
 * sink the running job registered. Concurrency-safe — each story job runs in
 * its own async context, so concurrent jobs never share a sink. Mirrors the
 * AsyncLocalStorage pattern already used for styled-avatar cache scoping.
 */
const { AsyncLocalStorage } = require('async_hooks');

const usageContext = new AsyncLocalStorage();

/**
 * Register the job's addUsage sink for the current async context and every
 * descendant. Call once at the top of a generation pipeline, right after the
 * job's addUsage closure is defined.
 *
 * @param {(provider: string, usage: object, label: string, modelId: string) => void} addUsage
 */
function setUsageSink(addUsage) {
  usageContext.enterWith({ addUsage });
}

/**
 * Run `fn` with the given sink active (preferred over setUsageSink when the
 * pipeline body can be wrapped — fully scoped, no leak across jobs).
 */
function runWithUsageSink(addUsage, fn) {
  return usageContext.run({ addUsage }, fn);
}

/**
 * Record a text-model call's usage into the active job's sink. No-op outside a
 * job (scripts, tests) and never throws — accounting must never break a render.
 *
 * @param {string} provider - tokenUsage provider key (anthropic / gemini_text / grok)
 * @param {object} usage - { input_tokens, output_tokens, thinking_tokens? }
 * @param {string} label - byFunction bucket name (e.g. 'unified_story')
 * @param {string} modelId - resolved model id
 */
function recordTextUsage(provider, usage, label, modelId) {
  const store = usageContext.getStore();
  if (!store || typeof store.addUsage !== 'function') return;
  try {
    store.addUsage(provider, usage, label || 'text_uncategorized', modelId);
  } catch {
    // Accounting is best-effort; a sink error must not surface to the pipeline.
  }
}

/**
 * Record an IMAGE-model call's usage into the active job's sink.
 *
 * Same sink, same contract — a separate name because an image render is booked
 * under an image provider key (`gemini_image` / `grok` / `runware`), and a
 * render booked through a function documented as text-only reads as a mistake.
 * Use this wherever a render has no `usageTracker` closure threaded to it:
 * the reference-sheet grids (referenceSheets.js) rendered through
 * `callGeminiAPIForImage` with no tracker at all and so appeared under NO
 * `byFunction` key, while every other image call in the same job was costed.
 *
 * @param {string} provider - tokenUsage provider key (gemini_image / grok / runware)
 * @param {object} usage - { input_tokens, output_tokens, thinking_tokens?, direct_cost? }
 * @param {string} label - byFunction bucket name (e.g. 'vb_reference_sheet')
 * @param {string} modelId - resolved model id
 */
function recordImageUsage(provider, usage, label, modelId) {
  const store = usageContext.getStore();
  if (!store || typeof store.addUsage !== 'function') return;
  try {
    store.addUsage(provider, usage, label || 'image_uncategorized', modelId);
  } catch {
    // Accounting is best-effort; a sink error must not surface to the render.
  }
}

module.exports = { usageContext, setUsageSink, runWithUsageSink, recordTextUsage, recordImageUsage };
