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
