/**
 * RECORDED FEATURES — one source for the page render and the entity grid judge
 * (owner, 2026-09-26).
 *
 * The grid judge read watercolour highlight washes on a styled sheet as a skin
 * condition the character does not have and filed a CRITICAL (staging
 * job_1790446348343_z3fw660ie). The judge is now told the character's recorded
 * marks and reports no skin mark they do not name; the page render states the
 * same marks, so a recorded mark the judge can charge is one the generator was
 * given (sibling set entity-grid-generator-vs-critic).
 *
 * Pinned: BEHAVIOUR — what the built page prompt and the built judge prompt
 * carry for a character with and without recorded marks. Never prompt wording.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { GoogleGenerativeAI } = require_('@google/generative-ai');
const PB = require_('../../server/lib/promptBuilders');
const entity = require_('../../server/lib/entityConsistency.js');

const MARKS = 'light freckles, a small scar above the left eyebrow';
const CAST = [
  { id: 'c1', name: 'Mila', age: 8, gender: 'girl', physical: { other: MARKS, hairColor: 'brown' } },
  { id: 'c2', name: 'Tom', age: 9, gender: 'boy', physical: { other: 'none', hairColor: 'blonde' } },
];
const inputData: any = {
  title: 'The Meadow', characters: CAST, mainCharacters: ['c1'], language: 'en', pages: 12,
  storyCategory: 'adventure', storyType: 'adventure', artStyle: 'watercolor', relationships: {}, relationshipTexts: {},
};
const VISUAL_BIBLE: any = { artifacts: [], locations: [], vehicles: [], characters: [], animals: [] };
const brief = `Mila and Tom run across a meadow.\n\n---METADATA---\n${JSON.stringify({
  sceneIntent: 'Mila and Tom run across a meadow',
  characters: [
    { name: 'Mila', clothing: 'standard', position: 'left foreground', depth: 'foreground', looksAt: 'Tom' },
    { name: 'Tom', clothing: 'standard', position: 'right midground', depth: 'midground', looksAt: 'Mila' },
  ],
  shot: 'wide', objects: [], textPosition: 'bottom-left',
})}`;
const buildPage = () => String(PB.buildImagePrompt(brief, inputData, CAST, VISUAL_BIBLE, 4, null, {}));

let sentPrompt = '';
const original = GoogleGenerativeAI.prototype.getGenerativeModel;
beforeAll(async () => {
  await require_('../../server/services/prompts').loadPromptTemplates();
  GoogleGenerativeAI.prototype.getGenerativeModel = () => ({
    generateContent: async (parts: unknown[]) => {
      sentPrompt = String(parts[0]);
      return { response: { text: () => JSON.stringify({ consistent: true, score: 10, fixable_issues: [], clothing_check: [], summary: 'ok' }) } };
    },
  });
});
afterAll(() => { GoogleGenerativeAI.prototype.getGenerativeModel = original; });

const manifest = { cells: [{ letter: 'R', isReference: true, clothing: 'standard' }, { letter: 'A', pageNumber: 3, clothing: 'standard' }] };
const judge = async (extra: object) => {
  sentPrompt = '';
  await entity.evaluateEntityConsistency(Buffer.from('x'), manifest, {
    entityType: 'character', entityName: 'Mila', cellCount: 2, clothingCategory: 'standard', expectedClothing: 'a red coat', ...extra,
  });
  return sentPrompt;
};

describe('recorded features', () => {
  it('reads the recorded marks, and nothing for a "none" record', () => {
    expect(PB.recordedFeatures(CAST[0])).toBe(MARKS);
    expect(PB.recordedFeatures(CAST[1])).toBe('');
    expect(PB.recordedFeatures({ name: 'X' })).toBe('');
  });

  it('the page render states each scene character\'s recorded marks, and only theirs', () => {
    const prompt = buildPage();
    const line = prompt.split('\n').find(l => l.startsWith('- Mila:') && l.includes(MARKS));
    expect(line, 'Mila\'s recorded marks are not in the page prompt').toBeTruthy();
    expect(prompt.split('\n').some(l => l.startsWith('- Tom:') && /none/i.test(l))).toBe(false);
  });

  it('the judge is told the same recorded marks the page render was given', async () => {
    const prompt = await judge({ recordedFeatures: PB.recordedFeatures(CAST[0]) });
    expect(prompt).toContain(MARKS);
    expect(buildPage()).toContain(MARKS);
    expect(prompt).not.toMatch(/\{RECORDED_FEATURES\}/);
  });

  it('a character with no recorded marks is told so, rather than left silent', async () => {
    const none = await judge({ recordedFeatures: '' });
    const withMarks = await judge({ recordedFeatures: MARKS });
    expect(none).not.toContain(MARKS);
    // The two prompts differ only in that one line: the empty record is stated.
    expect(none.length).toBeGreaterThan(0);
    expect(none).not.toBe(withMarks);
    expect(none).not.toMatch(/\{RECORDED_FEATURES\}/);
  });

  it('an object, and a Visual Bible secondary (null record), get no recorded-features line', async () => {
    const secondary = await judge({ recordedFeatures: null });
    const none = await judge({ recordedFeatures: '' });
    expect(secondary.length).toBeLessThan(none.length);
    expect(secondary).not.toMatch(/\{RECORDED_FEATURES\}/);
  });
});
