import { describe, it, beforeAll, expect } from 'vitest';

const pb = require('../../server/lib/promptBuilders');
const { loadPromptTemplates, PROMPT_TEMPLATES } = require('../../server/services/prompts');

/**
 * 8f was stated as absolute and obeyed on 2 of 15 pages — 13%, while every
 * COUNTABLE rule in the same prompt sat at 100% (element budget 0 violations,
 * interaction cap 0, `expression` present on 40/40 character entries).
 *
 * The cause was not burial and not disobedience: the rule asked for the wrong
 * FORM. Its first sentence is about "a vessel, building, vehicle or creature",
 * but its second said "every page that cites AN ELEMENT" — any element at all.
 *
 * Measured on job_1789759147125_p08djwhbl, whose entire Visual Bible is small:
 *   CLO001-003  a cap, a jacket, a scarf   — garments
 *   ART001      a melon-sized egg          — an everyday prop
 *   ANI001-003  knee-high, melon-sized, palm-sized
 * Not one vessel, building, vehicle or large creature. So the rule demanded a
 * figure-ratio for a wool cap, while 8g says a garment is sized "by where it
 * falls on the body" and a prop by "a familiar-size term" — and every one of
 * those elements already states its size in `scaleClass`. Three rules, three
 * forms, one of them overreaching into the other two.
 */
describe('the ratio rule asks only for what a ratio is for', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('the ratio demand is scoped to the things its own first sentence names', () => {
    const r = pb.TRUE_RELATIVE_SIZE_RULE;
    expect(r).toContain('cites one of THOSE — a vessel, a building, a vehicle');
    expect(r).not.toContain('Every page that cites an element and holds a figure');
  });

  it('and it says outright what does NOT take one, pointing at the rule that does', () => {
    const r = pb.TRUE_RELATIVE_SIZE_RULE;
    expect(r).toContain('Nothing else takes a ratio');
    expect(r).toContain('An everyday prop is sized by its own rule below');
    expect(r).toContain('a garment by where it falls on the body');
    expect(r).toContain('a CREATURE by the creature rule above');
  });

  it('it points at scaleClass, which already carries every element size once', () => {
    expect(pb.TRUE_RELATIVE_SIZE_RULE).toContain('Every element states its size once already, in its `scaleClass`');
  });

  it('the three size rules stay disjoint — each names a different form', () => {
    const t = String(PROMPT_TEMPLATES.sceneExpansionAll);
    // 8g keeps props and garments, in its own form
    expect(t).toContain('a familiar-size term');
    expect(t).toContain('"a fist-sized apple"');
    expect(t).toContain('a garment is sized by where it falls on the body');
    // and 8f no longer claims them
    expect(pb.TRUE_RELATIVE_SIZE_RULE).not.toContain('fist-sized');
  });

  it('what a ratio IS still for survives untouched', () => {
    const r = pb.TRUE_RELATIVE_SIZE_RULE;
    expect(r).toContain('the mast rises five times her height');
    expect(r).toContain('An adjective is not a ratio');
    // telling two similar things apart matters at any size
    expect(r).toContain('Two entries of one kind that differ in size each carry their own ratio');
  });
});
