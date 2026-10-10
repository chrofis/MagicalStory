/**
 * The trial writer is two prompts (planner story-trial-arc.txt, pages writer
 * story-trial-pages.txt; docs/decisions.md 2026-10-10 "Flash arc+bible v4").
 * A rule that "reaches the trial writer" reaches one or both of them, so the
 * tests that used to read the single prompt read the pair joined.
 */
const PB = require('../../../server/lib/promptBuilders');

/** Planner prompt + pages prompt (empty plan), as one string. */
export function trialWriterPrompt(inputData: any, pages?: number): string {
  return `${PB.buildTrialArcPrompt(inputData, pages)}\n\n${PB.buildTrialPagesPrompt(inputData, pages, '')}`;
}

/** Repo-relative paths of the two production templates. */
export const TRIAL_TEMPLATES = ['prompts/story-trial-arc.txt', 'prompts/story-trial-pages.txt'];
