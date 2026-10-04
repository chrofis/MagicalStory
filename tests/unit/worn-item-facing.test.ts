/**
 * A GARMENT SEEN FROM BEHIND (owner, 2026-10-04; staging
 * job_1791040103540_atbttop6w, dragon run 9, p5 and p18).
 *
 * Kiaan was declared `perspective: "back view"` and got the rear sheet cell,
 * but the WORN ITEMS line — "these win over the attached references" — carried
 * his jacket's bible description verbatim: "a full-length front zip, two patch
 * pockets at the hip and a stand-up collar". The render put all three on his
 * back. Two halves:
 *   1  generator — a face-away wearer's worn line carries `seen from the back`
 *      and the garment's authored `back` look, never its front description;
 *   2  critic — image-evaluation D-05e `garment_facing`, capped at MAJOR, fed
 *      the same facing through the CLOTHING CONTRACT tag.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

const cjs = createRequire(import.meta.url);
const W = cjs('../../server/lib/wornItems.js');
const PB = cjs('../../server/lib/promptBuilders.js');
const { buildEvalClothingContract } = cjs('../../server/lib/evalPipeline.js');
const { applyWardrobeBibleCorrections } = cjs('../../server/lib/clothingCheck.js');
const { deductionPoints, SEVERITY_POINTS } = cjs('../../server/lib/scoring.js');
const { BUCKETS, bucketForType, CONSOLIDATED_TYPES } = cjs('../../server/lib/evalBuckets.js');
const { NOT_INPAINTABLE_TYPES } = cjs('../../server/lib/repairLogic.js');
const { loadPromptTemplates, PROMPT_TEMPLATES } = cjs('../../server/services/prompts.js');

// The stored CLO001 of the run above, verbatim.
const FRONT = 'A purple quilted autumn jacket with a full-length front zip, two patch pockets at the hip and a stand-up collar.';
const clo = (extra: any = {}) => ({
  id: 'CLO001', name: 'autumn jacket', label: 'autumn jacket', pages: [1, 5], appearsInPages: [1, 5],
  wornBy: 'Kiaan', howWorn: 'worn over the torso and arms', description: FRONT, ...extra,
});
const bible = (extra: any = {}) => ({ clothing: [clo(extra)], artifacts: [], animals: [], vehicles: [], locations: [] });
const meta = (perspective: string, state = 'worn') => ({
  characters: [
    { name: 'Levin', perspective: 'back view' },
    { name: 'Kiaan', perspective },
  ],
  wornItems: [{ id: 'CLO001', owner: 'Kiaan', state, ...(state === 'off' ? { location: 'on the bench' } : {}) }],
});
const lines = (vb: any, m: any) => W.buildWornStateLines(W.resolveWornItemsForPage(vb, m.characters, m, { pageNumber: 5 }));

describe('1 — the worn line follows the wearer’s facing', () => {
  it('a back-view wearer gets the authored back look, tagged, and no front feature', () => {
    const out = lines(bible({ back: 'purple quilted jacket, hip length' }), meta('back view'));
    expect(out).toEqual(['- Kiaan IS wearing this on this page, seen from the back: autumn jacket — purple quilted jacket, hip length.']);
    expect(out.join(' ')).not.toMatch(/zip|pocket|collar/);
  });

  it('an entry with no back look names the garment only — the front description is never sent', () => {
    const out = lines(bible(), meta('back view'));
    expect(out).toEqual(['- Kiaan IS wearing this on this page, seen from the back: autumn jacket.']);
  });

  it('every face-away perspective the cell resolver knows counts (over-the-shoulder, rear three-quarter)', () => {
    for (const p of ['over-the-shoulder', 'rear three-quarter', 'facing away']) {
      expect(lines(bible({ back: 'purple quilted jacket' }), meta(p))[0], p).toContain('seen from the back');
    }
  });

  it('a figure facing the viewer keeps the full description, untagged', () => {
    const out = lines(bible({ back: 'purple quilted jacket' }), meta('three-quarter'));
    expect(out).toEqual([`- Kiaan IS wearing this on this page: autumn jacket — ${FRONT}`]);
    expect(out[0]).toContain('full-length front zip');
    expect(out[0]).not.toContain('seen from the back');
  });

  it('an item taken OFF is described as it lies — the wearer’s facing does not apply', () => {
    const out = lines(bible({ back: 'purple quilted jacket' }), meta('back view', 'off'));
    expect(out[0]).toContain('is NOT wearing this');
    expect(out[0]).toContain('full-length front zip');
  });

  it('two worn items of one back-view character share one tagged line', () => {
    const vb = bible({ back: 'purple quilted jacket' });
    vb.clothing.push({ id: 'CLO002', name: 'wool scarf', label: 'wool scarf', pages: [5], appearsInPages: [5],
      wornBy: 'Kiaan', description: 'A red wool scarf with a knotted front.', back: 'red wool scarf' } as any);
    const m: any = meta('back view');
    m.wornItems.push({ id: 'CLO002', owner: 'Kiaan', state: 'worn' });
    expect(lines(vb, m)).toEqual(['- Kiaan IS wearing these on this page, seen from the back: autumn jacket — purple quilted jacket; wool scarf — red wool scarf.']);
  });
});

describe('1 — the back look is authored at both Visual Bible sites, from one constant', () => {
  beforeAll(async () => { await loadPromptTemplates(); });
  const inputData: any = {
    title: 'x', characters: [{ id: 'c1', name: 'Kiaan', age: 4, gender: 'boy' }], mainCharacters: ['c1'],
    language: 'en', languageLevel: 'medium', pages: 10, storyCategory: 'adventure', storyType: 'adventure',
    storyDetails: 'x', artStyle: 'watercolor', relationships: {}, relationshipTexts: {},
  };
  it('the Art Director bible call and the trial writer both carry GARMENT_BACK_RULE', () => {
    const bibleCall = String(PB.buildVisualBibleCallPrompt(inputData, [{ pageNumber: 1, planLine: 'wide — Kiaan — Kiaan walks away' }], {}));
    const trial = String(PB.buildTrialStoryPrompt(inputData));
    for (const [site, p] of [['bible call', bibleCall], ['trial', trial]]) {
      expect(p.includes(W.GARMENT_BACK_RULE), site).toBe(true);
      expect(p, site).not.toContain('{GARMENT_BACK}');
    }
    expect(bibleCall).toContain('"back": "[see the back rule]"');
  });

  it('a wardrobe adopt drops a back look whose colour the contract contradicts, keeps one that agrees', () => {
    const reqs = () => ({ Mia: { standard: { used: true, description: 'A red cotton t-shirt; blue denim jeans; a green fleece jacket; white canvas sneakers.' } } });
    const vb = (back: string) => ({ artifacts: [{ id: 'ART001', name: 'fleece jacket', label: 'fleece jacket', type: 'outer layer',
      wornAs: 'Mia.outer layer', description: 'a blue fleece jacket with a front zip', back }] });
    const quiet = { warn: () => {}, info: () => {}, error: () => {} };
    const stale = vb('blue fleece jacket');
    applyWardrobeBibleCorrections(reqs(), stale, { log: quiet });
    expect(stale.artifacts[0].description).toBe('green fleece jacket');
    expect((stale.artifacts[0] as any).back).toBeUndefined();
    const fine = vb('green fleece jacket');
    applyWardrobeBibleCorrections(reqs(), fine, { log: quiet });
    expect(fine.artifacts[0].back).toBe('green fleece jacket');
  });
});

describe('2 — the judges are told the facing, and garment_facing is a scored type capped at MAJOR', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('the CLOTHING CONTRACT tags a face-away character, with the generator’s own predicate', () => {
    const reqs: any = {
      Kiaan: { _currentClothing: 'standard', standard: { used: true, description: FRONT } },
      Levin: { _currentClothing: 'standard', standard: { used: true, description: 'A green pullover; blue jeans.' } },
    };
    const m = meta('back view');
    m.characters[0].perspective = 'front';
    const { block } = buildEvalClothingContract({ sceneCharacters: m.characters, clothingRequirements: reqs, sceneMetadata: m, visualBible: bible() });
    expect(block).toMatch(/^- Kiaan \(seen from the back\): /m);
    expect(block).toMatch(/^- Levin: /m);
  });

  it('costs up to MAJOR on both issue shapes', () => {
    expect(deductionPoints({ type: 'garment_facing', severity: 'MAJOR' })).toBe(SEVERITY_POINTS.major);
    expect(deductionPoints({ type: 'garment_facing', severity: 'CRITICAL' })).toBe(SEVERITY_POINTS.major);
    expect(deductionPoints({ type: 'consistency', subType: 'garment_facing', severity: 'CRITICAL' })).toBe(SEVERITY_POINTS.major);
    expect(deductionPoints({ type: 'garment_facing', severity: 'MINOR' })).toBe(SEVERITY_POINTS.minor);
  });

  it('has its own bucket, the consolidated list, and the wardrobe repair route', () => {
    expect(BUCKETS.garment_facing).toMatchObject({ owner: 'quality', repair: 'grok_blended' });
    expect(bucketForType('garment_facing')).toBe('garment_facing');
    expect(CONSOLIDATED_TYPES).toContain('garment_facing');
    expect(NOT_INPAINTABLE_TYPES.has('garment_facing')).toBe(true);
  });

  it('the quality evaluator carries D-05e and the consolidator keeps the type', () => {
    expect(String(PROMPT_TEMPLATES.imageEvaluation || '')).toMatch(/D-05e `garment_facing` → MAJOR \/ MINOR/);
    expect(String(PROMPT_TEMPLATES.imageEvaluation || '')).toContain('(seen from the back)');
    expect(String(PROMPT_TEMPLATES.feedbackConsolidator || '')).toContain('`garment_facing`');
    expect(W.SEEN_FROM_BACK).toBe('seen from the back');
  });
});
