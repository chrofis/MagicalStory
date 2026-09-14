import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

// CJS registry — the prompt store, evalPipeline and sceneValidator all reach
// each other with plain require() (same pattern as extra-character-type.test.ts).
const require_ = createRequire(import.meta.url);
const { buildExpectedCastBlock, evaluateThreeStage, supersedePresenceFindings, PRESENCE_COUNT_TYPES } = require_('../../server/lib/evalPipeline');
const { buildSemanticPrompt } = require_('../../server/lib/sceneValidator');
const { loadPromptTemplates, PROMPT_TEMPLATES } = require_('../../server/services/prompts');
const textModels = require_('../../server/lib/textModels');
const { vbNonHumanNames } = require_('../../server/lib/bboxDetection');

// THE DEFECT (2026-09-14). One animal on one story was reported as
// `missing_character`, `extra_character` AND `duplicate_identity` — three
// contradictory verdicts about the same entity. Two prompts classify an animal
// in opposite ways (the quality evaluator's `matches[]` calls it a FIGURE, the
// blind inventory files it in `objects[]`), and the compliance judge consumed
// both with no cast roster of its own and improvised a label for the orphan.
//
// Every fixture below is the REAL stored shape, pulled from staging story
// job_1789348171785_9oxos7dwv (18 pages, two VB animals, page 7 carrying the
// stored `extra_character` finding on the dog). Nothing here is hand-built.
const fixture = require_('./fixtures/animal-cast-job_1789348171785_9oxos7dwv.json');
const page = (n: number) => fixture.pages.find((p: any) => p.pageNumber === n);
const P5 = page(5);
const P7 = page(7);
const animal = fixture.visualBible.animals[0];   // the terrier mix, VB id ANI001

beforeAll(async () => { await loadPromptTemplates(); });

