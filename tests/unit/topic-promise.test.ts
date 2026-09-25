/**
 * THE TOPIC PROMISE (owner, 2026-09-25). Every adventure guide carries one
 * "PROMISE:" line — what a reader of that theme must get. It binds like the
 * commission, so it leaves the guide body (which is "material", GUIDE_USE_RULE)
 * and is stated once in its own section to every stage that reads the guide:
 * the arc creator, the re-teller, the panel, the arc reviewer and the idea call.
 * Evidence: Lab #1462 / #1464 had no dragon character until the hatchling.
 *
 * And no guide line states a size: sizes belong to the Visual Bible and the
 * images (owner, 2026-09-23).
 */
import { describe, it, beforeAll, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const PB = require('../../server/lib/promptBuilders');
const { loadPromptTemplates } = require('../../server/services/prompts');

const GUIDE_FILE = fs.readFileSync(path.join(__dirname, '../../prompts/adventure-guides.txt'), 'utf8').replace(/\r\n/g, '\n');

const dragon = {
  pages: 18, language: 'de-CH', languageLevel: '1st-grade', storyCategory: 'adventure', storyTheme: 'dragon',
  storyDetails: 'Vier Kinder finden ein Ei.',
  characters: [{ id: 'a', name: 'Anna', age: 5 }, { id: 'b', name: 'Ben', age: 3 }],
  mainCharacters: ['a', 'b'],
};

const count = (hay: string, needle: string) => hay.split(needle).length - 1;

describe('the topic promise', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('every adventure theme carries exactly one PROMISE line', () => {
    const themes = GUIDE_FILE.split(/^\[([a-z0-9-]+)\]$/m).slice(1);
    expect(themes.length / 2).toBeGreaterThanOrEqual(30);
    for (let i = 0; i < themes.length; i += 2) {
      const promises = themes[i + 1].split('\n').filter(l => /^PROMISE:/.test(l));
      expect(promises, themes[i]).toHaveLength(1);
    }
    expect(PB.guidePromise(PB.getAdventureGuide('dragon'))).toMatch(/^A grown dragon is a character/);
  });

  it('the arc create prompt states the dragon promise once, as its own binding section, outside the material guide', () => {
    const promise = PB.guidePromise(PB.getAdventureGuide('dragon'));
    const create = PB.buildArcCreatePrompt(dragon, 18);
    expect(count(create, promise)).toBe(1);
    expect(create).toContain(`${PB.TOPIC_PROMISE_HEADING}\n${promise}`);
    const guideStart = create.indexOf('# TOPIC GUIDE');
    expect(guideStart).toBeGreaterThan(0);
    const guideEnd = create.indexOf('\n# ', guideStart + 1);
    const guideBlock = create.slice(guideStart, guideEnd);
    expect(guideBlock).toContain(PB.GUIDE_USE_RULE);
    expect(guideBlock).not.toMatch(/PROMISE/);
    expect(create).not.toMatch(/^PROMISE:/m);
  });

  it('the re-teller, the panel and the arc reviewer read it; the critique and the panel check it', () => {
    const promise = PB.guidePromise(PB.getAdventureGuide('dragon'));
    const committed = '# STORY LOGIC\nx\n\n# ARC\n1. A story.';
    const retell = PB.buildArcRetellPrompt(dragon, 18, committed, '## PANELIST A\nx');
    const panel = PB.buildArcPanelPrompt(dragon, committed);
    const review = PB.buildArcReviewPrompt(dragon, '1. A story.');
    for (const [stage, p] of Object.entries({ retell, panel, review })) {
      expect(count(p, promise), stage).toBe(1);
      expect(p, stage).not.toMatch(/\{[A-Z][A-Z_]+\}/);
    }
    expect(PB.arcCritiqueSpec()).toMatch(/a TOPIC PROMISE, where one is given, counts among the commission's words/);
    expect(panel).toMatch(/^- PROMISE — where a TOPIC PROMISE is given, the arc breaks it/m);
  });

  it('a guide without a promise gives no section, and the strip leaves the rest of the guide intact', () => {
    expect(PB.buildTopicPromiseSection('Story guidance:\n- x')).toBe('');
    expect(PB.stripGuidePromise('PROMISE: y\nCOSTUME: z\n- x')).toBe('COSTUME: z\n- x');
    expect(PB.stripGuidePromise(null)).toBeNull();
    const ctx = PB.buildStoryContextFields({ ...dragon, storyTheme: 'no-such-theme' });
    expect(ctx.TOPIC_PROMISE).toBe('');
  });

  it('no guide line states a size (sizes are the Visual Bible\'s)', () => {
    const sized = GUIDE_FILE.split('\n').filter(l => !l.startsWith('#') && /-sized|\bsize of\b|\bhuge\b|\btiny\b|\bgiants?\b|\bas (?:big|small|tall) as\b/i.test(l));
    expect(sized).toEqual([]);
  });
});
