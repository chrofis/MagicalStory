import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

// CJS registry, not vitest's ESM graph — the prompt store and scoring both
// reach each other with plain require() (see age-band.test.ts).
const require_ = createRequire(import.meta.url);
const { deductionPoints, deductionClassKey, SEVERITY_POINTS } =
  require_('../../server/lib/scoring');
const { BUCKETS, bucketForType } = require_('../../server/lib/evalBuckets');
const { loadPromptTemplates, PROMPT_TEMPLATES } = require_('../../server/services/prompts');

// `duplicate_object` (image-evaluation D-32, owner-approved 2026-09-06): one
// named prop rendered twice when the scene has one of it — the eval-side check
// for the worn-item dedupe the creation side does. Evidence:
// job_1788641639919_mpjwlzkf1 p3, where the quality evaluator returned
// verdict PASS / fixable_issues [] on a page showing the hat both worn and
// lying on the cobbles.
describe('duplicate_object — scoring', () => {
  it('costs a MAJOR (15) at its declared severity', () => {
    expect(deductionPoints({ type: 'duplicate_object', severity: 'MAJOR' })).toBe(SEVERITY_POINTS.major);
  });

  it('is capped at MAJOR when an evaluator escalates it', () => {
    expect(deductionPoints({ type: 'duplicate_object', severity: 'CRITICAL' })).toBe(SEVERITY_POINTS.major);
    expect(deductionPoints({ type: 'duplicate_object', severity: 'CATASTROPHIC' })).toBe(SEVERITY_POINTS.major);
  });

  it('leaves a below-ceiling severity untouched', () => {
    expect(deductionPoints({ type: 'duplicate_object', severity: 'MINOR' })).toBe(SEVERITY_POINTS.minor);
  });

  it('charges nothing for an unknown or missing severity', () => {
    expect(deductionPoints({ type: 'duplicate_object', severity: 'SEVERE' })).toBe(0);
    expect(deductionPoints({ type: 'duplicate_object' })).toBe(0);
  });

  it('applies the ceiling on the raw entity shape too (subType survival)', () => {
    // Entity findings flatten `type` to 'consistency' and carry the class in
    // subType; deductionPoints must read subType first or the cap is blind.
    expect(deductionPoints({ type: 'consistency', subType: 'duplicate_object', severity: 'CRITICAL' }))
      .toBe(SEVERITY_POINTS.major);
  });
});

describe('duplicate_object — taxonomy', () => {
  it('is a real bucket owned by quality and repaired by inpaint', () => {
    expect(BUCKETS.duplicate_object).toMatchObject({ owner: 'quality', repair: 'inpaint' });
  });

  it('resolves from its type and its aliases', () => {
    for (const t of ['duplicate_object', 'duplicated_object', 'duplicate_prop', 'object_duplication']) {
      expect(bucketForType(t)).toBe('duplicate_object');
    }
  });

  it('bills separately from object_presence, which is page-scoped', () => {
    // Aliasing into object_presence would make a duplicate free on any page
    // that already carries a missing element — the reason for its own bucket.
    expect(deductionClassKey({ type: 'duplicate_object', name: 'red hat' }))
      .toBe('duplicate_object|red hat');
    expect(deductionClassKey({ type: 'missing_element', name: 'red hat' }))
      .toBe('page:object_presence');
  });
});

describe('duplicate_object — prompt vocabulary', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('image-evaluation carries the D-32 rule and its type', () => {
    const t = String(PROMPT_TEMPLATES.imageEvaluation || '');
    expect(t).toContain('D-32 `duplicate_object`');
    expect(t).toMatch(/D-32 `duplicate_object` → MAJOR/);
    // Must be distinguished from D-01's boxed reference miniatures.
    expect(t).toContain('Not D-01');
  });

  it('feedback-consolidator keeps the type through merging', () => {
    const t = String(PROMPT_TEMPLATES.feedbackConsolidator || '');
    // In the closed list, or the consolidator relabels it and the cap lifts.
    expect(t).toContain('`duplicate_object`');
    expect(t).toMatch(/`duplicate_object`[^\n]*keeps its own type when merging/);
  });
});
