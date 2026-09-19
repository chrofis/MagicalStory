import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pb = require('../../server/lib/promptBuilders.js');
const { loadPromptTemplates, PROMPT_TEMPLATES } = require('../../server/services/prompts.js');

// Lab 1273: the trial idea generator returned ten ideas on one premise, because
// the age-band file was 57% of an 861-word prompt, both arms shared it whole,
// and its worked-example menus were read as the answer key. These tests pin the
// CONTRACT of the fix — which rules reach which reader — never the wording of
// any rule.

const chars = (age: number) => [{ name: 'Mia', age, gender: 'female', isMain: true }];

const args = (age: number) => ({
  characters: chars(age),
  charDesc: `Mia, ${age} years old, female`,
  categoryContext: 'This is a pirate adventure story.',
  landmarksText: 'At least one scene must take place at one of these real local landmarks: Alpha Tower.',
  townName: 'Somewhereville',
  storyTheme: 'pirate',
  trialTitle: '',
  langInstruction: 'Write in German.',
  seasonInstruction: 'The season is autumn.',
  ideaCostume: null,
});

beforeAll(async () => { await loadPromptTemplates(); });

describe('age-band views — one file, three readers', () => {
  const bands: Array<[number, string]> = [[0, 'routine'], [2, 'quest'], [3, 'tries'], [4, 'fear-choice'], [5, 'journey']];

  for (const [age, name] of bands) {
    it(`${name}: writer ⊃ premise ⊇ premise-open, and no view leaks a marker`, () => {
      const views = (['writer', 'premise', 'premise-open'] as const).map(v =>
        pb.buildAgeModeSection({ characters: chars(age) }, { bandView: v }));
      const [writer, premise, tone] = views.map(s => s.length);
      expect(writer).toBeGreaterThan(premise);
      // fear-choice has no [[mechanics]] rule at all, so its two premise-shaped
      // views are legitimately the same text.
      expect(premise).toBeGreaterThanOrEqual(tone);
      for (const v of views) expect(v).not.toMatch(/\[\[/);
    });
  }

  // "Who resolves it" and "that it resolves" are one pair and belong to every
  // reader. fdc85a290 moved only the first out of [[plot]]; measured at b0ffa352
  // over 28 ideas, the journey band's fantasy arm still resolved 3/6 against the
  // own-town arm's 6/6, and 9 of 28 cards stopped on the problem. From
  // 2026-09-16 the tags name the ROLE, so both halves are [[premise]] in every
  // band; what stays writer-only is the page machinery a 40-word premise cannot
  // honour (how each try differs, that every beat is on the page).
  const resolution: Array<[number, string, string, string]> = [
    // age, agency rule (routine has none — its storyline line carries both),
    // resolution rule, and one writer-only span (page machinery or book craft)
    [0, 'comes right', 'it is put right within a page or two', 'A new thing on every page'],
    [2, '**The child does the finding.**', '**It resolves.** The wanted thing is found before the last page.', 'The search is the story'],
    [3, "**The child's own doing.**", '**It resolves.** The third try works', 'Each try is a different kind of attempt'],
    [4, "**The child's choice resolves it.**", '**It resolves.** The fear is real enough to feel', '**Feelings on the page.**'],
    [5, "**The hero's own idea turns it.**", '**It resolves.** The turn comes before the last page', 'Every one of those beats is on the page'],
  ];

  for (const [age, agency, resolves, beats] of resolution) {
    it(`age ${age}: the premise-open view carries agency AND resolution, never the machinery`, () => {
      const tone = pb.buildAgeModeSection({ characters: chars(age) }, { bandView: 'premise-open' });
      expect(tone).toContain(agency);
      expect(tone).toContain(resolves);
      expect(tone).not.toContain(beats);
      // and the writer keeps both halves plus the beats
      const writer = pb.buildAgeModeSection({ characters: chars(age) }, { bandView: 'writer' });
      for (const s of [agency, resolves, beats]) expect(writer).toContain(s);
    });
  }

  it('the fantasy idea arm is told the story resolves, at every band', () => {
    for (const age of [0, 2, 3, 4, 5, 8, 12, 38]) {
      const { fantasy } = pb.buildTrialIdeaPrompts({ ...args(3), characters: chars(age) });
      expect(fantasy).toMatch(/\*\*It resolves\.\*\*|it is put right within a page or two/);
    }
  });

  it('rejects an unknown view rather than silently shipping the whole file', () => {
    expect(() => pb.applyBandView('x', 'nonsense')).toThrow(/Unknown age-band view/);
  });

  it('the writer keeps every rule of the band file — the views cost it nothing', () => {
    const file = PROMPT_TEMPLATES.ageBandTries as string;
    const writer = pb.applyBandView(file, 'writer');
    expect(writer).toBe(file.replace(/\[\[\/?(?:premise|craft|mechanics|example)(?::[a-z-]+)?\]\]/g, ''));
    // the book-craft rules a 40-word premise cannot honour
    for (const rule of ['One feeling per turn', '**Food.**', '**Ending.**', 'A life event is weather']) {
      expect(writer).toContain(rule);
    }
  });

  it('the writer prompt itself still carries the band whole', () => {
    const w = pb.buildTrialStoryPrompt({
      trialMode: true, language: 'de', storyTheme: 'realistic', storyDetails: 'x', characters: chars(3),
    }, 5);
    expect(w).not.toMatch(/\[\[/);
    for (const rule of ['One feeling per turn', '**Food.**', '**Ending.**', 'Three tries, no more']) {
      expect(w).toContain(rule);
    }
  });
});

describe('the two idea arms differ by construction', () => {
  it('the fantasy arm carries every premise rule but not the page machinery', () => {
    const { local, fantasy } = pb.buildTrialIdeaPrompts(args(3));
    // page machinery: own-town arm only
    expect(local).toContain('Each try is a different kind of attempt');
    expect(fantasy).not.toContain('Each try is a different kind of attempt');
    // the band SHAPE and what kind of noticing it allows are premise-defining
    for (const p of [local, fantasy]) {
      expect(p).toContain('Three tries, no more');
      expect(p).toContain('Small noticing, not cleverness');
    }
    // tone rules: both arms
    for (const p of [local, fantasy]) {
      expect(p).toContain('A gentle obstacle, never a villain');
      expect(p).toContain('Kindness is the motive');
      // the agency rule is untagged since 2026-09-15: six of the ten worst rated
      // ideas were fantasy-arm cards an object or an adult solved.
      expect(p).toContain("**The child's own doing.**");
      expect(p).toContain('grown-up stepping in to do it for them');
    }
  });

  it('neither arm carries the book-craft rules or the example menus', () => {
    const { local, fantasy } = pb.buildTrialIdeaPrompts(args(3));
    for (const p of [local, fantasy]) {
      expect(p).not.toContain('One feeling per turn');
      expect(p).not.toContain('**Food.**');
      expect(p).not.toContain('**Ending.**');
      // the menu 8 of 10 collapsed ideas copied verbatim
      expect(p).not.toContain('there is a way in from another side');
    }
  });

  it('the fantasy arm is materially shorter than the own-town arm', () => {
    const { local, fantasy } = pb.buildTrialIdeaPrompts(args(3));
    expect(fantasy.length).toBeLessThan(local.length * 0.95);
  });

  it('never asks for a difference from an idea it cannot have seen', () => {
    const { fantasy } = pb.buildTrialIdeaPrompts(args(3));
    expect(fantasy).not.toMatch(/different idea than the first/i);
  });

  it('the landmark mandate stays on the own-town arm', () => {
    const { local, fantasy } = pb.buildTrialIdeaPrompts(args(3));
    expect(local).toContain('Alpha Tower');
    expect(fantasy).not.toContain('Alpha Tower');
  });
});

describe('title sentences are gated on there being a title', () => {
  it('an untopic\'d adventure gets neither the empty title line nor its rule', () => {
    const { local, fantasy } = pb.buildTrialIdeaPrompts({ ...args(6), trialTitle: '' });
    for (const p of [local, fantasy]) {
      expect(p).not.toContain('Story title:');
      expect(p).not.toMatch(/the title above/);
      expect(p).not.toMatch(/repeat.{0,10}the title/i);
    }
  });

  it('a real title brings both back', () => {
    const { local } = pb.buildTrialIdeaPrompts({ ...args(6), trialTitle: 'The Quiet Lantern' });
    expect(local).toContain('Story title: The Quiet Lantern');
    expect(local).toMatch(/the title above/);
  });
});

describe('the variety axis varies across draws', () => {
  it('rotates rather than repeating, and the two arms of a draw differ', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 8; i++) {
      const a = pb.nextIdeaVarietyAxis();
      const b = pb.nextIdeaVarietyAxis();
      expect(a.text).not.toBe(b.text);
      seen.add(a.text); seen.add(b.text);
    }
    expect(seen.size).toBeGreaterThanOrEqual(8);
  });

  it('reaches the built prompt, and two consecutive draws of an arm differ', () => {
    const d1 = pb.buildTrialIdeaPrompts(args(3));
    const d2 = pb.buildTrialIdeaPrompts(args(3));
    expect(d1.local).toContain(d1.axes.local.text);
    expect(d1.local).not.toBe(d2.local);
    expect(d1.fantasy).not.toBe(d2.fantasy);
  });

  it('costs nothing of consequence — one short line per arm', () => {
    const { text } = pb.nextIdeaVarietyAxis();
    expect(text.split(/\s+/).length).toBeLessThan(30);
  });
});

// An animal-fate rule reaches the two places a story's EVENTS are decided: both
// trial idea arms, and {TELLING_RULES} for the arc authors. Pins the REACH, not
// the wording — a round-6 card had a creature go still and a meal follow in the
// same sentence, with no rule in the system objecting.
describe('the animal-fate rule reaches both idea arms and the arc authors', () => {
  it('is one constant, filled into both arms at every band', () => {
    for (const age of [2, 8]) {
      const { local, fantasy } = pb.buildTrialIdeaPrompts(args(age));
      for (const prompt of [local, fantasy]) {
        expect(prompt).toContain(pb.ANIMAL_FATE_RULE);
        expect(prompt).not.toMatch(/\{ANIMAL_FATE\}/);
      }
    }
  });

  it('rides {TELLING_RULES} too, so the arc authors are not a hand-kept copy', () => {
    const telling = pb.buildTellingRulesSection({ characters: chars(8) });
    expect(telling).toContain(pb.ANIMAL_FATE_RULE);
  });
});
