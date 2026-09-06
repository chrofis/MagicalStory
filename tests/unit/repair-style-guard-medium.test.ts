import { describe, it, expect, beforeAll } from 'vitest';

// The character-repair style guard used to be ONE constant baked into all four
// repair templates at load time. On a book whose commissioned medium is a
// photograph (artStyle 'realistic') it ordered an "illustration" with "line
// work" and forbade rendering "more photographically" — directly contradicting
// the artStyleContext block one line below it, which reads "match this medium
// exactly: A photograph." Grok obeyed the guard, the style gate correctly
// refused the cartoon, and character repair could never write a pixel on a
// realistic story. Reproduced from staging job_1788681313413_xqmtk2gcs.
//
// See docs/decisions.md → "The character-repair style guard follows the book's
// medium (2026-09-06)".

// eslint-disable-next-line @typescript-eslint/no-var-requires
const prompts = require('../../server/services/prompts');

const ILLUSTRATED_STYLES = [
  'pixar', 'cartoon', 'anime', 'chibi', 'steampunk', 'comic',
  'manga', 'watercolor', 'oil', 'lowpoly', 'concept', 'pixel', 'cyber',
];

describe('repair style guard follows the book medium', () => {
  it('classifies realistic as photographic', () => {
    expect(prompts.isPhotographicArtStyle('realistic')).toBe(true);
  });

  it('classifies every painted and drawn style as illustrated', () => {
    // watercolor / oil / concept share a NOT_A_PHOTOGRAPH line reading "never
    // captured by a camera … is still a photograph". A first draft of the
    // predicate matched those phrases anywhere in the descriptor and called all
    // three PHOTOGRAPHIC. That is the regression this case exists for.
    for (const style of ILLUSTRATED_STYLES) {
      expect(prompts.isPhotographicArtStyle(style), `${style} must be illustrated`).toBe(false);
    }
  });

  it('falls back to illustrated for an unknown or missing style', () => {
    for (const v of [null, undefined, '', 'no-such-style']) {
      expect(prompts.isPhotographicArtStyle(v as never)).toBe(false);
      expect(prompts.repairStyleGuard(v as never)).toBe(prompts.REPAIR_STYLE_GUARD_ILLUSTRATED);
    }
  });

  it('accepts a raw descriptor as well as an id', () => {
    expect(prompts.isPhotographicArtStyle(
      'A photograph. Real people captured by a camera: natural proportions',
    )).toBe(true);
    expect(prompts.isPhotographicArtStyle(
      'A bold, expressive traditional watercolor painting. Painted by hand, never captured by a camera',
    )).toBe(false);
  });

  it('keeps the illustrated wording byte-for-byte unchanged', () => {
    // The painted styles must be getting exactly what they got before this
    // change — the fix is about which books receive it, not about rewording it.
    expect(prompts.REPAIR_STYLE_GUARD).toBe(
      'Render the repainted area in the same illustration style as the rest of the scene — '
      + 'same line work, shading, and level of detail as the other figures. Do not render it '
      + 'more realistically or more photographically than the surrounding artwork.',
    );
    expect(prompts.repairStyleGuard('watercolor')).toBe(prompts.REPAIR_STYLE_GUARD);
  });

  it('gives a photographic story a guard that does not order an illustration', () => {
    const guard = prompts.repairStyleGuard('realistic');
    expect(guard).toBe(prompts.REPAIR_STYLE_GUARD_PHOTOGRAPHIC);
    expect(guard).not.toMatch(/illustration style|line work/);
    expect(guard).toMatch(/photographic style/);
  });
});

