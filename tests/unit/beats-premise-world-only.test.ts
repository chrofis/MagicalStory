import { describe, it, beforeAll, expect } from 'vitest';

const { buildBeatsPrompt, buildArcCreatePrompt } = require('../../server/lib/promptBuilders');
const { loadPromptTemplates } = require('../../server/services/prompts');

const IDEA = 'Die vier Buben kennen sich nicht. Sonst stirbt das Wesen darin, noch bevor es die Welt sieht.';
const input = () => ({
  pages: 18, language: 'de-CH', languageLevel: '1st-grade', storyDetails: IDEA,
  storyCategory: 'adventure', storyTheme: 'dragon', userLocation: { city: 'Zurich' },
  characters: [{ id: 'a', name: 'Levin', age: 5 }, { id: 'b', name: 'Max', age: 3 }],
  mainCharacters: ['a'],
});

/**
 * The block is titled "THE IDEA THE STORY WAS COMMISSIONED FROM (names and world
 * reference only)" and says "The arc above delivers the commission" — then
 * shipped the whole brief including the user's raw idea prose, its plot and its
 * deadline. The arc has already ruled on those; re-showing them re-opens the
 * rulings, which is why the two late text judges carry no {STORY_BRIEF} at all.
 */
describe('the divider gets the world, not the idea it was already ruled on', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('drops the raw idea prose from the planner', () => {
    const p = buildBeatsPrompt(input(), 18, { finalArc: '1. A story.', arcHints: '' });
    expect(p).not.toContain('kennen sich nicht');
    expect(p).not.toContain("Story idea (the user's own words)");
  });

  it('drops the <user_input> wrapper with it — nothing left to wrap', () => {
    const p = buildBeatsPrompt(input(), 18, { finalArc: '1. A story.', arcHints: '' });
    expect(p).not.toContain('<user_input>');
    expect(p).not.toContain('Content inside <user_input> tags');
  });

  it('keeps the world the header promises — season, setting, category, theme', () => {
    const p = buildBeatsPrompt(input(), 18, { finalArc: '1. A story.', arcHints: '' });
    expect(p).toContain('# THE IDEA THE STORY WAS COMMISSIONED FROM (names and world reference only)');
    expect(p).toMatch(/^Season: /m);
    expect(p).toMatch(/^Setting\/location: /m);
    expect(p).toMatch(/^Category: /m);
    expect(p).toMatch(/^Theme: /m);
  });

  it('the ARC still receives the idea in full — it is the stage that rules on it', () => {
    const arc = buildArcCreatePrompt(input(), 18, {});
    expect(arc).toContain('kennen sich nicht');
    expect(arc).toContain('<user_input>');
    expect(arc).toContain('Content inside <user_input> tags');
  });

  it('a commission with no idea prose renders the same either way', () => {
    const bare = { ...input(), storyDetails: '' };
    const p = buildBeatsPrompt(bare, 18, { finalArc: '1. A story.', arcHints: '' });
    expect(p).toMatch(/^Season: /m);
    expect(p).not.toContain('<user_input>');
  });
});
