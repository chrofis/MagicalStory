import { describe, it, expect, beforeAll } from 'vitest';

const { buildBeatsPrompt } = require('../../server/lib/promptBuilders');

// Owner ruling 2026-09-15 (generator↔critic gap audit, rows 1/7/10/11/25/29):
// plan-check.txt enforces entrances, a wanted picture per act, a justified
// third character, both directions of plant-and-payoff, the last page, and a
// roster in which a named animal is a PERSON. The planner was never told any
// of it. Asserted on the BUILT prompt, never on template text.
describe('the plan critic\'s checks reach the planner', () => {
  let prompt: string;

  beforeAll(async () => {
    await require('../../server/services/prompts').loadPromptTemplates();
    prompt = buildBeatsPrompt(
      { characters: [{ name: 'Mara', age: 7 }], language: 'de', pages: 18 },
      18,
      { finalArc: 'An arc.' },
    );
  });

  it('check 2 — entrances', () => {
    expect(prompt).toContain("A character's first page stages their arrival or a naming by someone present");
    expect(prompt).toContain('a badge, a garment, a title or an epithet is not a naming');
  });

  it('check 3 — the plan line justifies the third character', () => {
    expect(prompt).toContain('the plan line itself carries what the third character does that the page cannot show without them');
  });

  it('check 4 — the picture a child most wants, per act', () => {
    expect(prompt).toContain('which picture does a child most want to see there');
  });

  it('check 7 — a plant without a payoff', () => {
    expect(prompt).toContain('nothing a page plants is left without a later page that pays it off');
  });

  it('check 8 — the last page', () => {
    expect(prompt).toContain("When the story's ending has an event of its own, the last page stages that event as its instant.");
  });

  it('the roster — a named animal counts toward the cast cap', () => {
    expect(prompt).toContain('a named animal that acts in the story counts as one of them');
  });

  it('leaves no unfilled placeholder behind', () => {
    expect(prompt).not.toMatch(/\{[A-Z_]{3,}\}/);
  });
});
