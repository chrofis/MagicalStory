/**
 * What the two wardrobe calls are SENT (audit docs/audits/prompt-audit-2026-09-23/03-wardrobe.md).
 *
 *  - The wardrobe writer never gets the character's saved clothing: the wardrobe
 *    is written per story (owner, 2026-09-23). It did get a "start from the stored
 *    clothing above" sentence pointing at nothing — the sentence is deleted.
 *  - The writer gets the ARC: whose garment the plot uses is often only there.
 *  - Both calls get a wardrobe-scoped brief and character details: no plot-binding
 *    paragraph, no strengths / flaws, no face geometry.
 *  - The Art Director's clothing list carries each version's outfit.
 *  - The bible prompt + raw reply, the review's raw reply and the
 *    wardrobe-vs-bible findings are stored with the story.
 *
 * Behaviour pins on the BUILT prompt, never on template wording.
 */
import { describe, it, beforeAll, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const {
  buildStoryBibleFromBeatsPrompt,
  buildClothingReviewPrompt,
  buildStoryContextFields,
} = require('../../server/lib/promptBuilders');
const { buildAvailableAvatarsForPrompt } = require('../../server/lib/clothingResolve');
const { loadPromptTemplates } = require('../../server/services/prompts');

const SAVED_TOP = 'yellow long-sleeve sweatshirt with a dinosaur graphic';
const inputData: any = {
  characters: [
    {
      id: 'c1', name: 'Hero', age: 5, gender: 'male',
      traits: { strengths: ['Zuverlaessig'], flaws: ['Vergesslich'], specialDetails: 'always wears round glasses' },
      physical: { eyeColor: 'hazel', face: 'rounded jawline, neutral chin' },
      structuredClothing: { upperBody: SAVED_TOP, lowerBody: 'dark blue jeans', shoes: 'black sneakers' },
      avatars: { clothing: { standard: 'white hooded sweatshirt, khaki pants' } },
    },
    { id: 'c2', name: 'Friend', age: 4, gender: 'female', clothing: 'saved striped dress' },
  ],
  mainCharacters: ['c1'],
  language: 'de',
  pages: 2,
  storyCategory: 'adventure',
  storyTheme: 'dragon',
  storyDetails: 'Two children find a warm egg.',
  artStyle: 'watercolor',
};
const beats = [
  { pageNumber: 1, planLine: 'wide — Hero, Friend — Hero holds his jacket over the egg' },
  { pageNumber: 2, planLine: 'medium — Hero, Friend — the egg hatches' },
];
const ARC = '1. Hero wraps the egg in his own jacket.';

let bible = '';
let review = '';
beforeAll(async () => {
  await loadPromptTemplates();
  bible = buildStoryBibleFromBeatsPrompt(inputData, beats, { arc: ARC });
  review = buildClothingReviewPrompt(inputData, {
    Hero: { standard: { used: true, description: 'A red shirt, blue trousers, brown boots.' } },
    Friend: { standard: { used: true, description: 'A green dress, white shoes.' } },
  }, beats);
});

describe('the wardrobe writer', () => {
  it('never sees the saved clothing, in any stored field', () => {
    expect(bible).not.toContain(SAVED_TOP);
    expect(bible).not.toContain('white hooded sweatshirt');
    expect(bible).not.toContain('saved striped dress');
  });

  it('gets the arc', () => {
    expect(bible).toContain(ARC);
  });

  it('keeps what a garment must fit around, and drops face geometry', () => {
    expect(bible).toContain('hazel');
    expect(bible).toContain('always wears round glasses');
    expect(bible).not.toContain('rounded jawline');
  });
});

describe('both wardrobe calls', () => {
  it('carry no strengths or flaws', () => {
    for (const p of [bible, review]) {
      expect(p).not.toContain('Zuverlaessig');
      expect(p).not.toContain('Vergesslich');
    }
  });

  it('carry the brief but not the plot stages’ binding paragraph', () => {
    const plotBrief = buildStoryContextFields(inputData).STORY_BRIEF.split('\n');
    const bindingLine = plotBrief.find((l: string) => l.startsWith('How the story gets there'));
    expect(bindingLine).toBeTruthy();
    for (const p of [bible, review]) {
      expect(p).toContain('Two children find a warm egg.');
      expect(p).toContain('<user_input>');
      expect(p).not.toContain(bindingLine);
    }
  });
});

describe('the Art Director’s clothing list', () => {
  it('names every used version with the outfit its avatar wears', () => {
    const list = buildAvailableAvatarsForPrompt(inputData.characters, {
      Hero: {
        standard: { used: true, description: 'A red shirt, blue trousers, brown boots.' },
        costumed: { used: true, costume: 'pirate', description: 'A black tricorn hat, a white shirt.' },
      },
      Friend: { standard: { used: true, description: 'A green dress, white shoes.' } },
    });
    expect(list).toContain('- Hero: standard, costumed:pirate');
    expect(list).toContain('A red shirt, blue trousers, brown boots.');
    expect(list).toContain('A black tricorn hat, a white shirt.');
    expect(list).toContain('A green dress, white shoes.');
  });
});

describe('the wardrobe stage is stored with the story', () => {
  const root = path.join(__dirname, '..', '..');
  const beatsSrc = fs.readFileSync(path.join(root, 'server', 'lib', 'beatsPipeline.js'), 'utf8');
  const pipeline = fs.readFileSync(path.join(root, 'storyJobPipeline.js'), 'utf8');

  it('the pipeline returns the bible report, the review reply and the bible check', () => {
    expect(beatsSrc).toMatch(/return \{[^}]*storyBibleReport[^}]*wardrobeBibleReport[^}]*\}/);
    expect(beatsSrc).toContain("rawResponse: bibleRes.text || ''");
    expect(beatsSrc).toContain("rawResponse: cRes.text || ''");
    expect(beatsSrc).toContain('buildStoryBibleFromBeatsPrompt(inputData, beats, { arc: approvedArc })');
  });

  it('the story data keeps them', () => {
    expect(pipeline).toContain('const storyBibleReport = beatsResult?.storyBibleReport || null;');
    expect(pipeline).toContain('const wardrobeBibleReport = beatsResult?.wardrobeBibleReport || null;');
    expect(pipeline).toMatch(/storyBibleReport, \/\/ wardrobe contract call/);
    expect(pipeline).toMatch(/wardrobeBibleReport, \/\/ wardrobe contract vs Visual Bible/);
  });
});
