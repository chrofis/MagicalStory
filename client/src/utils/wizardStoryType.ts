// Story-type selection rules of the full wizard (step 3, "Story Type").
//
// One predicate for "the story type is complete" — the Next button on step 3,
// the step-indicator jumps to steps 4/5 and the Generate button on step 5 all
// read it, so a category picked without its theme/topic/text can never reach
// POST /api/jobs/create-story (the server accepts storyTheme/storyTopic as
// optional and would reserve the credits for a theme-less adventure).

export type StoryCategory = 'adventure' | 'life-challenge' | 'educational' | 'historical' | 'swiss-stories' | 'custom' | '';

export interface StoryTypeSelection {
  storyCategory: StoryCategory;
  storyTheme: string;
  storyTopic: string;
  customThemeText: string;
}

export function isStoryTypeComplete(sel: StoryTypeSelection): boolean {
  if (!sel.storyCategory) return false;
  if (sel.storyCategory === 'adventure') return !!sel.storyTheme;
  if (sel.storyCategory === 'custom') return !!sel.customThemeText?.trim();
  // life-challenge, educational, historical, swiss-stories: a topic
  return !!sel.storyTopic;
}

// Keys of the step-3/5 state the wizard restores from localStorage.
const STORY_TYPE_KEYS = ['story_type', 'story_theme', 'story_custom_theme_text', 'story_details', 'story_topic_name'] as const;

export interface StoredStoryType {
  storyType: string;
  storyCategory: StoryCategory;
  storyTopic: string;
  storyTheme: string;
  customThemeText: string;
  storyDetails: string;
}

/**
 * The step-3 selection the wizard starts with. `?category=…&topic=…` (theme
 * pages, the trial's "create the full story" button) is a NEW selection: the
 * theme, custom text, plot and topic name a previous visit left in storage
 * belong to another story and are dropped — the clear-on-change effect skips
 * the initial mount, so without this a dentist topic kept the dragon plot. The
 * theme and legacy storyType are what StoryCategorySelector's own category and
 * topic handlers would have set for that click ('realistic' wrapper, topic id).
 */
export function initialStoryType(search: string, storage: Pick<Storage, 'getItem' | 'removeItem'>): StoredStoryType {
  const params = new URLSearchParams(search);
  const urlCategory = params.get('category');
  const urlTopic = params.get('topic');
  if (!urlCategory && !urlTopic) {
    return {
      storyType: storage.getItem('story_type') || '',
      storyCategory: (storage.getItem('story_category') || '') as StoryCategory,
      storyTopic: storage.getItem('story_topic') || '',
      storyTheme: storage.getItem('story_theme') || '',
      customThemeText: storage.getItem('story_custom_theme_text') || '',
      storyDetails: storage.getItem('story_details') || '',
    };
  }
  STORY_TYPE_KEYS.forEach(k => storage.removeItem(k));
  const storyCategory = (urlCategory || '') as StoryCategory;
  const storyTopic = urlTopic || '';
  const storyTheme = storyCategory === 'adventure' || storyCategory === '' ? '' : storyCategory === 'custom' ? 'custom' : 'realistic';
  return { storyType: storyCategory === 'custom' ? 'custom' : storyTopic, storyCategory, storyTopic, storyTheme, customThemeText: '', storyDetails: '' };
}
