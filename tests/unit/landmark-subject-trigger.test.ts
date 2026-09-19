/**
 * THE LANDMARK GUARD TRIGGERS ON THE FINDING'S SUBJECT, NOT ITS TYPE.
 *
 * Measured 2026-09-18 over every stored page carrying a landmark reference
 * photo — 429 on staging, 413 on production, 842 in all, 796 of them protected
 * (present-day era) and carrying 1,019 removal-shaped fixes between them:
 *
 *   - `object_presence` — the old trigger — accounts for 63 of those 1,019, and
 *     only 13 of the 63 are about the real place. The other 50 are props: a
 *     held shell, a scattered map, a story's own dragon egg read as "a large
 *     red-and-grey ball".
 *   - 61 removal-shaped fixes whose subject plainly IS the real place arrive as
 *     `setting`, `object`, `extra_object`, `background`, `environment` and
 *     `anachronism`, and the type trigger cannot see one of them.
 *
 * So the judge is asked, and code acts on the answer: `landmark_element` is a
 * declared boolean on every finding, and the guard drops a removal-shaped fix
 * when it is true, whatever the type says. Classification stays in the prompt
 * (docs/SETTLED.md); code only reads a field.
 *
 * The third state is the one that matters for safety. A finding with no
 * `landmark_element` is UNDECLARED, never `false` — it falls back to the
 * pre-2026-09-18 type rule, so every stored finding keeps the outcome it was
 * scored under and a judge that stops declaring degrades to the old guard
 * rather than to none.
 *
 * Companion evidence file (pre-change measurement, still true of undeclared
 * findings): tests/unit/landmark-guard-scope-evidence.test.ts.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const {
  computeLandmarkProtection,
  buildLandmarkContextBlock,
  buildLandmarkComplianceBlock,
  landmarkSubject,
  isRemovalShapedFix,
  filterProtectedRemovals,
  LANDMARK_ELEMENT_FIELD,
} = require_('../../server/lib/landmarkProtection');
const { loadPromptTemplates, PROMPT_TEMPLATES, buildEvaluationPrompt } = require_('../../server/services/prompts');
const { buildSemanticPrompt } = require_('../../server/lib/sceneValidator');

beforeAll(async () => { await loadPromptTemplates(); });

const LINDENHOF = [{ name: 'Lindenhof plaza with linden trees' }];
const protectedPage = () => computeLandmarkProtection({ landmarkPhotos: LINDENHOF, era: 'present day' });
const historicalPage = () => computeLandmarkProtection({ landmarkPhotos: LINDENHOF, era: 'medieval Switzerland, ~1300' });
const noLandmark = () => computeLandmarkProtection({ landmarkPhotos: [], era: 'present day' });

/** Stored on staging job_1789681157795_wkt20ckod p11 — both about the same background. */
const P11_WINDOWS = {
  type: 'object_presence', severity: 'MAJOR',
  description: "Stone wall includes 'small windows' and 'white window frames' not mentioned in prompt or contract",
  fix: "Remove windows and white frames from stone wall to match prompt's 'old retaining wall' without architectural features",
};
const P11_BACKGROUND = {
  type: 'setting', severity: 'MAJOR',
  description: 'Background includes cityscape, buildings, cranes not present in prompt; contradicts Lindenhof plaza setting description',
  fix: "Replace urban background with natural hillside or wooded area consistent with Lindenhof plaza's actual layout",
};

describe('landmarkSubject — three states, and the third is not the second', () => {
  it('reads a real boolean, either way', () => {
    expect(landmarkSubject({ landmark_element: true })).toBe('landmark');
    expect(landmarkSubject({ landmark_element: false })).toBe('other');
  });

  it('reads the string spellings a JSON model emits', () => {
    expect(landmarkSubject({ landmark_element: 'true' })).toBe('landmark');
    expect(landmarkSubject({ landmark_element: 'false' })).toBe('other');
  });

  it('a missing, null, empty or unrecognised value is UNDECLARED, never false', () => {
    for (const issue of [{}, { landmark_element: null }, { landmark_element: '' },
      { landmark_element: 'unknown' }, { landmark_element: 0 }, { landmark_element: 1 }]) {
      expect(landmarkSubject(issue)).toBe('undeclared');
    }
    expect(landmarkSubject(null)).toBe('undeclared');
  });

  it('names the field once, for the prompt contract and the reader alike', () => {
    expect(LANDMARK_ELEMENT_FIELD).toBe('landmark_element');
  });
});

