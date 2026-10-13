// The trial wizard's ideas (and what is derived from them) belong to the story
// kind they were generated for. The visitor can go back and change the kind;
// returning to the ideas step must then regenerate, never show or create from
// the old kind's ideas (prod trial job_1791902238992_1otf3def4: unicorn ideas
// created with storyTheme "mermaid"). The full wizard does the same in
// StoryWizard.tsx (category/topic/theme change clears generatedIdeas).

interface IdeaKindInput {
  storyCategory: string;
  storyTopic: string;
  storyTheme: string;
  language: string;
}

export interface TrialIdeasState<I, T> {
  ideas: I[];
  selectedIndex: number | null;
  titlePageData: T | null;
  /** ideaInputKey of the input the ideas / title page were produced for; null = none yet. */
  ideasKey: string | null;
  /** 1 = first pair shown, >1 after "Generate New Ideas". */
  attempt: number;
}

export function ideaInputKey(input: IdeaKindInput): string {
  return JSON.stringify([input.storyCategory, input.storyTopic, input.storyTheme, input.language]);
}

/** Returns the SAME object when the input still matches, else an emptied state for the new input. */
export function reconcileIdeasWithInput<I, T>(
  state: TrialIdeasState<I, T>,
  input: IdeaKindInput
): TrialIdeasState<I, T> {
  const key = ideaInputKey(input);
  if (state.ideasKey === null || state.ideasKey === key) return state;
  return { ideas: [], selectedIndex: null, titlePageData: null, ideasKey: key, attempt: 0 };
}
