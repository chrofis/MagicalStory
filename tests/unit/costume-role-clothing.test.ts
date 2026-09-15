/**
 * A character the story already dresses for their role stays `standard`.
 *
 * The wardrobe rule pushed every cast member into one costume bucket, so a
 * pirate-themed story put a real ship's captain into a pirate costume — tricorn
 * included — in a present-day city (staging job_1789420511893_zly5rcdej). These
 * pin the BUILT prompt, at every site that authors a wardrobe, and the `states`
 * key parity across the four bible-authoring sites.
 */
import { describe, it, beforeAll, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const { buildStoryBibleFromBeatsPrompt } = require('../../server/lib/promptBuilders');
const { loadPromptTemplates } = require('../../server/services/prompts');

const PROMPTS = path.join(__dirname, '..', '..', 'prompts');
const read = (f: string) => fs.readFileSync(path.join(PROMPTS, f), 'utf-8');

// The three templates that author clothingRequirements.
const WARDROBE_SITES = ['story-bible-from-beats.txt', 'story-unified.txt', 'story-unified-imagefirst.txt'];
// The four templates that author a Visual Bible entry.
const VB_SITES = ['scene-expansion-all.txt', 'story-unified.txt', 'story-unified-imagefirst.txt', 'story-trial.txt'];

const beats = [{ page: 1, beat: 'the child boards the ship' }, { page: 2, beat: 'the captain loses her cap' }];
const inputData = {
  characters: [{ id: 'c1', name: 'Mira', age: 8, gender: 'girl', personality: 'curious' }],
  mainCharacters: ['c1'],
  language: 'en', languageLevel: 'medium', pages: 8,
  storyCategory: 'adventure', storyTheme: 'pirate',
};

beforeAll(async () => { await loadPromptTemplates(); });

describe('role clothing is not a costume', () => {
  it('the BUILT wardrobe prompt tells the writer to leave such a character standard', () => {
    const built = String(buildStoryBibleFromBeatsPrompt(inputData, beats) || '');
    expect(built.length).toBeGreaterThan(0);
    expect(built).toContain('stays `standard`');
    expect(built).toMatch(/uniformed officer/);
  });

  it('the BUILT wardrobe prompt no longer prefers a costume when in doubt', () => {
    const built = String(buildStoryBibleFromBeatsPrompt(inputData, beats) || '');
    expect(built).not.toContain('Costumed is PREFERRED');
    expect(built).not.toMatch(/when in doubt, mark `?costumed/i);
  });

  it('every wardrobe-authoring site carries the rule and none keeps the old preference', () => {
    for (const f of WARDROBE_SITES) {
      const t = read(f);
      expect(t, f).toContain('stays `standard`');
      expect(t, f).not.toContain('Costumed is PREFERRED');
    }
  });

  it('the BUILT wardrobe prompt describes a plot object in full, in its slot', () => {
    const built = String(buildStoryBibleFromBeatsPrompt(inputData, beats) || '');
    expect(built).toContain('described IN FULL in the outfit');
    expect(built).toContain('Visual Bible copies those words');
    // The earlier shape (reserve the slot) was reversed by the owner: the slot
    // is FILLED so the bible can reuse the exact words.
    expect(built).not.toContain('stays out of the outfit');
  });

  it('every wardrobe-authoring site carries the full-description rule', () => {
    for (const f of WARDROBE_SITES) {
      expect(read(f), f).toContain('described IN FULL in the outfit');
      expect(read(f), f).not.toContain('stays out of the outfit');
    }
  });

  it('a costume is still required where the theme really is a costume', () => {
    const built = String(buildStoryBibleFromBeatsPrompt(inputData, beats) || '');
    expect(built).toMatch(/costumed\.used/);
  });
});

describe('states parity across the bible-authoring sites', () => {
  it('every site declares the states key', () => {
    for (const f of VB_SITES) expect(read(f), f).toContain('"states"');
  });

  it('the image-first twin declares it the same way its sibling does', () => {
    // Trailing comma and line ending differ between the two files; the clause does not.
    const clause = (t: string) =>
      ((t.match(/"states": "\[OMIT unless the story alters this object[^\n]*/) || [''])[0]).replace(/[\s,]+$/, '');
    expect(clause(read('story-unified-imagefirst.txt')).length).toBeGreaterThan(0);
    expect(clause(read('story-unified-imagefirst.txt'))).toBe(clause(read('story-unified.txt')));
  });
});