describe('the blind judges receive the EXPECTED CAST roster', () => {
  // The roster the quality evaluator already got. Its kind labels are the whole
  // point: a line reading "<name> (animal)" is what tells a judge the entry can
  // never be satisfied — or violated — by a person-figure.
  const cast = () => buildExpectedCastBlock({
    sceneCharacters: P7.sceneCharacters,
    sceneMetadata: P7.sceneMetadata,
    sceneHint: P7.prompt,
    originalPrompt: P7.prompt,
    visualBible: fixture.visualBible,
    pageNumber: 7,
  });

  it('the page roster tags the story animal with its kind', () => {
    const c = cast();
    expect(c.declared).toBe(true);
    expect(c.names).toContain(animal.name);
    expect(c.block).toContain(`${animal.name} (animal`);
    // And the arithmetic still knows not to count it as a person.
    expect(c.nonHumanNames.map((n: string) => n.toLowerCase())).toContain(animal.name.toLowerCase());
  });

  // BUILT PROMPT, not the template: evaluateThreeStage is driven for real with
  // the model call stubbed, so this asserts what the judge is actually sent.
  const buildCompliancePrompt = async (p: any) => {
    const original = textModels.callTextModel;
    let captured = '';
    textModels.callTextModel = async (input: string) => {
      captured = input;
      return { text: '{"verdict":"PASS","fixable_issues":[]}', usage: { input_tokens: 1, output_tokens: 1 } };
    };
    try {
      await evaluateThreeStage('data:image/jpeg;base64,AAAA', p.prompt, p.prompt, {
        pageContext: `PAGE ${p.pageNumber}`,
        storyText: 'page prose',
        inventoryPromise: Promise.resolve({
          figures: [], objects: p.threeStageResult.visionInventoryObjects || [],
          interactions: [], setting: null, lettering: [], rendering: {},
          inputTokens: 0, outputTokens: 0,
        }),
        qualityFiguresPromise: Promise.resolve({ figures: [], matches: [] }),
        visualBible: fixture.visualBible,
        expectedCast: buildExpectedCastBlock({
          sceneCharacters: p.sceneCharacters,
          sceneMetadata: p.sceneMetadata,
          sceneHint: p.prompt,
          originalPrompt: p.prompt,
          visualBible: fixture.visualBible,
          pageNumber: p.pageNumber,
        }).block,
      });
    } finally {
      textModels.callTextModel = original;
    }
    return captured;
  };

  it('the compliance judge is sent the roster, the animal tagged, no placeholder left behind', async () => {
    const built = await buildCompliancePrompt(P7);
    expect(built.length).toBeGreaterThan(0);
    expect(built).toContain(`${animal.name} (animal`);
    expect(built).not.toContain('{EXPECTED_CAST}');
    expect(built).not.toContain('{ORIGINAL_PROMPT}');
  });

  it('the compliance judge is told an (animal) entry pairs against objects[], and which codes it may not use', async () => {
    const built = await buildCompliancePrompt(P7);
    // BEHAVIOUR, not wording: the rule must name objects[] as the place to look
    // and forbid all three presence codes the defect produced.
    const rule = built.split('STEP 1: PAIR FIGURES BY ZONE')[1] || '';
    expect(rule).toMatch(/\(animal\)/);
    expect(rule).toMatch(/objects/);
    expect(rule).toMatch(/unverified_absence/);
    for (const code of ['missing_character', 'extra_character', 'duplicate_identity']) {
      expect(rule).toContain(code);
    }
  });

  it('the semantic judge is sent the roster too, and told an (animal) entry is not a named character', () => {
    const built = buildSemanticPrompt(PROMPT_TEMPLATES.imageSemantic, {
      storyText: 'page prose',
      sceneHint: P7.prompt,
      imagePrompt: P7.prompt,
      evalContext: { expectedCast: cast().block },
    });
    expect(built).toContain(`${animal.name} (animal`);
    expect(built).not.toContain('{EXPECTED_CAST}');
    // An entry tagged (animal) is judged as an animal, never counted among the
    // named characters — which is the check that produced the false absence.
    expect(built).toMatch(/`\(animal\)`/);
  });

  it('a caller with no roster still gets a clean prompt (unchanged behaviour)', () => {
    const built = buildSemanticPrompt(PROMPT_TEMPLATES.imageSemantic, {
      storyText: 'page prose', sceneHint: 'a hint', imagePrompt: 'a prompt', evalContext: {},
    });
    expect(built).not.toContain('{EXPECTED_CAST}');
  });
});

describe('the compliance judge sees the WHOLE prompt, cast block included', () => {
  // Measured on this story: the animal's own block sits at char 3,914-5,565 on
  // five of its six pages, so the former `.substring(0, 3000)` handed the judge
  // a prompt that never named the animal it was being asked to place.
  it('the animal really does sit past the old 3000-char cut (guards the test)', () => {
    expect(P7.prompt.indexOf(animal.name)).toBeGreaterThan(3000);
    expect(P7.prompt.length).toBeGreaterThan(3000);
    // ...and on the one page where it did not, the old cut was harmless — which
    // is why this shipped broken for so long.
    expect(P5.prompt.indexOf(animal.name)).toBeLessThan(3000);
  });

  it('the built compliance prompt contains the page prompt verbatim, end to end', async () => {
    const original = textModels.callTextModel;
    let captured = '';
    textModels.callTextModel = async (input: string) => {
      captured = input;
      return { text: '{"verdict":"PASS","fixable_issues":[]}', usage: {} };
    };
    try {
      await evaluateThreeStage('data:image/jpeg;base64,AAAA', P7.prompt, P7.prompt, {
        pageContext: 'PAGE 7',
        inventoryPromise: Promise.resolve({ figures: [], objects: [], interactions: [], setting: null, lettering: [], rendering: {} }),
        qualityFiguresPromise: Promise.resolve({ figures: [], matches: [] }),
        visualBible: fixture.visualBible,
        expectedCast: '',
      });
    } finally {
      textModels.callTextModel = original;
    }
    // Whole prompt, modulo the template filler's blank-line collapse: the
    // animal's own block (char 5,565 on this page) and the prompt's final
    // lines both survive, which the 3000-char cut made impossible.
    const flat = (s: string) => s.replace(/\n{3,}/g, '\n\n');
    expect(flat(captured)).toContain(flat(P7.prompt));
    const niaAt = P7.prompt.indexOf(animal.name);
    expect(captured).toContain(P7.prompt.slice(niaAt, niaAt + 200));
    expect(flat(captured)).toContain(flat(P7.prompt.slice(-200)));
  });
});