describe('the subject trigger catches what the type trigger missed', () => {
  /** The production type vocabulary, each declared as being about the real place. */
  const DECLARED_LANDMARK = [
    { type: 'setting', severity: 'MAJOR', landmark_element: true,
      description: 'Background includes cityscape and buildings not present in prompt',
      fix: 'Replace urban background with natural hillside or wooded area' },
    { type: 'object', severity: 'MODERATE', landmark_element: true,
      description: 'An unrequested flag is present on the tower.',
      fix: 'Remove the flag from the tower.' },
    { type: 'extra_object', severity: 'MINOR', landmark_element: true,
      description: 'A stone building is visible in the left-midground.',
      fix: 'Remove the stone building and replace with open lake water.' },
    { type: 'background', severity: 'MAJOR', landmark_element: true,
      description: 'Background shows the town panorama rather than the hillside the prompt names.',
      fix: 'Replace background with hillside vegetation; remove town panorama.' },
    { type: 'environment', severity: 'MAJOR', landmark_element: true,
      description: 'Mountains and sailboats are visible behind the chapel.',
      fix: 'Remove mountains and sailboats from background.' },
  ];

  it('drops every one of them on a protected page, whatever the type', () => {
    const { kept, dropped } = filterProtectedRemovals(DECLARED_LANDMARK, protectedPage(), { quiet: true });
    expect(dropped).toHaveLength(DECLARED_LANDMARK.length);
    expect(kept).toHaveLength(0);
  });

  it('keeps the same findings on a page with no landmark attached', () => {
    const { kept, dropped } = filterProtectedRemovals(DECLARED_LANDMARK, noLandmark(), { quiet: true });
    expect(dropped).toHaveLength(0);
    expect(kept).toHaveLength(DECLARED_LANDMARK.length);
  });

  it('keeps them on a historical page — modern infrastructure stays a finding there', () => {
    const { kept, dropped } = filterProtectedRemovals(DECLARED_LANDMARK, historicalPage(), { quiet: true });
    expect(dropped).toHaveLength(0);
    expect(kept).toHaveLength(DECLARED_LANDMARK.length);
  });

  it('a landmark finding whose fix removes nothing survives — the guard stops edits, not findings', () => {
    const corrective = {
      type: 'setting', severity: 'MAJOR', landmark_element: true,
      description: 'The tower silhouette does not match the reference photo.',
      fix: 'Redraw the tower silhouette to match the attached reference photo.',
    };
    const { kept, dropped } = filterProtectedRemovals([corrective], protectedPage(), { quiet: true });
    expect(dropped).toHaveLength(0);
    expect(kept).toEqual([corrective]);
  });
});

describe('a declared NON-landmark subject ends the false drops', () => {
  /** The two measured pages that stored a perfect 100 with the finding suppressed. */
  const PLOT_OBJECTS = [
    { type: 'object_presence', severity: 'CRITICAL', landmark_element: false,
      description: "The object Julian is lifting is described as a 'large red-and-grey ball' rather than the specified 'rusty-red mottled egg'.",
      fix: 'Replace the red-and-grey ball with a large, football-sized, rusty-red mottled egg.' },
    { type: 'object_presence', severity: 'MAJOR', landmark_element: false,
      description: 'The compact rectangular plastic handlebar lamp is depicted as a generic black flashlight.',
      fix: "Replace the black flashlight in Levin's right hand with a compact rectangular handlebar lamp." },
  ];

  it('keeps an object_presence removal once the judge says it is not the landmark', () => {
    const { kept, dropped } = filterProtectedRemovals(PLOT_OBJECTS, protectedPage(), { quiet: true });
    expect(dropped).toHaveLength(0);
    expect(kept).toHaveLength(2);
  });
});

describe('an UNDECLARED finding keeps the pre-2026-09-18 outcome, exactly', () => {
  it('drops object_presence and keeps setting — the measured p11 pair, as stored', () => {
    const { kept, dropped } = filterProtectedRemovals(
      [P11_WINDOWS, P11_BACKGROUND], protectedPage(), { pageNumber: 11, quiet: true });
    expect(dropped).toHaveLength(1);
    expect(dropped[0].type).toBe('object_presence');
    expect(kept).toHaveLength(1);
    expect(kept[0].type).toBe('setting');
  });

  it('with the subjects declared, the same page guards the background and releases the windows', () => {
    const declared = [
      { ...P11_WINDOWS, landmark_element: false },   // white window frames the wall does not have
      { ...P11_BACKGROUND, landmark_element: true }, // the real Zurich cityscape
    ];
    const { kept, dropped } = filterProtectedRemovals(declared, protectedPage(), { pageNumber: 11, quiet: true });
    expect(dropped).toHaveLength(1);
    expect(dropped[0].type).toBe('setting');
    expect(kept).toHaveLength(1);
    expect(kept[0].type).toBe('object_presence');
  });

  it('null and "unknown" are undeclared too — never read as "safe to act on"', () => {
    const nulled = { ...P11_BACKGROUND, landmark_element: null };
    const unknown = { ...P11_WINDOWS, landmark_element: 'unknown' };
    const { kept, dropped } = filterProtectedRemovals([nulled, unknown], protectedPage(), { quiet: true });
    // Same as the stored pair above: the type rule decides, the value does not.
    expect(dropped.map((d: any) => d.type)).toEqual(['object_presence']);
    expect(kept.map((k: any) => k.type)).toEqual(['setting']);
  });
});

