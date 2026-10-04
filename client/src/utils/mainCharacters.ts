import type { Character } from '@/types/character';

/**
 * Which main characters the SERVER will actually count, and whose age picks the
 * story's age band. Client mirror of `pickMainCharacters` / `focusAge` in
 * server/lib/promptBuilders.js (registered in scripts/admin/sibling-registry.json
 * as `main-character-selection`). The wizard's explanation must say exactly what
 * the server does, so a change to the cap or the sort lands on both sides.
 * Background: three birthday books for a 2-year-old were written for her
 * 4-year-old brother because both were main and the oldest main decides.
 *
 * `characters` must be the characters IN the story (excluded ones removed) —
 * that is the list the wizard sends the server.
 */

const ageOf = (c: Character): number => parseInt(c.age, 10) || 0;

/** How many mains the server counts for a cast of this size (excluded characters not counted). */
export function mainLimit(inStoryCount: number): number {
  return Math.max(1, Math.min(2, Math.floor(inStoryCount / 2) || 1));
}

export interface MainSelection {
  /** Mains the server counts, oldest first. */
  counted: Character[];
  /** The character whose age decides the band (oldest counted main). */
  focus: Character | null;
  /** focus.age as a number, null when missing/unreadable. */
  focusAge: number | null;
}

export function pickMainCharacters(characters: Character[], mainIds: number[]): MainSelection {
  const declared = characters.filter(c => mainIds.includes(c.id));
  const counted = declared
    .slice()
    .sort((a, b) => ageOf(b) - ageOf(a))
    .slice(0, mainLimit(characters.length));
  const focus = counted[0] ?? null;
  const parsed = focus ? parseInt(focus.age, 10) : NaN;
  return { counted, focus, focusAge: Number.isFinite(parsed) && parsed >= 0 ? parsed : null };
}

/**
 * Mains after `charId` is made main in a cast of `inStoryCountAfter` characters.
 * `mainIds` is in selection order. Limit 1: the new main replaces the old one
 * (radio). Limit 2 and full: unchanged — the UI disables that button.
 */
export function addMainCharacter(inStoryCountAfter: number, mainIds: number[], charId: number): number[] {
  if (mainIds.includes(charId)) return mainIds;
  const limit = mainLimit(inStoryCountAfter);
  if (limit === 1) return [charId];
  return mainIds.length >= limit ? mainIds : [...mainIds, charId];
}

/**
 * Mains trimmed to the limit for the characters currently in the story: ids
 * not in the story are dropped, then the FIRST-selected ones are kept.
 */
export function trimMainCharacters(inStoryIds: number[], mainIds: number[]): number[] {
  return mainIds.filter(id => inStoryIds.includes(id)).slice(0, mainLimit(inStoryIds.length));
}

/**
 * Default main character when no role is stored: the FIRST-CREATED child aged
 * 1-10 (character ids are creation timestamps, `id: Date.now()`), else the
 * youngest character. One main, not every child: the oldest main sets the
 * story's age, so auto-selecting siblings silently wrote for the elder.
 */
export function defaultMainCharacterId(characters: Character[]): number | null {
  if (characters.length === 0) return null;
  const children = characters.filter(c => {
    const age = parseInt(c.age, 10);
    return age >= 1 && age <= 10;
  });
  if (children.length > 0) return children.reduce((a, b) => (b.id < a.id ? b : a)).id;
  return characters.reduce((min, c) => {
    const age = parseInt(c.age, 10) || 999;
    const minAge = parseInt(min.age, 10) || 999;
    return age < minAge ? c : min;
  }).id;
}
