import { describe, it, expect, beforeAll } from 'vitest';

const PB = require('../../server/lib/promptBuilders');
const { textNotAChecklistRule, TEXT_NOT_A_CHECKLIST_RULE } = PB;

// A7 (owner, 2026-09-19). TEXT_NOT_A_CHECKLIST reaches eight templates: four
// that AUTHOR a brief and four that JUDGE one. Every site filled the same
// string, so the Art Director — who writes the brief and scores nothing — was
// told what severity a finding may carry and to "Charge that one to the plan,
// never to a picture", which it has no means to do. The rule now has two
// views. The judge view is the default so a new call site that forgets the
// argument gets the COMPLETE rule rather than a silently weakened one.
//
// Asserted on the BUILT prompts, never on template text: a declared
// placeholder nobody fills is dropped silently by fillTemplate.
describe('the text-is-not-a-checklist rule is cut to its reader', () => {
  // The half both readers need: the picture stages one moment.
  const PERMISSION = 'its picture stages one moment';
  // The half only a reader who scores can act on.
  const VERDICT = 'Charge that one to the plan, never to a picture.';

  it('the author view carries the permission', () => {
    expect(textNotAChecklistRule({ role: 'author' })).toContain(PERMISSION);
  });

  it('the author view carries no verdict language it cannot act on', () => {
    const author = textNotAChecklistRule({ role: 'author' });
    expect(author).not.toContain(VERDICT);
    expect(author).not.toContain('not at any severity');
  });

  it('the judge view is a strict superset of the author view', () => {
    const author = textNotAChecklistRule({ role: 'author' });
    const judge = textNotAChecklistRule({ role: 'judge' });
    expect(judge).toContain(author);
    expect(judge.length).toBeGreaterThan(author.length);
    expect(judge).toContain(VERDICT);
  });

  // The whole point of the default: a forgetful new call site must not get the
  // weaker rule.
  it('the default view is the judge view', () => {
    expect(textNotAChecklistRule()).toBe(textNotAChecklistRule({ role: 'judge' }));
    expect(TEXT_NOT_A_CHECKLIST_RULE).toBe(textNotAChecklistRule({ role: 'judge' }));
  });

  describe('the built prompts', () => {
    const CHARACTERS = [{ id: 'c1', name: 'Mira', age: 7 }];
    const inputData: any = {
      title: 'The Lamp on the Pier',
      characters: CHARACTERS,
      mainCharacters: ['c1'],
      language: 'en',
      pages: 4,
      artStyle: 'watercolor',
      layout: { textInImage: true },
    };
    const BEATS = [{ pageNumber: 1, planLine: 'wide — Mira on the pier — she lifts the lantern — the lamp is lit' }];
    const TEXT = 'The lamp guttered twice and then went out.';

    let authored: Record<string, string>;
    let judged: string;

    beforeAll(async () => {
      await require('../../server/services/prompts').loadPromptTemplates();
      const iterate = (freeIterate: boolean) => PB.buildSceneDescriptionPrompt(
        1, TEXT, CHARACTERS, '', 'en', null, [], {}, '', '',
        { planLine: BEATS[0].planLine },
        { composition: 'a render', fixIssues: ['the lantern is missing'], previousScore: -20 },
        { freeIterate, textInImage: true, story: inputData });

      authored = {
        'scene-expansion': PB.buildSceneExpansionPrompt(1, TEXT, CHARACTERS, 'en', null, '', null, { story: inputData }),
        'scene-iteration': iterate(false),
        'scene-iteration-free': iterate(true),
      };
      judged = PB.buildSceneReviewPrompt(inputData, [{ pageNumber: 1, text: TEXT, sceneDescription: 'Mira lifts the lantern.' }]);
    });

    it('every template that AUTHORS a brief gets the permission and no verdict', () => {
      for (const [name, prompt] of Object.entries(authored)) {
        expect(prompt, name).toContain(PERMISSION);
        expect(prompt, name).not.toContain(VERDICT);
      }
    });

    // 2026-09-23 (owner): the scene review and the all-pages Art Director are
    // shown no page text (it is written after them), so neither half reaches
    // them. The judges that are shown the text keep the whole rule
    // (text-not-a-checklist-reach.test.ts).
    it('the two stages shown no page text carry neither half', () => {
      for (const prompt of [judged, PB.buildSceneExpansionAllPrompt(inputData, BEATS, {})]) {
        expect(prompt).not.toContain(PERMISSION);
        expect(prompt).not.toContain(VERDICT);
      }
    });
  });
});
