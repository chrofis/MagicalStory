/**
 * The trial writer's page length follows the age band, and the simple bands
 * state that a child this young is never sent anywhere alone.
 * Staging 2026-10-08: a 1-year-old's trial book ran 66-101 words a page and
 * walked alone to a church (job_1791496986667_r4sgw3870, job_1791500011394_yvjd5robo).
 */
import { describe, it, beforeAll, expect } from 'vitest';

import { trialWriterPrompt } from './helpers/trialWriterPrompt';
const PB = require('../../server/lib/promptBuilders');
const { loadPromptTemplates } = require('../../server/services/prompts');

const kid = (age: number): any => ({
  characters: [{ id: 'c1', name: 'Tobi', age, gender: 'boy' }],
  mainCharacters: ['c1'],
  language: 'de-ch',
  storyCategory: 'adventure',
  storyTheme: 'pirate',
  storyDetails: 'A quiet afternoon.',
  artStyle: 'watercolor',
});

describe('trialPageLength', () => {
  it.each([0, 1, 2, 3, 4])('age %i gets the 1st-grade page length from LANGUAGE_LEVELS', (age) => {
    const r = PB.trialPageLength(kid(age));
    expect(r.words).toBe('25-70');
    expect(r.rule).toContain('25-70 words per page');
    expect(r.rule).not.toContain('100-140');
  });
  it.each([5, 6, 9, 14])('age %i keeps the trial\'s own 100-140', (age) => {
    expect(PB.trialPageLength(kid(age)).words).toBe('100-140');
  });
  it('no readable age keeps 100-140', () => {
    expect(PB.trialPageLength({ characters: [] }).words).toBe('100-140');
  });
});

describe('buildTrialStoryPrompt page length and escort', () => {
  beforeAll(async () => { await loadPromptTemplates(); });
  it('a 1-year-old prompt states 25-70 words twice and never 100-140', () => {
    const p = trialWriterPrompt(kid(1), 6);
    expect(p).not.toContain('100-140');
    expect(p).toContain('[Story text, 25-70 words]');
    expect(p).not.toMatch(/\{PAGE_(LENGTH_RULE|WORDS)\}/);
  });
  it('a 7-year-old prompt is unchanged: 100-140', () => {
    const p = trialWriterPrompt(kid(7), 6);
    expect(p).toContain('100-140 words per page');
    expect(p).toContain('[Story text, 100-140 words]');
  });
  it.each([1, 2, 3])('age %i carries the escort rule, age 5 does not', (age) => {
    expect(trialWriterPrompt(kid(age), 6)).toContain('Nobody this young goes anywhere alone');
  });
  it('age 5 and 7 do not', () => {
    expect(trialWriterPrompt(kid(5), 6)).not.toContain('Nobody this young goes anywhere alone');
    expect(trialWriterPrompt(kid(7), 6)).not.toContain('Nobody this young goes anywhere alone');
  });
  it('no band token is left unfilled', () => {
    expect(PB.buildAgeModeSection(kid(1))).not.toMatch(/\{ESCORT_RULE\}/);
    expect(PB.buildAgeModeSection(kid(3))).not.toMatch(/\{ESCORT_RULE\}/);
  });
});