describe('isRemovalShapedFix reads an EDIT INSTRUCTION, never a description', () => {
  it('a stand-in fix built from the description is not an edit instruction', () => {
    const synthesized = {
      type: 'object_presence', severity: 'MAJOR', fixAuthored: false,
      description: 'Remove the stone wall from the background.',
      fix: 'Fix: Remove the stone wall from the background.',
    };
    expect(isRemovalShapedFix(synthesized)).toBe(false);
    const { kept, dropped } = filterProtectedRemovals([synthesized], protectedPage(), { quiet: true });
    expect(dropped).toHaveLength(0);
    expect(kept).toHaveLength(1);
  });

  it('an authored fix with the same words still reads as a removal', () => {
    expect(isRemovalShapedFix({ fixAuthored: true, fix: 'Remove the stone wall from the background.' })).toBe(true);
    // Unstamped findings (every stored one) are treated as authored.
    expect(isRemovalShapedFix({ fix: 'Remove the stone wall from the background.' })).toBe(true);
  });

  it('the NOUN "strip" is not a removal; the verb with an object is', () => {
    // All five corpus matches of the bare token were the noun.
    expect(isRemovalShapedFix({ fix: 'Adjust the camera angle so the bridge appears as a distant, bright strip at the top of the frame.' })).toBe(false);
    expect(isRemovalShapedFix({ fix: 'Adjust the sky strip to be clearly in the upper right of the frame.' })).toBe(false);
    expect(isRemovalShapedFix({ fix: 'Strip the neon signage off the bridge beams.' })).toBe(true);
  });
});

describe('ONE landmark block, injected into every judge', () => {
  it('the compliance name is the context builder, not a second implementation', () => {
    expect(buildLandmarkComplianceBlock).toBe(buildLandmarkContextBlock);
  });

  it('a protected page gets the protection prose AND the subject contract', () => {
    const block = buildLandmarkContextBlock(protectedPage());
    expect(block).toContain('Lindenhof plaza with linden trees');
    expect(block).toContain('landmark_element');
  });

  it('a historical page keeps the era semantics and still asks for the subject', () => {
    const block = buildLandmarkContextBlock(historicalPage());
    expect(block).toContain('remains a legitimate finding');
    expect(block).toContain('landmark_element');
  });

  it('a page with no landmark gets no block, so the flag is not asked for', () => {
    expect(buildLandmarkContextBlock(noLandmark())).toBe('');
  });

  it('all three judge templates carry the placeholder', () => {
    for (const key of ['imagePromptCompliance', 'imageSemantic', 'imageEvaluation']) {
      expect(PROMPT_TEMPLATES[key], `${key} template loaded`).toBeTruthy();
      expect(PROMPT_TEMPLATES[key], key).toContain('{LANDMARK_CONTEXT}');
    }
  });
});

describe('no judge prompt ships with a hole where the block goes', () => {
  const noPlaceholderLeft = (prompt: string) => expect(prompt).not.toContain('{LANDMARK_CONTEXT}');

  it('the quality judge fills it, and defaults to (none) for a caller without a landmark', () => {
    const withNone = buildEvaluationPrompt({ originalPrompt: 'a square at midday' });
    noPlaceholderLeft(withNone);
    expect(withNone).toContain('(none)');
    const withBlock = buildEvaluationPrompt({
      originalPrompt: 'a square at midday',
      landmarkContext: buildLandmarkContextBlock(protectedPage()),
    });
    noPlaceholderLeft(withBlock);
    expect(withBlock).toContain('Lindenhof plaza with linden trees');
  });

  it('the semantic judge fills it, and defaults to (none) for a caller without a landmark', () => {
    const withNone = buildSemanticPrompt(PROMPT_TEMPLATES.imageSemantic, {
      storyText: 'text', sceneHint: 'hint', imagePrompt: 'prompt',
    });
    noPlaceholderLeft(withNone);
    const withBlock = buildSemanticPrompt(PROMPT_TEMPLATES.imageSemantic, {
      storyText: 'text', sceneHint: 'hint', imagePrompt: 'prompt',
      evalContext: { landmarkContext: buildLandmarkContextBlock(protectedPage()) },
    });
    noPlaceholderLeft(withBlock);
    expect(withBlock).toContain('Lindenhof plaza with linden trees');
  });
});
