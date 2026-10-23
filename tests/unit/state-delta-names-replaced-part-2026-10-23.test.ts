/**
 * Prod trial job_1792772600127_tv32st82h (2026-10-23): a state delta ("snapped", "carved branch bound with rope") never
 * said it REPLACED the part the base description still named, so the sheet drew the new thing beside the old one.
 * STATE_REPLACES_PART_RULE reaches both Visual Bible writers; STATE_WINS_RULE reaches the sheet prompt and the
 * state-consistency judge. Pinned by which constant reaches which built prompt.
 */
import { describe, it, beforeAll, expect } from 'vitest';

const PB = require('../../server/lib/promptBuilders');
const RS = require('../../server/lib/referenceSheets');
const { loadPromptTemplates } = require('../../server/services/prompts');

const chars = [{ id: 'a', name: 'Levin', age: 5, isMainCharacter: true }];
const input = () => ({ pages: 4, season: 'autumn', language: 'en', storyDetails: 'x', characters: chars, mainCharacters: ['a'], storyCategory: 'adventure', storyType: 'adventure', artStyle: 'watercolor', languageLevel: 'standard' });
const beats = [{ pageNumber: 1, planLine: 'medium — Levin — waits — nothing', fixed: { timeOfDay: 'dusk', indoor: false } }];

beforeAll(async () => { await loadPromptTemplates(); });

const stateful = {
  id: 'ART001', name: 'old gate', kind: 'gate', description: 'a wooden gate with a latch and two hinges',
  states: [
    { id: 'ART001.1', name: 'intact', delta: 'the latch is a plain iron bar', pages: [1] },
    { id: 'ART001.2', name: 'broken', delta: 'the latch is snapped in two', pages: [2] },
  ],
};

describe('state delta names the part it replaces', () => {
  it('the writer rule asks for "the <part> is now ..." and carries no test-story example', () => {
    expect(PB.STATE_REPLACES_PART_RULE).toMatch(/names that part exactly as `description` names it/);
    expect(PB.STATE_REPLACES_PART_RULE).toMatch(/the <part> is now <new thing>/);
    expect(PB.STATE_REPLACES_PART_RULE).not.toMatch(/cart|drawbar|branch|rope|Derin/i);
    expect(PB.STATE_WINS_RULE).not.toMatch(/cart|drawbar|branch|rope|Derin/i);
  });

  it('both Visual Bible writers are given it, placeholder filled', () => {
    for (const p of [PB.buildVisualBibleCallPrompt(input(), beats, { maxCharactersPerScene: 6, finalArc: '1.' }), PB.buildTrialArcPrompt(input(), 4)]) {
      expect(p).toContain(PB.STATE_REPLACES_PART_RULE);
      expect(p).not.toContain('{STATE_REPLACES_PART}');
    }
  });

  it('a state sheet carries the override line and every cell still carries base + delta', () => {
    const cells = RS.expandElementStateCells(stateful);
    const p = RS.buildReferenceSheetPrompt(cells, 'watercolor', null);
    expect(p).toContain(PB.STATE_WINS_RULE);
    expect(p).not.toContain('{STATE_RULE}');
    for (const c of cells) {
      expect(p).toContain(`${stateful.description}, ${c.delta}`);
    }
  });

  it('a sheet with no state cell carries no override line', () => {
    const p = RS.buildReferenceSheetPrompt([{ id: 'A1', name: 'ball', description: 'a red ball' }, { id: 'A2', name: 'cup', description: 'a blue cup' }], 'watercolor', null);
    expect(p).not.toContain(PB.STATE_WINS_RULE);
    expect(p).not.toContain('{STATE_RULE}');
  });

  it('the state-consistency judge reads the same override sentence', () => {
    const cells = RS.expandElementStateCells(stateful);
    expect(RS.stateCellsGatePrompt(stateful, cells)).toContain(PB.STATE_WINS_RULE);
  });
});
