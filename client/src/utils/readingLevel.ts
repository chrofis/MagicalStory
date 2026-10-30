import type { Character } from '@/types/character';
import type { LanguageLevel } from '@/types/story';
import { pickMainCharacters } from './mainCharacters';

/**
 * Reading level pre-selected from the YOUNGEST main character's age (owner,
 * 2026-10-30). The bands are the ones the step-3 level cards print:
 * Picture book 3-6, Children's book 6-10, Young reader 10+; under 3 takes the
 * picture book. The mains are the ones the server counts (pickMainCharacters),
 * so the wizard and the story agree on who "main" is.
 */
export function readingLevelForAge(age: number): LanguageLevel {
  if (age < 6) return '1st-grade';
  if (age < 10) return 'standard';
  return 'advanced';
}

export interface AutoReadingLevel {
  level: LanguageLevel;
  name: string;
  age: number;
  /** Changes when the counted mains or their ages change; a manual choice is only kept for the same signature. */
  signature: string;
}

/** `inStory` = characters in the story (excluded ones removed). Null when no main has a readable age. */
export function autoReadingLevel(inStory: Character[], mainIds: number[]): AutoReadingLevel | null {
  const aged = pickMainCharacters(inStory, mainIds).counted
    .map(c => ({ c, age: parseInt(c.age, 10) }))
    .filter(x => Number.isFinite(x.age) && x.age >= 0);
  if (aged.length === 0) return null;
  const youngest = aged.reduce((a, b) => (b.age < a.age ? b : a));
  return {
    level: readingLevelForAge(youngest.age),
    name: youngest.c.name,
    age: youngest.age,
    signature: aged.map(x => `${x.c.id}:${x.age}`).sort().join(','),
  };
}
