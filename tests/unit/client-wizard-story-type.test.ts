import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { isStoryTypeComplete, initialStoryType } from '../../client/src/utils/wizardStoryType';

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

describe('arriving with ?category=&topic= starts a NEW story-type selection', () => {
  function storageWith(entries: Record<string, string>) {
    const map = new Map(Object.entries(entries));
    return {
      map,
      getItem: (k: string) => map.get(k) ?? null,
      removeItem: (k: string) => { map.delete(k); },
    };
  }
  const previous = {
    story_type: 'dragons', story_category: 'adventure', story_theme: 'dragons', story_topic: '',
    story_custom_theme_text: 'my own idea', story_details: 'A dragon plot from last week', story_topic_name: 'Drachen',
  };

  it('drops the previous theme, custom text, plot and topic name', () => {
    const storage = storageWith(previous);
    const sel = initialStoryType('?category=life-challenge&topic=dentist', storage);
    expect(sel).toEqual({ storyType: 'dentist', storyCategory: 'life-challenge', storyTopic: 'dentist', storyTheme: 'realistic', customThemeText: '', storyDetails: '' });
    for (const k of ['story_type', 'story_theme', 'story_custom_theme_text', 'story_details', 'story_topic_name']) {
      expect(storage.map.has(k)).toBe(false);
    }
  });

  it('a URL category without topic does not keep the stored topic of another category', () => {
    const storage = storageWith({ ...previous, story_category: 'educational', story_topic: 'recycling' });
    const sel = initialStoryType('?category=adventure', storage);
    expect(sel.storyCategory).toBe('adventure');
    expect(sel.storyTopic).toBe('');
    expect(sel.storyTheme).toBe('');
  });

  it('without URL params the stored selection is restored untouched', () => {
    const storage = storageWith(previous);
    const sel = initialStoryType('', storage);
    expect(sel).toEqual({ storyType: 'dragons', storyCategory: 'adventure', storyTopic: '', storyTheme: 'dragons', customThemeText: 'my own idea', storyDetails: 'A dragon plot from last week' });
    expect(storage.map.size).toBe(Object.keys(previous).length);
  });

  it('the wizard initialises its step-3/5 state through this helper', () => {
    const src = wizardSrc();
    expect(src).toContain('initialStoryType(window.location.search, localStorage)');
    expect(src).not.toContain("urlCategory || localStorage.getItem('story_category')");
  });
});
