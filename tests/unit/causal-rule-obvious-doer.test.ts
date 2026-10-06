/**
 * The text audit's UNFORCED question has two halves: a barrier whose way around
 * no page closes, and the obvious doer who stays behind with no stated reason.
 * The writer-side rule (CAUSAL_COHERENCE_RULE, carried by every story-shape
 * section) must state both, or the audit deducts for a rule nobody was given.
 */
import { describe, it, expect } from 'vitest';

const PB = require('../../server/lib/promptBuilders');

const input = (age: number) => ({
  characters: [{ name: 'Mia', age, isMain: true }],
  storyTopic: '',
});

describe('CAUSAL_COHERENCE_RULE reaches the writer with both halves', () => {
  for (const age of [1, 3, 5, 9]) {
    it(`age ${age}: shape section carries the barrier half and the obvious-doer half`, () => {
      const out = PB.buildStoryShapeSection(input(age), 10, { arc: true });
      expect(out).toContain('way around closed somewhere in the story');
      expect(out).toContain('obvious doer');
    });
  }
});
