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

/**
 * WHICH JUDGES MAY EMIT IT (2026-09-19).
 *
 * `duplicate_object` was priced and bucketed on 2026-09-06 but reached exactly
 * one of the four judges. The two that saw a duplicated garment on staging
 * job_1789759147125_p08djwhbl (pages 7, 11, 14 — one worn on the body and a
 * second copy held or lying apart) had no legal type for it and filed it as
 * `clothing`: wrong class, wrong bucket, wrong repair. A judge with no legal
 * way to be right is a different failure from a judge being wrong.
 *
 * The membership is the contract, so both halves are pinned — the judge that
 * gained it, and the two that are deliberately without it.
 */
describe('duplicate_object — which judges carry the type', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('the semantic judge carries it in its closed type list', () => {
    // Semantic sees the picture and owns depiction, so it gets the type.
    // Asserted on the BUILT prompt: the closed list routes the repair, and a
    // type absent from the string the model receives can never be emitted.
    const { buildSemanticPrompt } = require_('../../server/lib/sceneValidator');
    const built = String(buildSemanticPrompt(PROMPT_TEMPLATES.imageSemantic, {
      storyText: 'The child carried the lantern down the path.',
      sceneHint: 'A child walks a path at dusk carrying a lantern.',
      imagePrompt: 'A child walks a path at dusk carrying a lantern.',
      interactionsBlock: '(none declared)',
      elementsBlock: 'ART001 — lantern',
      evalContext: { artStyle: 'watercolor' },
    }));
    expect(built).toContain('`duplicate_object`');
    expect(built).toContain('type: duplicate_object');
    expect(built).not.toMatch(/\{[A-Z][A-Z0-9_]*\}/);
  });

  it('the entity-consistency judge does NOT — it cannot see a duplicate', () => {
    // It compares ONE cropped cutout of ONE entity per page; a second copy
    // standing apart from the figure is cut away with the background, so the
    // type would only let it guess a class from evidence it never receives.
    const t = String(PROMPT_TEMPLATES.entityConsistencyCheck || '');
    expect(t, 'entity-consistency template must load').toBeTruthy();
    expect(t).not.toContain('duplicate_object');
  });

  it('the blind prompt-compliance judge does NOT — it never sees the image', () => {
    // Its remit was narrowed on 2026-09-19 to stop it ruling on depiction, and
    // it is off in production (docs/SETTLED.md). A depiction type here would
    // reverse that.
    const t = String(PROMPT_TEMPLATES.imagePromptCompliance || '');
    expect(t, 'prompt-compliance template must load').toBeTruthy();
    expect(t).not.toContain('duplicate_object');
  });

  it('the illustrator was already told to draw one of each named object', () => {
    // The generator half of the generator-vs-critic pair: a rule a judge may
    // deduct for is a rule the generator was given.
    const t = String(PROMPT_TEMPLATES.imageGeneration || '');
    expect(t).toContain('Draw exactly one of each named object.');
  });
});
