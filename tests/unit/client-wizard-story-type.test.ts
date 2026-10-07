import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { isStoryTypeComplete } from '../../client/src/utils/wizardStoryType';

const wizardSrc = () => fs.readFileSync(path.join(__dirname, '../../client/src/pages/StoryWizard.tsx'), 'utf8');

describe('story type completeness gates every door to steps 4/5 and Generate', () => {
  const base = { storyTheme: '', storyTopic: '', customThemeText: '' };

  it('a category alone is not a story type', () => {
    expect(isStoryTypeComplete({ ...base, storyCategory: '' })).toBe(false);
    expect(isStoryTypeComplete({ ...base, storyCategory: 'adventure' })).toBe(false);
    expect(isStoryTypeComplete({ ...base, storyCategory: 'custom', customThemeText: '   ' })).toBe(false);
    for (const c of ['life-challenge', 'educational', 'historical', 'swiss-stories'] as const) {
      expect(isStoryTypeComplete({ ...base, storyCategory: c })).toBe(false);
      expect(isStoryTypeComplete({ ...base, storyCategory: c, storyTopic: 'x' })).toBe(true);
    }
    expect(isStoryTypeComplete({ ...base, storyCategory: 'adventure', storyTheme: 'dragons' })).toBe(true);
    expect(isStoryTypeComplete({ ...base, storyCategory: 'custom', customThemeText: 'a pirate who bakes' })).toBe(true);
  });

  it('the step-indicator jumps and the step-5 Generate gate read the same rule as step 3 Next', () => {
    const src = wizardSrc();
    // Step indicator: steps 4 and 5 were reachable with storyCategory !== '' alone.
    expect(src).not.toMatch(/if \(s === 4\) return characters\.length > 0 && storyCategory !== '';/);
    expect(src).toMatch(/if \(s === 4\) return characters\.length > 0 && storyTypeDone;/);
    expect(src).toMatch(/if \(s === 5\) return characters\.length > 0 && storyTypeDone && artStyle !== '';/);
    // Step 5 Generate button.
    const step5 = src.slice(src.indexOf('if (step === 5) {', src.indexOf('const canGoNext')), src.indexOf('return false;', src.indexOf('const canGoNext')));
    expect(step5).toContain('isStoryTypeComplete({ storyCategory, storyTheme, storyTopic, customThemeText })');
  });
});
