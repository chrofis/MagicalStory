/**
 * decisions.md 2026-10-07: the trial writer runs at MODEL_DEFAULTS.trialStoryEffort, not the model default.
 * decisions.md 2026-10-10 "Flash arc+bible v4": the trial writer is two calls; the planner has its own model and effort.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { MODEL_DEFAULTS } = require('../../server/config/models.js');
const root = path.join(__dirname, '..', '..');
const src = fs.readFileSync(path.join(root, 'storyJobPipeline.js'), 'utf8');
const writer = fs.readFileSync(path.join(root, 'server', 'lib', 'trialWriter.js'), 'utf8');

describe('trial writer effort', () => {
  it('is an explicit level', () => {
    expect(['low', 'medium', 'high']).toContain(MODEL_DEFAULTS.trialStoryEffort);
  });
  it('the pages writer call passes it (server/lib/trialWriter.js)', () => {
    expect(writer).toMatch(/usageLabel: 'unified_story', effort: MODEL_DEFAULTS\.trialStoryEffort \}/);
  });
  it('the planner call passes its own model and effort, both constants', () => {
    expect(['low', 'medium']).toContain(MODEL_DEFAULTS.trialArcEffort);
    expect(MODEL_DEFAULTS.trialArcModel).toBe('gemini-3.7-flash');
    expect(writer).toMatch(/MODEL_DEFAULTS\.trialArcModel,\s*\{ usageLabel: 'unified_story', reasoning: \{ effort: MODEL_DEFAULTS\.trialArcEffort \} \}/);
  });
  it('the pipeline runs the trial through the two-call writer, pages on the job outline model', () => {
    expect(src).toMatch(/runTrialWriter\(\{/);
    expect(src).toMatch(/pagesModel: modelOverrides\.outlineModel/);
  });
});
