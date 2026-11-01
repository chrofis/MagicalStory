'use strict';

/**
 * THE ART DIRECTOR'S MODEL CALL, with the one rule for a provider refusal (owner, 2026-10-31, "Other model on refusal";
 * docs/decisions.md 2026-10-31 "A refused Art Director call is asked once on another model").
 *
 * Google's safety filter refuses innocent scenes with children (bedtime: pyjamas, the bathroom, brushing teeth) with
 * finish_reason=content_filter / PROHIBITED_CONTENT, often after part of a reply has streamed. Such a reply is NOT a
 * brief: it used to be salvaged as one and failed the story 20 minutes later (staging job_1793480917111_84ivx1lou p6,
 * tasks/bugs.json art-director-safety-refusal-shipped-as-brief). So a refused reply is never returned: the same prompt
 * goes once to MODEL_DEFAULTS.artDirectorRefusalModel, and when that is refused too the run stops with
 * ArtDirectorRefusedError, which every Art Director call site rethrows. Any other failure (a cut, a malformed reply) is
 * the caller's, exactly as before: gates are guidelines (docs/SETTLED.md).
 */

const textModels = require('./textModels');
const { MODEL_DEFAULTS } = require('../config/models');
const { log } = require('../utils/logger');

class ArtDirectorRefusedError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ArtDirectorRefusedError';
    this.details = details;
  }
}

const isRefusal = (res) => res?.truncation?.suspected === true && res.truncation.reason === 'refusal';

function countMetric(name) {
  try {
    const runMetrics = require('./runMetrics');
    runMetrics.forJob(runMetrics.ambientJobId()).count(name);
  } catch { /* metrics are never fatal */ }
}

/**
 * callTextModelStreaming for an Art Director call. Same arguments and same result shape; a result that came from the
 * reroute carries `refusalReroute: { refusedModel, refusedProvider, model }`.
 * `options` are the first call's (reasoning knobs belong to that model); the reroute gets only the usage label.
 */
async function askArtDirector(prompt, onChunk, model, options = {}, deps = {}) {
  const call = deps.call || textModels.callTextModelStreaming;
  const label = options.usageLabel || 'art_director';
  const first = await call(prompt, null, onChunk, model, options);
  if (!isRefusal(first)) return first;

  const alt = MODEL_DEFAULTS.artDirectorRefusalModel;
  const refusedProvider = first.truncation.provider || first.provider || null;
  if (!alt || alt === model) {
    throw new ArtDirectorRefusedError(`${label}: ${model} refused the call (${textModels.describeTruncation(first.truncation)}) and there is no other Art Director model to ask`, { label, refused: [model] });
  }
  log.error(`🚨 [ART DIRECTOR] ${label}: ${model} via ${refusedProvider || 'unknown'} REFUSED the call — asking ${alt} once with the same prompt`);
  countMetric('ad_refusal_rerouted');
  const second = await call(prompt, null, onChunk, alt, { usageLabel: `${label}_refusal_reroute` });
  if (isRefusal(second)) {
    countMetric('ad_refusal_stopped');
    throw new ArtDirectorRefusedError(`${label}: refused by ${model} and by ${alt} (${textModels.describeTruncation(second.truncation)}) — the story stops here rather than draw from a refused brief`, { label, refused: [model, alt] });
  }
  return { ...second, refusalReroute: { refusedModel: model, refusedProvider, model: alt } };
}

module.exports = { askArtDirector, ArtDirectorRefusedError, isRefusal };
