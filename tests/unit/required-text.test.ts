/**
 * REQUIRED IN-IMAGE TEXT — the glyphs reach the prompt, the judges, and the
 * repair, and they all quote the SAME string.
 *
 * Production job_1789945743706_8ayo2w19e shipped four pages whose plot turned
 * on legible lettering. The Visual Bible declared the strings correctly
 * (ART007 text "C A S a"); nothing carried them into the page prompt, because
 * `text` had one consumer — the VB reference CELL — and the REQUIRED OBJECTS
 * block is NAME ONLY by ruling. The glyphs therefore travelled as pixels and
 * their spelling and ORDER were never stated. p16 rendered "C A a".
 *
 * These pin BEHAVIOUR, never wording: that a declared string ARRIVES in the
 * built page prompt, in all three judge prompts, and in the repair clause, and
 * that a page declaring none is unchanged. A prompt may be reworded freely; it
 * may not stop carrying its input.
 *
 * Offline and free: nothing here calls a model.
 */
import { describe, it, beforeAll, expect } from 'vitest';

const rt = require('../../server/lib/requiredText');
const PB = require('../../server/lib/promptBuilders');
const { loadPromptTemplates, buildEvaluationPrompt, PROMPT_TEMPLATES, fillTemplate } = require('../../server/services/prompts');
const { bucketForType } = require('../../server/lib/evalBuckets');

// A generic archetype, never a test story's own cast (docs/SETTLED.md).
const VB = {
  artifacts: [
    { id: 'ART001', label: 'signpost', name: 'signpost', type: 'object', description: 'a wooden signpost', text: 'WXYZ' },
    { id: 'ART002', label: 'lantern', name: 'lantern', type: 'object', description: 'a plain lantern' },
  ],
  animals: [], vehicles: [], clothing: [], locations: [], mainCharacters: [], secondaryCharacters: [],
};

const sceneWith = (objectId: string) => [
  'A child stands before the wooden signpost on a path. Medium shot.',
  '',
  '---METADATA---',
  JSON.stringify({
    sceneIntent: 'The child reads the signpost.',
    characters: [], objects: [objectId], interactions: [],
    imageSummary: 'A child before a signpost.', population: 'cast_only', textPosition: 'top-left',
  }, null, 2),
  '---END METADATA---',
].join('\n');

const SCENE_WITH_TEXT = sceneWith('ART001');
const SCENE_WITHOUT_TEXT = sceneWith('ART002');

describe('collectRequiredTexts — resolving declared strings', () => {
  it('resolves a VB id to its image-facing label plus the declared string', () => {
    const items = rt.collectRequiredTexts({ objectIds: ['ART001'], visualBible: VB });
    expect(items).toHaveLength(1);
    expect(items[0].text).toBe('WXYZ');
    expect(items[0].label).toBeTruthy();
  });

  it('ignores an element that declares no text', () => {
    expect(rt.collectRequiredTexts({ objectIds: ['ART002'], visualBible: VB })).toEqual([]);
  });

  it('resolves a dotted state id back to the base entry that holds the text', () => {
    const items = rt.collectRequiredTexts({ objectIds: ['ART001.2'], visualBible: VB });
    expect(items).toHaveLength(1);
    expect(items[0].text).toBe('WXYZ');
  });

  it('deduplicates the same string on the same element', () => {
    expect(rt.collectRequiredTexts({ objectIds: ['ART001', 'ART001'], visualBible: VB })).toHaveLength(1);
  });

  it('THROWS rather than dropping a declared string it cannot label — no fallback', () => {
    expect(() => rt.collectRequiredTexts({ entries: [{ entry: { id: 'ART009', text: 'WXYZ' }, label: '' }] }))
      .toThrow(/declares text/);
  });
});

