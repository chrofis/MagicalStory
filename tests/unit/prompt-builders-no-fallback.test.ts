/**
 * Review 2026-10-04 B3 / B4.
 *  B3: with nobody declared main, the focus character is chars[0]; it must not
 *      also be listed in "everyone else".
 *  B4: a missing template THROWS (NO FALLBACKS, owner decision #4). Four builders
 *      used to return a hardcoded prompt, which hides a broken deploy.
 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest';

// @ts-ignore — CommonJS libs
const PB = require('../../server/lib/promptBuilders.js');
// @ts-ignore
const { PROMPT_TEMPLATES, loadPromptTemplates } = require('../../server/services/prompts.js');

beforeAll(async () => { await loadPromptTemplates(); });

describe('B3 pickMainCharacters', () => {
  it('no declared main: focus is chars[0] and is NOT in others', () => {
    const chars = [{ id: 'a', name: 'A', age: 6 }, { id: 'b', name: 'B', age: 5 }, { id: 'c', name: 'C', age: 4 }];
    const { mains, focus, others } = PB.pickMainCharacters({ characters: chars });
    expect(mains).toEqual([]);
    expect(focus.name).toBe('A');
    expect(others.map((c: any) => c.name)).toEqual(['B', 'C']);
  });
  it('declared main: unchanged', () => {
    const chars = [{ id: 'a', name: 'A', age: 6 }, { id: 'b', name: 'B', age: 9, isMain: true }];
    const { focus, others } = PB.pickMainCharacters({ characters: chars });
    expect(focus.name).toBe('B');
    expect(others.map((c: any) => c.name)).toEqual(['A']);
  });
});

describe('B4 a missing template throws', () => {
  const saved: Record<string, any> = {};
  const drop = (...keys: string[]) => keys.forEach(k => { saved[k] = PROMPT_TEMPLATES[k]; PROMPT_TEMPLATES[k] = undefined; });
  afterEach(() => { for (const k of Object.keys(saved)) PROMPT_TEMPLATES[k] = saved[k]; });

  const chars = [{ id: 'a', name: 'Mia', age: 6, isMain: true }];
  it('buildSceneExpansionPrompt', () => {
    drop('sceneExpansion');
    expect(() => PB.buildSceneExpansionPrompt(1, 'text', chars, 'en', null, '', null, { jevBackup: true })).toThrow(/scene-expansion template not loaded/);
  });
  it('buildSceneDescriptionPrompt (iterate and free-iterate)', () => {
    drop('sceneDescriptions', 'sceneIterationFree');
    expect(() => PB.buildSceneDescriptionPrompt(1, 'text', chars)).toThrow(/scene-iteration template not loaded/);
    expect(() => PB.buildSceneDescriptionPrompt(1, 'text', chars, '', 'en', null, [], {}, '', '', null, null, { freeIterate: true })).toThrow(/scene-iteration-free template not loaded/);
  });
  it('buildImagePrompt', () => {
    drop('imageGeneration');
    expect(() => PB.buildImagePrompt('A scene.', { characters: chars, artStyle: 'watercolor', ageFrom: 3, ageTo: 8 }, chars)).toThrow(/image-generation template not loaded/);
  });
  it('buildTrialStoryPrompt', () => {
    drop('storyTrial');
    expect(() => PB.buildTrialStoryPrompt({ characters: chars, language: 'en', storyDetails: 'x' }, 4)).toThrow(/story-trial template not loaded/);
  });
});

/**
 * B2 (review 2026-10-04): the Lab's scene-expansion stages passed no `jevBackup`,
 * so shotRuleFills read undefined as free-shot rules while fixedFieldsRule read it
 * as the fixed-fields rule: one prompt, two opposite statements about who owns
 * the shot. One reader (isJevBackup) now serves both; the Lab passes true.
 */
describe('B2 jevBackup is read one way by every rule that branches on it', () => {
  const chars = [{ id: 'a', name: 'Mia', age: 6, isMain: true }];
  const build = (options: any) => PB.buildSceneExpansionPrompt(1, 'PLAN: x', chars, 'en', null, '', null, options);
  // @ts-ignore
  const { fixedFieldsRule } = require('../../server/lib/jevDecisions.js');
  it('an omitted flag is Jev-active for the shot rules AND the fixed-fields rule (it used to split)', () => {
    const omitted = build({});
    expect(omitted).toContain(fixedFieldsRule(false));
    expect(omitted).toBe(build({ jevBackup: false }));
  });
  it('the fixed-fields rule and the shot rules follow the same flag', () => {
    const backup = build({ jevBackup: true });
    const live = build({ jevBackup: false });
    expect(backup).toContain(fixedFieldsRule(true));
    expect(backup).not.toContain(fixedFieldsRule(false));
    expect(live).toContain(fixedFieldsRule(false));
    expect(live).not.toContain(fixedFieldsRule(true));
    expect(backup).not.toBe(live);
  });
});
