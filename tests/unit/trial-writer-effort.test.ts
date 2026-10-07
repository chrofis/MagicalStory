/** decisions.md 2026-10-07: the trial writer runs at MODEL_DEFAULTS.trialStoryEffort, not the model default. */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { MODEL_DEFAULTS } = require('../../server/config/models.js');
const src = fs.readFileSync(path.join(__dirname, '..', '..', 'storyJobPipeline.js'), 'utf8');

describe('trial writer effort', () => {
  it('is an explicit level', () => {
    expect(['low', 'medium', 'high']).toContain(MODEL_DEFAULTS.trialStoryEffort);
  });
  it('the unified (trial-only) writer call passes it', () => {
    expect(src).toMatch(/usageLabel: 'unified_story', effort: MODEL_DEFAULTS\.trialStoryEffort \}/);
  });
});