describe('the page prompt carries the string', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('quotes the declared string, and states its order, in the BUILT page prompt', () => {
    const built = PB.buildImagePrompt(SCENE_WITH_TEXT, {}, null, VB, 4, null, {});
    expect(built).toContain('"WXYZ"');
    // The ordering statement is the half the p16 failure needed: the prompt
    // named the characters and never said what the sign READS.
    expect(built).toContain(rt.REQUIRED_TEXT_RULE);
  });

  it('emits nothing for a page whose elements declare no string', () => {
    const built = PB.buildImagePrompt(SCENE_WITHOUT_TEXT, {}, null, VB, 4, null, {});
    expect(built).not.toContain('REQUIRED TEXT:');
    expect(built).not.toContain('WXYZ');
  });

  it('leaves no unfilled placeholder on either path', () => {
    for (const scene of [SCENE_WITH_TEXT, SCENE_WITHOUT_TEXT]) {
      expect(PB.buildImagePrompt(scene, {}, null, VB, 4, null, {})).not.toContain('{REQUIRED_TEXT}');
    }
  });

  it('places the block in the tail the prompt shrinker never cuts', () => {
    const built = PB.buildImagePrompt(SCENE_WITH_TEXT, {}, null, VB, 4, null, {});
    // sectionAwareCut treats everything from **REQUIRED OBJECTS onward as tail.
    expect(built.indexOf('"WXYZ"')).toBeGreaterThan(built.indexOf('**REQUIRED OBJECTS'));
  });
});

describe('generator and critic are given the SAME rule', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  const block = () => rt.buildRequiredTextRulesBlock(rt.collectRequiredTexts({ objectIds: ['ART001'], visualBible: VB }));

  it('the one rule constant reaches the page prompt AND all three judge prompts', () => {
    const generator = PB.buildImagePrompt(SCENE_WITH_TEXT, {}, null, VB, 4, null, {});
    const quality = buildEvaluationPrompt({ originalPrompt: 'scene', textRules: block() });
    const semantic = fillTemplate(PROMPT_TEMPLATES.imageSemantic, { TEXT_RULES: block() });
    const compliance = fillTemplate(PROMPT_TEMPLATES.imagePromptCompliance, { TEXT_RULES: block() });
    for (const p of [generator, quality, semantic, compliance]) {
      expect(p).toContain(rt.REQUIRED_TEXT_RULE);
      expect(p).toContain('"WXYZ"');
    }
  });

  it('a judge given no allow-list carries neither the block nor the string', () => {
    const quality = buildEvaluationPrompt({ originalPrompt: 'scene' });
    expect(quality).not.toContain('WXYZ');
    expect(quality).not.toContain('{TEXT_RULES}');
  });

  it('every judge that can emit `required_text` declares it in its own type vocabulary', () => {
    for (const tpl of [PROMPT_TEMPLATES.imageEvaluation, PROMPT_TEMPLATES.imageSemantic, PROMPT_TEMPLATES.imagePromptCompliance]) {
      expect(tpl).toContain('`required_text`');
    }
    // The consolidator RELABELS a type it does not know, and consolidated
    // issues are the default scoring source.
    expect(PROMPT_TEMPLATES.feedbackConsolidator).toContain('`required_text`');
  });
});

describe('the repair path can paint the string', () => {
  it('quotes the string in the repair clause', () => {
    const clause = rt.buildRequiredTextRepairClause(rt.collectRequiredTexts({ objectIds: ['ART001'], visualBible: VB }));
    expect(clause).toContain('"WXYZ"');
    expect(clause).toContain(rt.REQUIRED_TEXT_RULE);
  });

  it('is empty for a page with no declared string', () => {
    expect(rt.buildRequiredTextRepairClause([])).toBe('');
  });

  it("the repair text guard no longer forbids what the clause asks for", () => {
    const { applyRepairStyleGuard } = require('../../server/services/prompts');
    const guarded = applyRepairStyleGuard('{REPAIR_TEXT_GUARD}');
    expect(guarded).toMatch(/quotes as words to paint/);
  });
});

describe('the scored type is registered', () => {
  it('routes to its OWN bucket, never into rendered_text', () => {
    expect(bucketForType('required_text')).toBe('required_text');
    expect(bucketForType('rendered_text')).toBe('rendered_text');
  });

  it('is inpaintable — repainting letters is a targeted fix, not a full regen', () => {
    const { typesAreInpaintable } = require('../../server/lib/repairLogic');
    expect(typesAreInpaintable(['required_text'])).toBe(true);
  });

  it('costs points on the consolidated shape (no silent zero)', () => {
    const { deductionPoints } = require('../../server/lib/scoring');
    expect(deductionPoints({ type: 'required_text', severity: 'major' })).toBeGreaterThan(0);
  });
});
