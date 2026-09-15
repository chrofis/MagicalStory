import { describe, it, expect, beforeAll } from 'vitest';

const {
  buildSceneExpansionAllPrompt,
  buildSceneExpansionPrompt,
} = require('../../server/lib/promptBuilders');

// Owner ruling 2026-09-15 (generator↔critic gap audit, rows 3/4/5/21/22/30).
// sceneBriefCheck.js measures a text-zone distribution, a depth-band collision
// and an unresolvable interaction actor; scene-review.txt measures a shared
// surface's depth. None of it reached the Art Director. Asserted on the BUILT
// prompt, never on template text.
describe('the scene-brief critics\' rules reach the Art Director', () => {
  let all: string;
  let one: string;

  beforeAll(async () => {
    await require('../../server/services/prompts').loadPromptTemplates();
    all = buildSceneExpansionAllPrompt(
      { characters: [{ name: 'Mara', age: 7 }], language: 'de', layout: { textInImage: true } },
      [{ pageNumber: 1, text: 'A page.' }],
    );
    one = buildSceneExpansionPrompt(1, 'A page.', [{ name: 'Mara', age: 7 }], 'de');
  });

  // Rows 3/4/5 — one distribution decision, given to the only site that sees
  // the whole book.
  it('the all-pages AD is given the top/bottom floors, the streak limit and the full-width quota', () => {
    expect(all).toContain('at least 30% of pages put the text in a `top-*` position and at least 30% in a `bottom-*`');
    expect(all).toContain('never more than 3 consecutive pages in the same half');
    expect(all).toContain('30-50% of pages use `top-full` or `bottom-full`');
  });

  it('the per-page AD gets no book-wide quota it cannot satisfy', () => {
    expect(one).not.toContain('at least 30% of pages');
  });

  // Row 21 — textzone_character_collision measures the DEPTH band, not the side.
  it('both ADs pick the text half against declared depth', () => {
    for (const p of [all, one]) {
      expect(p).toContain("Pick the half against the figures' declared `depth`, not only the lateral side");
    }
  });

  // Row 22 — interaction_actor_unknown.
  it('both ADs are told who may occupy the actor slot', () => {
    for (const p of [all, one]) {
      expect(p).toContain('An actor in the `character` slot is a name listed in `characters[]` or the id of a visual bible animal');
      expect(p).toContain('an object, a vehicle or a place is never an actor');
    }
  });

  // Row 30 — scene-review.txt's [depth_unearned] shared-surface clause.
  it('both ADs put figures on one small shared surface at the same depth', () => {
    for (const p of [all, one]) {
      expect(p).toContain('Figures on one small shared surface — a boat, a raft, a cart, a wagon, a sled — are one level and carry the same `depth`');
    }
  });
});

// Restorations after the dead-writer deletion (7cd9ffabb): both rules lived
// only in the two unified writers and went with them.
describe('rules the deleted unified writers were the last to carry', () => {
  let all: string;
  let one: string;
  let trial: string;

  beforeAll(async () => {
    await require('../../server/services/prompts').loadPromptTemplates();
    const B = require('../../server/lib/promptBuilders');
    all = B.buildSceneExpansionAllPrompt(
      { characters: [{ name: 'Mara', age: 7 }], language: 'de', layout: { textInImage: true } },
      [{ pageNumber: 1, text: 'A page.' }],
    );
    one = B.buildSceneExpansionPrompt(1, 'A page.', [{ name: 'Mara', age: 7 }], 'de');
    trial = B.buildTrialStoryPrompt({ characters: [{ name: 'Mara', age: 7 }], language: 'de' }, 5);
  });

  it('depth is distance, never a size', () => {
    for (const p of [all, one]) {
      expect(p).toContain('`depth` is distance from the camera and never states a size');
    }
    expect(trial).toContain('`depth` never states a size');
  });

  it('a story-given proper name lives in properName and nowhere else', () => {
    for (const p of [all, trial]) {
      expect(p).toContain('lives in `properName` and nowhere else');
    }
  });
});
