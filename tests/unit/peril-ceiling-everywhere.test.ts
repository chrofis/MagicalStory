/**
 * The peril ceiling ("nothing that could lead to death") carries the historical
 * exception ("a historical event keeps the danger it really had") at EVERY site
 * that states it. The exception used to live only in the two idea templates, so
 * the arc, told to stay under the ceiling, invented a blunt rubber-tipped bolt
 * for a historical crossbow shot and the invention spread to the text and the
 * Visual Bible (staging job_1791145238223_50osg2osm; decisions.md 2026-10-05,
 * after 4804fe357). One constant, PERIL_CEILING_RULE, is injected everywhere.
 *
 * Pins behaviour: the built prompt of every stage carries the constant, and no
 * template keeps a hand copy of the ceiling.
 */
import { describe, it, beforeAll, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const {
  PERIL_CEILING_RULE,
  buildArcCreatePrompt,
  buildArcRetellPrompt,
  buildArcReviewPrompt,
  buildTextRefinePrompt,
  buildStoryTextFromBeatsPrompt,
} = require('../../server/lib/promptBuilders');
const { loadPromptTemplates } = require('../../server/services/prompts');

const inputData = {
  characters: [
    { id: 'c1', name: 'Mira', age: 8, gender: 'girl', personality: 'curious' },
    { id: 'c2', name: 'Tobias', age: 5, gender: 'boy', personality: 'shy' },
  ],
  mainCharacters: ['c1', 'c2'],
  language: 'en',
  languageLevel: 'medium',
  pages: 4,
  storyCategory: 'historical',
  storyTopic: 'moon-landing',
  storyDetails: 'A historical event.',
  artStyle: 'watercolor',
};
const pages = [{ pageNumber: 1, text: 'Mira steps out.', sceneDescription: 'Mira at the hatch.' }];
const beats = [{ pageNumber: 1, planLine: 'wide - Mira at the hatch' }];

const root = path.join(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf-8');

describe('the peril ceiling is one constant with the historical exception', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('the constant states the ceiling and the exception', () => {
    expect(PERIL_CEILING_RULE).toContain('could lead to death');
    expect(PERIL_CEILING_RULE).toMatch(/historical event keeps the danger it really had/);
  });

  it.each([
    ['arc-create', () => buildArcCreatePrompt(inputData, 4)],
    ['arc-retell', () => buildArcRetellPrompt(inputData, 4, 'COMMITTED', 'SOLUTIONS')],
    ['arc-review', () => buildArcReviewPrompt(inputData, '1. A story.')],
    ['text-refine', () => buildTextRefinePrompt(inputData, pages, '', '1. A story.')],
    ['story-text-from-beats', () => buildStoryTextFromBeatsPrompt(inputData, beats, [], '1. A story.', { arcHints: '' })],
  ])('the built %s prompt carries the constant verbatim and no unfilled placeholder', (_n, build) => {
    const p = (build as () => string)();
    expect(p).toContain(PERIL_CEILING_RULE);
    expect(p).not.toContain('{PERIL_CEILING}');
  });

  it.each([
    'prompts/story-arc-review.txt',
    'prompts/story-text-from-beats.txt',
    'prompts/text-refine.txt',
    'prompts/generate-story-ideas.txt',
    'prompts/generate-story-idea-single.txt',
  ])('%s takes {PERIL_CEILING} and keeps no hand copy of the ceiling', (file) => {
    const t = read(file);
    expect(t).toContain('{PERIL_CEILING}');
    expect(t).not.toContain('could lead to death');
  });

  it('the idea route fills {PERIL_CEILING} from the constant', () => {
    expect(read('server/routes/storyIdeas.js')).toMatch(/PERIL_CEILING:\s*PERIL_CEILING_RULE/);
  });

  it('promptBuilders has exactly one definition of the ceiling sentence', () => {
    const src = read('server/lib/promptBuilders.js');
    expect(src.match(/dangerous enough that it could lead to death/g)).toHaveLength(1);
  });
});
