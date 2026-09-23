/**
 * The "spread but never declared" class: a builder computes a value and spreads
 * it into `fillTemplate`, the template declares no placeholder for it, and the
 * value is dropped with no error, no warning and no log.
 *
 * An instrumented sweep of `fillTemplate` found four such drops in the beats
 * chain. Only ONE was a defect. The other three are deliberate scoping
 * decisions with their own evidence, and this file pins them ABSENT so a future
 * sweep does not "fix" them back in (docs/decisions.md, 2026-09-14).
 *
 *   arc-retell        / LANGUAGE            → DEFECT, fixed here
 *   arc-retell        / CHARACTER_NAMES     → by design (CHARACTER_DETAILS carries the roster)
 *   story-text-from-beats  / STORY_BRIEF         → by design (promptBuilders "NO COMMISSION HERE")
 *   story-text-from-beats  / STORY_GUIDE_SECTION → by design (decisions.md 2026-09-13)
 *   story-bible-from-beats / STORY_GUIDE_SECTION → by design (ERA_CLOTHING_RULE is the route)
 *
 * These pin BEHAVIOUR, not wording: that the value reaches (or does not reach)
 * the built prompt, never the sentence that carries it.
 */
import { describe, it, beforeAll, expect } from 'vitest';

const {
  buildStoryContextFields,
  buildArcCreatePrompt,
  buildArcRetellPrompt,
  buildStoryTextFromBeatsPrompt,
  buildStoryBibleFromBeatsPrompt,
} = require('../../server/lib/promptBuilders');
const { loadPromptTemplates } = require('../../server/services/prompts');

// A historical story in a non-English language: the one shape where all four
// values are simultaneously non-empty, so "absent" can never be "was empty".
const inputData = {
  characters: [
    { id: 'c1', name: 'Mira', age: 8, gender: 'girl', personality: 'curious' },
    { id: 'c2', name: 'Tobias', age: 5, gender: 'boy', personality: 'shy' },
  ],
  mainCharacters: ['c1'],
  language: 'de',
  languageLevel: 'medium',
  pages: 4,
  storyCategory: 'historical',
  storyTopic: 'moon-landing',
  storyDetails: 'ROLES:\nMira: Neil Armstrong\nTobias: Buzz Aldrin',
  artStyle: 'watercolor',
};
const beats = [
  { pageNumber: 1, planLine: 'wide — Mira at the hatch' },
  { pageNumber: 2, planLine: 'close — the first step' },
];

let ctx: any;
const built: Record<string, string> = {};

beforeAll(async () => {
  await loadPromptTemplates();
  ctx = buildStoryContextFields(inputData);
  built['arc-create'] = buildArcCreatePrompt(inputData, 4);
  built['arc-retell'] = buildArcRetellPrompt(inputData, 4, 'COMMITTED', 'SOLUTIONS');
  built['story-text-from-beats'] = buildStoryTextFromBeatsPrompt(inputData, beats, [], 'ARC', { arcHints: '' });
  built['story-bible-from-beats'] = buildStoryBibleFromBeatsPrompt(inputData, beats);
});

/** A distinctive slice of the real computed value — never a hand-written string. */
const probe = (key: string) => String(ctx[key] || '').slice(0, 60);

describe('every swept value is genuinely non-empty for this commission', () => {
  it.each(['STORY_BRIEF', 'STORY_GUIDE_SECTION', 'LANGUAGE', 'CHARACTER_NAMES'])(
    '%s is computed and non-empty',
    (key) => { expect(String(ctx[key] || '').length).toBeGreaterThan(0); },
  );
});

describe('no built beats prompt leaves an unfilled placeholder', () => {
  it.each(['arc-create', 'arc-retell', 'story-text-from-beats', 'story-bible-from-beats'])(
    '%s renders every declared placeholder',
    (name) => {
      expect(built[name]).toBeTruthy();
      expect(built[name].match(/\{[A-Z][A-Z0-9_]*\}/g) || []).toEqual([]);
    },
  );
});

describe('DEFECT fixed: the re-telling knows the book language', () => {
  it('arc-retell carries LANGUAGE, like its arc-create sibling', () => {
    expect(built['arc-retell']).toContain(probe('LANGUAGE'));
    expect(built['arc-create']).toContain(probe('LANGUAGE'));
  });

  it('the re-telling is the stage that invents names, so it needs it', () => {
    // TELLING_RULES sends the creator off to invent fresh vessel/place names,
    // and every round re-tells the arc whole — the FINAL arc is a retell output.
    expect(built['arc-retell']).toMatch(/invented fresh/i);
  });
});

describe('BY DESIGN — absent, and must stay absent', () => {
  it('arc-retell carries no CHARACTER_NAMES roster line', () => {
    expect(built['arc-retell']).not.toContain(probe('CHARACTER_NAMES'));
  });

  it('…because CHARACTER_DETAILS already names the whole cast there', () => {
    for (const c of inputData.characters) expect(built['arc-retell']).toContain(`**${c.name}**`);
  });

  it('story-text-from-beats carries no commission — the arc has already ruled on it', () => {
    expect(built['story-text-from-beats']).not.toContain(probe('STORY_BRIEF'));
  });

  it('story-text-from-beats carries no topic guide — the arc was authored under the mandate', () => {
    expect(built['story-text-from-beats']).not.toContain(probe('STORY_GUIDE_SECTION'));
  });

  it('the text writer still gets subject and cast through the arc route', () => {
    // The design claim is "not blind", not "brief-free by accident": the cast,
    // the language and the arc all reach it.
    expect(built['story-text-from-beats']).toContain(probe('CHARACTER_NAMES'));
    expect(built['story-text-from-beats']).toContain(probe('LANGUAGE'));
    for (const c of inputData.characters) expect(built['story-text-from-beats']).toContain(`**${c.name}**`);
  });

  it('story-bible-from-beats carries no topic guide — ERA_CLOTHING_RULE is the wardrobe route', () => {
    expect(built['story-bible-from-beats']).not.toContain(probe('STORY_GUIDE_SECTION'));
    expect(built['story-bible-from-beats']).toMatch(/`costumed` variant/);
  });

  it('the wardrobe contract still learns the era from the commission', () => {
    // Its own brief (promptBuilders wardrobeStoryBrief, 2026-09-23): the brief
    // body without the plot stages' binding paragraph.
    expect(built['story-bible-from-beats']).toContain('moon-landing');
    expect(built['story-bible-from-beats']).toContain('Neil Armstrong');
  });
});
