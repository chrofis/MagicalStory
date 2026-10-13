/**
 * Prod trial job_1791902238992_1otf3def4: the visitor picked theme unicorn, got
 * unicorn ideas, picked one, went back and changed the theme to mermaid, came
 * back to the ideas step and found the SAME unicorn ideas, still selected.
 * Create sent storyTheme "mermaid" + the unicorn idea text (mermaid costume in
 * a unicorn story). Ideas (and everything derived from them) must be dropped
 * the moment the story kind they were generated for no longer matches.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { ideaInputKey, reconcileIdeasWithInput } from '../../client/src/utils/trialIdeas';

const base = { storyCategory: 'adventure', storyTopic: '', storyTheme: 'unicorn', storyDetails: '', language: 'de-ch' };
const ideas = [
  { title: 'Einhorn A', summary: 'a', themes: [] },
  { title: 'Einhorn B', summary: 'b', themes: [] },
];

describe('trial ideas reset when the story kind changes', () => {
  const held = {
    ideas,
    selectedIndex: 0 as number | null,
    titlePageData: { costumeType: 'unicorn' } as { costumeType: string | null } | null,
    ideasKey: ideaInputKey(base),
    attempt: 2,
  };

  it('unicorn ideas, card 0 selected, theme changed to mermaid: everything derived is dropped', () => {
    const next = reconcileIdeasWithInput(held, { ...base, storyTheme: 'mermaid' });
    expect(next.ideas).toEqual([]);
    expect(next.selectedIndex).toBeNull();
    expect(next.titlePageData).toBeNull();
    expect(next.attempt).toBe(0);
  });

  it('the next generation request is built from the new theme', () => {
    const mermaid = { ...base, storyTheme: 'mermaid' };
    const next = reconcileIdeasWithInput(held, mermaid);
    // the ideas step builds its request body from the live storyInput (TrialIdeasStep)
    const body = JSON.parse(JSON.stringify({ storyTheme: mermaid.storyTheme, language: mermaid.language }));
    expect(body.storyTheme).toBe('mermaid');
    expect(next.ideasKey).toBe(ideaInputKey(mermaid));
  });

  it.each([
    ['category', { storyCategory: 'life-challenge' }],
    ['topic', { storyTopic: 'first-day' }],
    ['language', { language: 'en' }],
  ])('a changed %s also drops the ideas', (_n, patch) => {
    expect(reconcileIdeasWithInput(held, { ...base, ...patch }).ideas).toEqual([]);
  });

  it('an unchanged kind (or an edit of storyDetails) keeps ideas, selection and costume', () => {
    expect(reconcileIdeasWithInput(held, { ...base, storyDetails: 'x' })).toBe(held);
  });

  it('the wizard applies the reconcile on every storyInput change and records the key at generation', () => {
    const w = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'src', 'pages', 'TrialWizard.tsx'), 'utf8').split('\r\n').join('\n');
    expect(w).toContain('reconcileIdeasWithInput(');
    expect(w).toContain('ideaInputKey(');
  });
});
