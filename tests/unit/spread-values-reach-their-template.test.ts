/**
 * A value computed and spread into a template that never declares the
 * placeholder is silently discarded — the defect class fixed on 2026-09-13
 * (docs/decisions.md). `fillTemplate` substitutes declared placeholders and
 * ignores the rest, so the drop is invisible: the prompt builds, nothing warns,
 * and the stage simply runs without the context it was meant to have.
 *
 * Two instances are pinned here:
 *
 *   - `arc-retell.txt` — the stage that RE-TELLS the whole story — spread
 *     `STORY_GUIDE_SECTION` (the topic guide: facts and context for the
 *     commissioned life skill) but declared no placeholder, so the re-telling
 *     rewrote the arc with the guide out of view while `arc-create.txt` had it.
 *   - the unified writer's templates carried `{CATEGORY_GUIDELINES}` but no
 *     `{AGE_MODE}`, and the builder passed no such key, so the age band AND the
 *     topic-age-window nudge never reached the legacy writer at all.
 *
 * These pin behaviour, not wording: that the guide body reaches the retell,
 * that the band and the window nudge reach the unified writer, that the age
 * band lands AFTER the category guidelines (its own text claims to override
 * instructions elsewhere, so it must be the last word), and that no prompt in
 * the family ships an unfilled `{PLACEHOLDER}`.
 */
import { describe, it, beforeAll, expect } from 'vitest';

const {
  buildStoryContextFields,
  buildAgeModeSection,
  buildArcCreatePrompt,
  buildArcRetellPrompt,
  buildTrialStoryPrompt,
} = require('../../server/lib/promptBuilders');
const { loadPromptTemplates } = require('../../server/services/prompts');

// A real windowed topic from TOPIC_AGE_WINDOWS: dealing-bully is ages 5-12, so
// a 3-year-old focus child is outside it and the window nudge must fire.
const base = {
  title: 'The Lost Kite',
  storyCategory: 'life-challenge',
  storyTheme: 'Life Skills',
  storyTopic: 'dealing-bully',
  storyDetails: 'A child faces a bully at school.',
  language: 'en',
  readingLevel: 'beginner',
  characters: [
    { id: 1, name: 'Mia', role: 'main', age: 3, gender: 'female', hairColor: 'brown' },
    { id: 2, name: 'Leo', role: 'primary', age: 6, gender: 'male', hairColor: 'black' },
  ],
  relationships: { '1-2': 'Sister of' },
  relationshipTexts: {},
};

const COMMITTED_ARC = '1. Mia sees the bully.\n2. Mia tells Leo.\nCRITIQUE: [MAJOR] thin.';

const unfilled = (prompt: string) => [...new Set(prompt.match(/\{[A-Z_][A-Z_0-9]*\}/g) || [])];

// One unified variant strips CRLF out of the assembled prompt and the other
// does not, and the age-band templates are CRLF on disk. Line endings are not
// the behaviour under test.
const lf = (s: string) => String(s).replace(/\r\n/g, '\n').trim();

describe('values spread into a prompt actually reach it', () => {
  beforeAll(async () => {
    await loadPromptTemplates();
  });

  it('the topic guide reaches the arc re-tell, not only arc-create', () => {
    const guide = String(buildStoryContextFields(base).STORY_GUIDE_SECTION || '');
    expect(guide.trim().length).toBeGreaterThan(0);

    const create = buildArcCreatePrompt(base, 12);
    const retell = buildArcRetellPrompt(base, 12, COMMITTED_ARC, 'Panelist A: x');

    // The guide body itself, not the placeholder name.
    expect(lf(create)).toContain(lf(guide));
    expect(lf(retell)).toContain(lf(guide));

    // It is context for the re-telling, so it precedes the task, exactly as in
    // arc-create: after the character facts, ahead of the shape and budgets.
    expect(lf(retell).indexOf(lf(guide))).toBeLessThan(lf(retell).indexOf('# YOUR TASK'));
  });

  it('the age band and the topic-window nudge reach the unified writer', () => {
    const ageMode = lf(buildAgeModeSection(base));
    // The two halves of the block: the band's own override claim, and the
    // window nudge for a topic this child is too young for. Asserted
    // separately because fillTemplate collapses the blank run that joins them.
    const bandLine = 'These rules override any instruction';
    const nudge = ageMode.split('\n').find((l: string) => l.includes('Topic timing')) as string;
    expect(ageMode).toContain(bandLine);
    expect(nudge).toContain('ages 5-12');

    // The two unified variants were the subjects here until 2026-09-15, when
    // both templates and buildUnifiedStoryPrompt were deleted as unreachable.
    const prompt = lf(buildTrialStoryPrompt({ ...base, trialMode: true }, 12));
    expect(prompt).toContain(bandLine);
    expect(prompt).toContain(nudge);

    // The band claims to override instructions elsewhere, so it must come
    // after the category guidelines it is allowed to restrain.
    expect(prompt.indexOf(bandLine))
      .toBeGreaterThan(prompt.indexOf('# Story Category Guidelines'));
  });

  it('no prompt in the family ships an unfilled placeholder', () => {
    expect(unfilled(buildArcCreatePrompt(base, 12))).toEqual([]);
    expect(unfilled(buildArcRetellPrompt(base, 12, COMMITTED_ARC, 'Panelist A: x'))).toEqual([]);
    expect(unfilled(buildTrialStoryPrompt({ ...base, trialMode: true }, 12))).toEqual([]);
  });

  it('an in-window topic still reaches the writer with the band and no nudge', () => {
    // Same builder, the other branch: age 5 is inside dealing-bully's 5-12
    // window, so the band ships and the nudge does not.
    const inWindow = {
      ...base,
      characters: [{ ...base.characters[0], age: 5 }, base.characters[1]],
    };
    const ageMode = lf(buildAgeModeSection(inWindow));
    expect(ageMode.trim().length).toBeGreaterThan(0);
    expect(ageMode).not.toMatch(/Topic timing/);
    // Not every band carries the same opening sentence, so pin the band this
    // age actually resolves to: its own first line must reach the prompt.
    const firstLine = ageMode.split('\n')[0];
    expect(lf(buildTrialStoryPrompt({ ...inWindow, trialMode: true }, 12))).toContain(firstLine);
  });

  it('an older reader gets the journey band, and it reaches the prompt whole', () => {
    // There is no longer a "past the bands" reader: from 2026-09-14 age 6 and
    // up resolves to journey rather than to silence. This used to assert an
    // EMPTY block, which is the bug it was pinning in place. What still has to
    // hold is that nothing arrives as a literal placeholder.
    const older = {
      ...base,
      characters: [{ ...base.characters[0], age: 9 }, base.characters[1]],
    };
    const ageMode = String(buildAgeModeSection(older) || '').trim();
    expect(ageMode).toContain("# HERO'S JOURNEY (age 9)");
    expect(ageMode).not.toMatch(/\{[A-Z][A-Z0-9_]*\}/);
    expect(lf(buildTrialStoryPrompt({ ...older, trialMode: true }, 12))).toContain(ageMode.split('\n')[0]);
    expect(unfilled(buildTrialStoryPrompt({ ...older, trialMode: true }, 12))).toEqual([]);
  });
});
