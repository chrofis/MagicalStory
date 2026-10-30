/**
 * Owner decision 2026-10-30: a story the parent wrote on the wizard's Own story card binds the
 * book to its events and ending. Generated ideas and the custom theme keep the loose commission.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const PB = require('../../server/lib/promptBuilders');
const root = path.join(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

const base = {
  language: 'en', storyCategory: 'adventure', storyTheme: 'pirate', storyTopic: '',
  storyDetails: 'The hero finds a map, crosses a river, and ends at home.',
  characters: [{ id: 1, name: 'Emma', age: 6 }], mainCharacters: [1], languageLevel: 'standard',
};
const LOOSE = 'How the story gets there is not binding';
const OWN = 'a story the parent wrote, and the book follows it closely';

describe('STORY_BRIEF: own-story variant', () => {
  it('ownStory true -> binding rule, loose line gone, other commission lines kept', () => {
    const b = PB.buildStoryContextFields({ ...base, ownStory: true }).STORY_BRIEF;
    expect(b).toContain(OWN);
    expect(b).not.toContain(LOOSE);
    expect(b).toContain('What this names is binding');
    expect(b).toContain('sets the stakes');
    expect(b).toContain('<user_input>');
  });
  it.each([[{}], [{ ownStory: false }], [{ ownStory: 'true' }], [{ ideaPick: { index: 1 } }]])('otherwise (%j) -> loose rule', (extra) => {
    const b = PB.buildStoryContextFields({ ...base, ...extra }).STORY_BRIEF;
    expect(b).toContain(LOOSE);
    expect(b).not.toContain(OWN);
  });
});

describe('ownStory signal path', () => {
  const wiz = read('client/src/pages/StoryWizard.tsx');
  const step6 = read('client/src/pages/wizard/WizardStep6Summary.tsx');
  it('only the Own story card passes ownStory true to onSelectIdea', () => {
    expect(step6).toContain('onSelectIdea(ownStoryText, undefined, true);');
    expect(step6).toContain('if (selectedOption === 2) onSelectIdea(text, undefined, true);');
    expect(step6).toContain('onSelectIdea(editableIdeas[index], index);');
    expect(step6).toContain('onSelectIdea(customThemeText);');
    expect(step6).toContain('onSelectIdea(full, index);');
  });
  it('handleSelectIdea sets the flag from its third argument (default false), so every other caller clears it', () => {
    expect(wiz).toMatch(/handleSelectIdea = \(idea: string, index\?: number, ownStory = false\) => \{[^}]*setOwnStorySelected\(ownStory\);/);
  });
  it('the job payload sends ownStory only with the flag and a non-empty text', () => {
    expect(wiz).toContain('ownStory: ownStorySelected && storyDetails.trim().length > 0 ? true : undefined,');
    expect(read('client/src/services/storyService.ts')).toContain('ownStory: data.ownStory,');
  });
  it('the route spreads req.body into inputData and the pipeline persists the flag', () => {
    expect(read('server/routes/jobs.js')).toMatch(/const inputData = \{\s*\.\.\.req\.body,/);
    expect(read('storyJobPipeline.js')).toContain('ownStory: inputData.ownStory === true,');
  });
});
