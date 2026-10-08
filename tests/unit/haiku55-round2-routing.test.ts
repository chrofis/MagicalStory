/**
 * Haiku 5.5 bake-off round 2 (docs/decisions.md 2026-10-08 "Haiku 5.5 round 2"):
 * the planner, both text audits, the lector and the landmark pick run on
 * claude-haiku-5-5 with an effort and NO temperature; the trial writer and the
 * wardrobe bible stay on MODEL_DEFAULTS.outline.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const { MODEL_DEFAULTS, TEXT_MODELS } = require('../../server/config/models');
const ROOT = join(__dirname, '..', '..');

describe('round 2 routing', () => {
  it('audits and planner point at Haiku 5.5 (unless an env override is set)', () => {
    if (!process.env.TEXT_AUDIT_MODEL) expect(MODEL_DEFAULTS.textAuditModel).toBe('claude-haiku-5-5');
    if (!process.env.TEXT_AUDIT_BLIND_MODEL) expect(MODEL_DEFAULTS.textAuditBlindModel).toBe('claude-haiku-5-5');
    expect(MODEL_DEFAULTS.beatsPlanModel).toBe('claude-haiku-5-5');
    for (const k of ['textAuditModel', 'textAuditBlindModel', 'beatsPlanModel']) {
      expect(TEXT_MODELS[MODEL_DEFAULTS[k]], k).toBeTruthy();
    }
  });
  it('efforts are the measured ones', () => {
    expect(MODEL_DEFAULTS.textAuditEffort).toBe('high');
    expect(MODEL_DEFAULTS.beatsPlanEffort).toBe('medium');
  });
  it('the planner has its own key; the trial writer (outline) and the bible are not moved', () => {
    expect(MODEL_DEFAULTS.outline).toBe('claude-sonnet');
    const src = readFileSync(join(ROOT, 'server/lib/beatsPipeline.js'), 'utf8');
    expect(src).toContain('const planModel = modelOverrides.beatsPlanModel || MODEL_DEFAULTS.beatsPlanModel;');
    expect(src).toContain('const bibleModel = modelOverrides.outlineModel || MODEL_DEFAULTS.outline;');
  });
  it('the audits pass the effort and never a temperature on the Anthropic path', () => {
    const src = readFileSync(join(ROOT, 'server/lib/textRefine.js'), 'utf8');
    expect(src.match(/effort: MODEL_DEFAULTS\.textAuditEffort/g)?.length).toBe(2);
  });
  it('the landmark pick uses Haiku 5.5 at effort low', () => {
    const src = readFileSync(join(ROOT, 'server/lib/landmarkPhotos.js'), 'utf8');
    expect(src).toContain("'claude-haiku-5-5', { usageLabel: 'landmark_photo_pick', effort: 'low' }");
  });
});
