/**
 * Prod job_1793893086454_ao77wh9j5 (2026-11-07): a creature's horn is hidden until a reveal page; the Visual Bible drew one
 * cell with the horn showing, so every render of the head brought it back. HIDDEN_FEATURE_STATE_RULE is the one sentence
 * both Visual Bible writers and the state-cell gate read. Pinned by which constant reaches which built prompt.
 */
import { describe, it, beforeAll, expect } from 'vitest';
import fs from 'fs';

const PB = require('../../server/lib/promptBuilders');
const RS = require('../../server/lib/referenceSheets');
const VB = require('../../server/lib/visualBible');
const { loadPromptTemplates } = require('../../server/services/prompts');

const chars = [{ id: 'a', name: 'Levin', age: 5, isMainCharacter: true }];
const input = () => ({ pages: 4, season: 'autumn', language: 'en', storyDetails: 'x', characters: chars, mainCharacters: ['a'], storyCategory: 'adventure', storyType: 'adventure', artStyle: 'watercolor', languageLevel: 'standard' });
const beats = [{ pageNumber: 1, planLine: 'medium — Levin — waits — nothing', fixed: { timeOfDay: 'dusk', indoor: false } }];
const RULE = () => PB.HIDDEN_FEATURE_STATE_RULE;

beforeAll(async () => { await loadPromptTemplates(); });

describe('a feature the story hides until a reveal page is a hidden / revealed state', () => {
  it('the rule names both states, adds a case only, and carries no test-story example', () => {
    expect(RULE()).toMatch(/`hidden` state/);
    expect(RULE()).toMatch(/`revealed` state/);
    expect(RULE()).toMatch(/gets no states from this/);
    expect(RULE()).not.toMatch(/horn|unicorn|forelock|Einhorn|Rubi|Spaghetti/i);
  });

  it('both Visual Bible writers are given it, and the restraint rule is still there', () => {
    expect(PB.buildVisualBibleCallPrompt(input(), beats, { maxCharactersPerScene: 6, finalArc: '1.' })).toContain(RULE());
    expect(PB.buildTrialArcPrompt(input(), 4)).toContain(RULE());
    expect(fs.readFileSync('prompts/visual-bible.txt', 'utf8')).toContain('Almost every entry has no states at all');
  });

  it('the state-cell gate carries it, so a hidden cell is not failed as a missing feature (generator-vs-critic)', () => {
    const el = { kind: 'animal', description: 'a pony with a spiral horn on its brow' };
    const p = RS.stateCellsGatePrompt(el, [{ stateName: 'hidden', delta: 'the horn is covered by the forelock' }, { stateName: 'revealed', delta: 'the horn is in plain view' }]);
    expect(p).toContain(RULE());
    expect(p).toMatch(/shows the feature nowhere and is correct that way/);
  });

  it('no built prompt leaves the placeholder unfilled', () => {
    for (const p of [PB.buildVisualBibleCallPrompt(input(), beats, { maxCharactersPerScene: 6, finalArc: '1.' }), PB.buildTrialArcPrompt(input(), 4)]) {
      expect(p).not.toContain('{HIDDEN_FEATURE_STATE}');
    }
  });
});

describe('the existing state mechanism picks the cell per page (nothing new needed)', () => {
  it('hidden covers the pages before the reveal, revealed the reveal page onward', () => {
    const entry = { id: 'ANI001', states: VB.normaliseObjectStates([
      { name: 'hidden', delta: 'covered', description: 'x', removed: [], pages: [1, 2, 3] },
      { name: 'revealed', delta: 'in view', description: 'y', removed: [], pages: [4, 5] },
    ], 'ANI001') };
    expect(VB.objectStateForPage(entry, 2).name).toBe('hidden');
    expect(VB.objectStateForPage(entry, 4).name).toBe('revealed');
    expect(VB.objectStateForPage(entry, 5).id).toBe('ANI001.2');
  });
});
