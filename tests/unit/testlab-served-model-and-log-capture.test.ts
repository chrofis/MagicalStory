// Code review 2026-10-04 area 8 L4/L6: the Lab's quality_eval stage records the judge that
// SERVED (not the one asked for), and the per-stage log capture keeps every warn/error line
// while capping only info. testlab.js cannot be imported cheaply, so the source is pinned.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const src = fs.readFileSync(path.join(__dirname, '../../server/lib/testlab.js'), 'utf8');

describe('Lab quality_eval records what ran', () => {
  it('modelId comes from the batch result; the asked model is kept separately', () => {
    expect(src).toContain('modelId: result.modelId || null,');
    expect(src).toContain("requestedModelId: params.model || require('../config/models').MODEL_DEFAULTS.qualityEval,");
    expect(src).not.toContain("    modelId: params.model || require('../config/models').MODEL_DEFAULTS.qualityEval,");
  });
});

describe('Lab stage log capture', () => {
  it('caps info lines only; warn/error are never dropped', () => {
    expect(src).not.toContain('if (captured.length >= 400) return;');
    expect(src).toMatch(/isProblem = level === 'warn' \|\| level === 'error'/);
    expect(src).toMatch(/if \(!isProblem\) \{ if \(infoCaptured >= 400\) return; infoCaptured\+\+; \}/);
  });
});
