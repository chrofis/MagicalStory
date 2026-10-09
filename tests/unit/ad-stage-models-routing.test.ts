/**
 * Art Director stage routing (docs/decisions.md 2026-10-09 "Art Director stage models"):
 * the Visual Bible runs on claude-haiku-5-5 (effort medium), the all-pages briefs on
 * gemini-3.7-flash; the brief re-ask, the label round, the per-page fallback and the
 * lector stay on gemini-3.1-pro. An explicit sceneModel (dev override / Lab arm) wins everywhere.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const { MODEL_DEFAULTS, TEXT_MODELS } = require('../../server/config/models');
const { adStageModels } = require('../../server/lib/beatsPipeline.js');
const ROOT = join(__dirname, '..', '..');

describe('Art Director stage models', () => {
  it('the routed keys are the measured ones (unless an env override is set)', () => {
    if (!process.env.VISUAL_BIBLE_MODEL) expect(MODEL_DEFAULTS.visualBibleModel).toBe('claude-haiku-5-5');
    if (!process.env.SCENE_BRIEFS_MODEL) expect(MODEL_DEFAULTS.sceneBriefsModel).toBe('gemini-3.7-flash');
    expect(MODEL_DEFAULTS.visualBibleEffort).toBe('medium');
    expect(TEXT_MODELS[MODEL_DEFAULTS.visualBibleModel]).toBeTruthy();
    expect(TEXT_MODELS[MODEL_DEFAULTS.sceneBriefsModel]).toBeTruthy();
  });
  it('the re-ask, label round, fallback and lector are NOT moved', () => {
    if (!process.env.SCENE_DESCRIPTION_MODEL) expect(MODEL_DEFAULTS.sceneDescription).toBe('gemini-3.1-pro');
    if (!process.env.TEXT_PROOFREAD_MODEL) expect(MODEL_DEFAULTS.textProofreadModel).toBe('gemini-3.1-pro');
    const src = readFileSync(join(ROOT, 'server/lib/beatsPipeline.js'), 'utf8');
    expect(src).toContain('model: sceneModel, gl, stage,'); // runBriefChecks
    expect(src).toContain('model: sceneModel, language: inputData.language'); // label round
    expect(src).toContain("callTextModelStreaming(prompt, null, onChunk, sceneModel, { usageLabel: 'beats_scene_expansion_fallback'");
  });
  it('the default scene model routes the two stages; an explicit one wins for both', () => {
    const routed = adStageModels(MODEL_DEFAULTS.sceneDescription);
    expect(routed.vb).toBe(MODEL_DEFAULTS.visualBibleModel);
    expect(routed.briefs).toBe(MODEL_DEFAULTS.sceneBriefsModel);
    expect(adStageModels('claude-sonnet')).toEqual({ vb: 'claude-sonnet', briefs: 'claude-sonnet' });
  });
  it('the calls use the routed models, and the bible call carries the effort only on the routed model', () => {
    const src = readFileSync(join(ROOT, 'server/lib/beatsPipeline.js'), 'utf8');
    expect(src).toContain("callTextModelStreaming(vbPrompt, null, onChunk, vbModel, { usageLabel: 'beats_visual_bible', ...(vbModel === MODEL_DEFAULTS.visualBibleModel && MODEL_DEFAULTS.visualBibleEffort");
    expect(src).toContain("callTextModelStreaming(allPrompt, null, onChunk, briefsModel, { usageLabel: 'beats_scene_expansion'");
  });
});
