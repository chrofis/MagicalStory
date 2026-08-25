import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { resolveIdeaProvenance, SOURCES } = require_('../../server/lib/ideaProvenance');

const OURS_A = 'Leynor sitzt auf dem Deck und teilt sein Essen mit einem Hund.';
const OURS_B = 'Leynor zeigt auf die Wellen, die Vögel und eine Krabbe auf den Planken.';
const offered = (selectedIndex: number | null) => ({ output: [OURS_A, OURS_B], selectedIndex });

describe('resolveIdeaProvenance', () => {
  it('is ours-unchanged when the used text matches the selected idea', () => {
    const r = resolveIdeaProvenance({ storyDetails: OURS_A, ideaGeneration: offered(0) });
    expect(r.source).toBe(SOURCES.OURS_UNCHANGED);
    expect(r.original).toBe(OURS_A);
    expect(r.used).toBe(OURS_A);
  });

  it('is ours-edited on ANY difference, however small', () => {
    const r = resolveIdeaProvenance({
      storyDetails: OURS_A.replace('Hund', 'grossen Hund'),
      ideaGeneration: offered(0),
    });
    expect(r.source).toBe(SOURCES.OURS_EDITED);
    expect(r.original).toBe(OURS_A);          // what we offered
    expect(r.used).toContain('grossen Hund'); // what they ran with
  });

  it('forgives only whitespace and line endings, not words', () => {
    expect(resolveIdeaProvenance({
      storyDetails: `\r\n  ${OURS_A}  \r\n`,
      ideaGeneration: offered(0),
    }).source).toBe(SOURCES.OURS_UNCHANGED);
  });

  it('is user-written when nothing was selected and nothing matches', () => {
    const r = resolveIdeaProvenance({
      storyDetails: 'Leynor fliegt mit einer Rakete zum Mond.',
      ideaGeneration: offered(null),
    });
    expect(r.source).toBe(SOURCES.USER_WRITTEN);
    expect(r.original).toBeNull();
  });

  it('still credits us when the index was lost but the text is verbatim ours', () => {
    const r = resolveIdeaProvenance({ storyDetails: OURS_B, ideaGeneration: offered(null) });
    expect(r.source).toBe(SOURCES.OURS_UNCHANGED);
    expect(r.original).toBe(OURS_B);
  });

  it('catches an edit made AFTER selecting — selectedIndex alone cannot', () => {
    // The wizard never resets selectedIdeaIndex when the textarea changes, so a
    // rewritten story still carries the index of the idea it started from.
    const r = resolveIdeaProvenance({
      storyDetails: 'Etwas ganz anderes, vom Kunden selbst geschrieben.',
      ideaGeneration: offered(0),
    });
    expect(r.source).toBe(SOURCES.OURS_EDITED);
  });

  it('stamps a trial as ours-unchanged — the trial has no way to edit', () => {
    const r = resolveIdeaProvenance({ storyDetails: OURS_A, trialMode: true });
    expect(r.source).toBe(SOURCES.OURS_UNCHANGED);
    expect(r.original).toBe(OURS_A);
  });

  it('never throws on a story with no idea data at all', () => {
    const r = resolveIdeaProvenance({});
    expect(r.source).toBe(SOURCES.USER_WRITTEN);
    expect(r.used).toBe('');
  });

  it('ignores an out-of-range selectedIndex instead of crashing', () => {
    const r = resolveIdeaProvenance({ storyDetails: 'x', ideaGeneration: offered(7) });
    expect(r.source).toBe(SOURCES.USER_WRITTEN);
  });
});
