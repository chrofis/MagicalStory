/**
 * Sizes and looks belong to the pictures (owner, 2026-09-23).
 *
 * ONE string, SIZE_LOOK_RULE, reaches every stage that writes the story — the
 * arc creator and re-teller (inside {TELLING_RULES}), the page planner
 * ({SIZE_LOOK_RULE} in story-beats.txt) and every prose pass (STYLE_RULEBOOK).
 * The Visual Bible author still decides every element's size: `scaleClass`
 * stays required at both authoring sites.
 *
 * Pins behaviour — which shared string reaches which built prompt — never the
 * rule's wording.
 */
import { describe, it, beforeAll, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const PB = require('../../server/lib/promptBuilders');
const { SCALE_CLASS_SPEC } = require('../../server/lib/visualBible');
const { loadPromptTemplates } = require('../../server/services/prompts');

const input = (extra: any = {}) => ({
  language: 'de-ch', languageLevel: '1st-grade', storyCategory: 'adventure', storyTheme: 'dragon',
  storyDetails: 'Zwei Kinder finden ein Ei.',
  characters: [
    { id: 'a', name: 'Anna', age: 5, gender: 'female' },
    { id: 'b', name: 'Ben', age: 3, gender: 'male' },
  ],
  mainCharacters: ['a', 'b'],
  ...extra,
});

describe('SIZE_LOOK_RULE — one rule for arc, plan and prose', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('is exported and non-empty', () => {
    expect(typeof PB.SIZE_LOOK_RULE).toBe('string');
    expect(PB.SIZE_LOOK_RULE.length).toBeGreaterThan(40);
  });

  it('reaches the arc creator and the re-teller, at every age band', () => {
    // A simple band and the standard band build different TELLING_RULES.
    for (const data of [input(), input({ characters: [{ id: 'a', name: 'Anna', age: 2, gender: 'female' }], mainCharacters: ['a'] })]) {
      const create = PB.buildArcCreatePrompt(data, 18);
      const retell = PB.buildArcRetellPrompt(data, 18, 'ARC: a committed arc', 'SOLUTION: one');
      expect(create).toContain(PB.SIZE_LOOK_RULE);
      expect(retell).toContain(PB.SIZE_LOOK_RULE);
      // The SENSE rule still lets the arc reason about how big things are.
      expect(create).toContain(PB.ARC_SENSE_RULE);
    }
  });

  it('reaches the page planner, first plan and re-plan, with no placeholder left', () => {
    const first = PB.buildBeatsPrompt(input(), 18, { finalArc: '1. A story.' });
    const replan = PB.buildBeatsPrompt(input(), 18, { finalArc: '1. A story.', replan: 'RE-DIVIDE: page 3' });
    for (const p of [first, replan]) {
      expect(p).toContain(PB.SIZE_LOOK_RULE);
      expect(p).not.toContain('{SIZE_LOOK_RULE}');
    }
  });

  it('is the size line of the prose style rulebook', () => {
    expect(PB.STYLE_RULEBOOK).toContain(PB.SIZE_LOOK_RULE);
  });

  it('the Visual Bible authors still size every element themselves', () => {
    // Both live authoring sites declare the scaleClass spec; the constant is
    // filled, never hand-typed (vb-scale-class.test.ts pins the fill).
    for (const rel of ['prompts/scene-expansion-all.txt', 'prompts/story-trial.txt']) {
      const text = fs.readFileSync(path.join(__dirname, '../../', rel), 'utf8');
      expect(text.includes('{SCALE_CLASS_SPEC}'), rel).toBe(true);
    }
    expect(SCALE_CLASS_SPEC).toMatch(/Never omitted/);
    expect(SCALE_CLASS_SPEC).not.toContain('"');
  });
});