describe('a superseded presence finding does not survive into the consolidated record', () => {
  // scoring.js reads `evalResult.threeStageResult.fixableIssues` for the
  // compliance bucket and again for `scoreBreakdown.threeStage.issues`; from
  // there a finding reaches consolidatedPlan.deduped_issues and the repair
  // pipeline. Filtering a copy on the way into the merged list left the record
  // untouched, so a finding the presence arithmetic had superseded was still
  // repaired against.
  const stored = () => JSON.parse(JSON.stringify(P7.threeStageResult));

  it('the real stored page really does carry an extra_character on the animal (guards the test)', () => {
    const ts = stored();
    const presence = ts.fixableIssues.filter((i: any) => PRESENCE_COUNT_TYPES.has(String(i.type)));
    expect(presence.length).toBeGreaterThan(0);
    expect(presence[0].character).toBe(animal.name);
    expect(ts.complianceResult.fixable_issues.some((i: any) => PRESENCE_COUNT_TYPES.has(String(i.type)))).toBe(true);
  });

  it('prunes BOTH the mapped list and the judge\'s raw compliance list', () => {
    const ts = stored();
    const beforeMapped = ts.fixableIssues.length;
    const beforeRaw = ts.complianceResult.fixable_issues.length;
    const dropped = supersedePresenceFindings(ts);
    expect(dropped).toBe(1);
    expect(ts.fixableIssues).toHaveLength(beforeMapped - 1);
    expect(ts.complianceResult.fixable_issues).toHaveLength(beforeRaw - 1);
    for (const list of [ts.fixableIssues, ts.complianceResult.fixable_issues]) {
      expect(list.some((i: any) => PRESENCE_COUNT_TYPES.has(String(i.type)))).toBe(false);
      expect(list.some((i: any) => String(i.character) === animal.name)).toBe(false);
    }
  });

  it('leaves every non-presence finding exactly as the judge wrote it', () => {
    const ts = stored();
    const keep = ts.fixableIssues.filter((i: any) => !PRESENCE_COUNT_TYPES.has(String(i.type)));
    supersedePresenceFindings(ts);
    expect(ts.fixableIssues).toEqual(keep);
    expect(ts.fixableIssues.some((i: any) => i.type === 'action_interaction' && i.severity === 'CRITICAL')).toBe(true);
  });

  it('tolerates a page with no compliance result and one with no findings', () => {
    expect(supersedePresenceFindings(null)).toBe(0);
    expect(supersedePresenceFindings({})).toBe(0);
    expect(supersedePresenceFindings({ fixableIssues: [] })).toBe(0);
  });
});

describe('vbNonHumanNames reads the pool the Visual Bible actually has', () => {
  it('names the story animals, both by name and by VB id', () => {
    const names = vbNonHumanNames(fixture.visualBible);
    expect(names).toContain(animal.name.toLowerCase());
    expect(names).toContain(String(animal.id).toLowerCase());
  });

  it('a bible with no animals yields nothing, and a stray `creatures` key is not a source', () => {
    // `creatures` is written by nothing in the pipeline (0 of 122 staging
    // stories carry the key) — the read was deleted rather than left looking
    // like coverage. Pinned so re-adding it is a deliberate act.
    expect(vbNonHumanNames({})).toEqual([]);
    expect(vbNonHumanNames({ creatures: [{ id: 'CRE001', name: 'Grendel' }] })).toEqual([]);
  });
});
