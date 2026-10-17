/**
 * Staging job_1792226018737_lb65hzkqs (2026-10-17): the Visual Bible described a boarding plank as "its inner end
 * resting on the ship's rail"; the element-cell gate failed the first cell for "lacking the described context of
 * resting on a ship's rail", the re-render added a rail stump, and every page copied it. OBJECT_NOT_PLACED_RULE is
 * the one sentence both writers and the cell gates read. Pinned by which constant reaches which built prompt.
 */
import { describe, it, beforeAll, expect } from 'vitest';
import fs from 'fs';

const PB = require('../../server/lib/promptBuilders');
const RS = require('../../server/lib/referenceSheets');
const { loadPromptTemplates } = require('../../server/services/prompts');

const chars = [{ id: 'a', name: 'Levin', age: 5, isMainCharacter: true }];
const input = () => ({ pages: 4, season: 'autumn', language: 'en', storyDetails: 'x', characters: chars, mainCharacters: ['a'], storyCategory: 'adventure', storyType: 'adventure', artStyle: 'watercolor', languageLevel: 'standard' });
const beats = [{ pageNumber: 1, planLine: 'medium — Levin — waits — nothing', fixed: { timeOfDay: 'dusk', indoor: false } }];
const RULE = () => PB.OBJECT_NOT_PLACED_RULE;

beforeAll(async () => { await loadPromptTemplates(); });

describe('an object description never names its support', () => {
  it('the rule forbids the support and keeps built-in parts, with no test-story example', () => {
    expect(RULE()).toMatch(/never where it is/);
    expect(RULE()).toMatch(/built with/);
    expect(RULE()).not.toMatch(/plank|gangplank|ship|Spaghetti/i);
  });

  it('both Visual Bible writers are given it', () => {
    expect(PB.buildVisualBibleCallPrompt(input(), beats, { maxCharactersPerScene: 6, finalArc: '1.' })).toContain(RULE());
    expect(PB.buildTrialArcPrompt(input(), 4)).toContain(RULE());
  });

  it('the identity clause no longer invites a separate thing the object attaches to', () => {
    const t = fs.readFileSync('prompts/visual-bible.txt', 'utf8');
    expect(t).not.toMatch(/what it attaches to/);
    expect(t).not.toMatch(/never puts it in the picture/);
  });

  it('the element-cell gate and the state-cell gate carry it (regression: the gate demanded the support)', () => {
    const el = { kind: 'object', description: 'a plain board, its inner end resting on a rail' };
    expect(RS.elementCellGatePrompt(el, 'watercolor')).toContain(RULE());
    expect(RS.stateCellsGatePrompt(el, [{ stateName: 'a', delta: 'x' }, { stateName: 'b', delta: 'y' }])).toContain(RULE());
  });

  it('no built prompt leaves the placeholder unfilled', () => {
    for (const p of [PB.buildVisualBibleCallPrompt(input(), beats, { maxCharactersPerScene: 6, finalArc: '1.' }), PB.buildTrialArcPrompt(input(), 4)]) {
      expect(p).not.toContain('{OBJECT_NOT_PLACED}');
    }
  });
});