describe('the style guard token can never ship as a hole', () => {
  beforeAll(async () => {
    await prompts.loadPromptTemplates();
  });

  it('leaves the token in the four style-scoped repair templates', () => {
    for (const key of ['characterRepairCutout', 'characterRepairInpaint',
      'characterRepairBlended', 'characterRepairBodyBlended']) {
      expect(prompts.PROMPT_TEMPLATES[key], key).toContain('{REPAIR_STYLE_GUARD}');
      // The TEXT guard is style-independent and still baked at load.
      expect(prompts.PROMPT_TEMPLATES[key], key).not.toContain('{REPAIR_TEXT_GUARD}');
    }
  });

  it('fillTemplate substitutes the illustrated default when the caller forgets', () => {
    const out = prompts.fillTemplate('before {REPAIR_STYLE_GUARD} after', {});
    expect(out).toContain('same illustration style');
    expect(out).not.toContain('{REPAIR_STYLE_GUARD}');
  });

  it('fillTemplate honours an explicit per-story guard', () => {
    const out = prompts.fillTemplate('before {REPAIR_STYLE_GUARD} after', {
      REPAIR_STYLE_GUARD: prompts.repairStyleGuard('realistic'),
    });
    expect(out).toContain('same photographic style');
    expect(out).not.toContain('illustration style');
  });

  it('a realistic repair prompt no longer contradicts its own art-style block', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ART_STYLES } = require('../../server/lib/promptBuilders');
    const filled = prompts.fillTemplate(prompts.PROMPT_TEMPLATES.characterRepairCutout, {
      charName: 'the main character',
      identityName: 'the main character',
      appearanceContext: '',
      clothingContext: '',
      actionContext: '',
      issueContext: '',
      textPositionContext: '',
      artStyleContext: `\n\nArt style — match this medium and rendering exactly: ${ART_STYLES.realistic}`,
      REPAIR_STYLE_GUARD: prompts.repairStyleGuard('realistic'),
    });
    expect(filled).toContain('A photograph.');
    expect(filled).toContain('same photographic style');
    // The contradiction: an "illustration" order inside a prompt whose art-style
    // block says the medium is a photograph.
    expect(filled).not.toMatch(/same illustration style/);
    expect(filled).not.toMatch(/more photographically than the surrounding artwork/);
  });
});

describe('a null axis from the shared contract is "not set", not an override', () => {
  // buildCharRepairRequest materialises every canonical key, filling absent ones
  // with null. `faceOnly: null` was therefore present on every request the
  // button, the pipeline and the Lab build, and `!== undefined` accepted it as a
  // deliberate override — forcing faceOnly false and silently downgrading EVERY
  // face repair to a full-figure one. Reproduced in Lab exp #996: whiteoutTarget
  // 'face' came back with descriptor grok:box:blur:body.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { buildCharRepairRequest } = require('../../server/lib/charRepairRequest');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { legacyFlagsToAxes, applyGeometryGuards, repairDescriptor } = require('../../server/lib/faceRepair');

  const FACE = [0.08, 0.53, 0.33, 0.75];
  const BODY = [0.08, 0.53, 0.96, 0.76];

  // The exact merge repairCharacterMismatch performs.
  const resolve = (request: Record<string, unknown>) => {
    const axes = legacyFlagsToAxes({
      useBlended: true, whiteoutTarget: 'face', hasFaceBbox: true, model: 'grok',
    });
    const explicit: Record<string, unknown> = {};
    if (request.treatment) explicit.treatment = request.treatment;
    if (request.regionSource) explicit.regionSource = request.regionSource;
    if (request.faceOnly !== undefined && request.faceOnly !== null) {
      explicit.faceOnly = !!request.faceOnly;
    }
    return repairDescriptor(
      applyGeometryGuards({ ...axes, ...explicit }, { faceBbox: FACE, bodyBbox: BODY }),
    );
  };

  it('the contract fills faceOnly with null when the caller omits it', () => {
    const req = buildCharRepairRequest({
      imageBackend: 'grok', whiteoutTarget: 'face', faceBbox: FACE, bodyBbox: BODY,
    });
    expect(req.faceOnly).toBeNull();
  });

  it('a face repair stays a FACE repair', () => {
    const req = buildCharRepairRequest({
      imageBackend: 'grok', whiteoutTarget: 'face', faceBbox: FACE, bodyBbox: BODY,
    });
    expect(resolve(req)).toBe('grok:cutout:blur:face');
  });

  it('an explicit faceOnly:false is still honoured', () => {
    const req = buildCharRepairRequest({
      imageBackend: 'grok', whiteoutTarget: 'face', faceBbox: FACE, bodyBbox: BODY,
      faceOnly: false,
    });
    expect(resolve(req)).toBe('grok:box:blur:body');
  });
});
