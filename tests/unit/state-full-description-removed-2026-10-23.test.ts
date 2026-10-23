/**
 * Owner call 2026-10-23: each VB state carries its own full `description` (the changed part already replaced) and a typed
 * `removed` array. The sheet cell uses state.description instead of base + delta and adds one fixed "Not in this picture"
 * line built from the array. A bible stored before the fields keeps base + delta (stored-data constraint).
 */
import { describe, it, beforeAll, expect } from 'vitest';

const PB = require('../../server/lib/promptBuilders');
const RS = require('../../server/lib/referenceSheets');
const VB = require('../../server/lib/visualBible');
const { loadPromptTemplates } = require('../../server/services/prompts');

const chars = [{ id: 'a', name: 'Levin', age: 5, isMainCharacter: true }];
const input = () => ({ pages: 4, season: 'autumn', language: 'en', storyDetails: 'x', characters: chars, mainCharacters: ['a'], storyCategory: 'adventure', storyType: 'adventure', artStyle: 'watercolor', languageLevel: 'standard' });
const beats = [{ pageNumber: 1, planLine: 'medium — Levin — waits — nothing', fixed: { timeOfDay: 'dusk', indoor: false } }];

beforeAll(async () => { await loadPromptTemplates(); });

const withFields = {
  id: 'ART001', name: 'old gate', kind: 'gate', description: 'a wooden gate with a latch and two hinges',
  states: [
    { id: 'ART001.1', name: 'intact', delta: 'the latch is a plain iron bar', description: 'a wooden gate with a plain iron bar latch and two hinges', removed: [], pages: [1] },
    { id: 'ART001.2', name: 'broken', delta: 'the latch is snapped in two', description: 'a wooden gate with a snapped latch and two hinges', removed: ['the iron bar latch', 'the left hinge'], pages: [2] },
  ],
};
const oldShape = {
  ...withFields,
  states: withFields.states.map(({ description, removed, ...rest }) => rest),
};

describe('state cell uses its own full description', () => {
  it('uses state.description instead of base + delta, and carries removed', () => {
    const cells = RS.expandElementStateCells(withFields);
    expect(cells[1].description).toBe('a wooden gate with a snapped latch and two hinges');
    expect(cells[1].description).not.toContain('plain iron bar');
    expect(cells[1].removed).toEqual(['the iron bar latch', 'the left hinge']);
    expect(cells[0].removed).toEqual([]);
  });

  it('the sheet prompt emits the removed line from the array only', () => {
    const cells = RS.expandElementStateCells(withFields);
    const p = RS.buildReferenceSheetPrompt(cells, 'watercolor');
    expect(p).toContain('Not in this picture: the iron bar latch, the left hinge.');
    const lines = p.split(/\n/);
    expect(lines.filter(l => l.includes('plain iron bar latch')).every(l => !l.includes('Not in this picture'))).toBe(true);
    expect(lines.filter(l => l.includes('a snapped latch')).every(l => l.includes('Not in this picture'))).toBe(true);
    expect(RS.stateCellsGatePrompt(withFields, cells)).toContain('Not in this picture: the iron bar latch, the left hinge.');
  });

  it('an old-shape state keeps base + delta (stored-data constraint)', () => {
    const cells = RS.expandElementStateCells(oldShape);
    expect(cells[1].description).toBe('a wooden gate with a latch and two hinges, the latch is snapped in two');
    expect(cells[1].removed).toEqual([]);
    expect(RS.buildReferenceSheetPrompt(cells, 'watercolor')).not.toContain('Not in this picture');
  });
});

describe('the parser keeps the new fields', () => {
  it('normaliseObjectStates keeps description and removed, cleans junk, nulls absent', () => {
    const out = VB.normaliseObjectStates([
      { name: 'a', delta: 'x', description: '  full one ', removed: [' the door ', '', null, 3], pages: [1] },
      { name: 'b', delta: 'y', pages: [2] },
    ], 'ART003');
    expect(out[0].description).toBe('full one');
    expect(out[0].removed).toEqual(['the door', '3']);
    expect(out[1].description).toBeNull();
    expect(out[1].removed).toEqual([]);
  });

  it('the live full-story parse path (outlineParser/unified) goes through normaliseObjectStates', () => {
    const src = require('node:fs').readFileSync(require.resolve('../../server/lib/outlineParser/unified.js'), 'utf8');
    expect(src).toMatch(/out\.states = normaliseObjectStates\(entry\.states, entry\.id\)/);
  });
});

describe('both VB writers emit both fields', () => {
  it('the rule is generic and reaches the full and the trial writer prompts', () => {
    expect(PB.STATE_FULL_DESCRIPTION_RULE).not.toMatch(/cart|drawbar|branch|rope|Derin/i);
    for (const p of [PB.buildVisualBibleCallPrompt(input(), beats, { maxCharactersPerScene: 6, finalArc: '1.' }), PB.buildTrialArcPrompt(input(), 4)]) {
      expect(p).toContain(PB.STATE_FULL_DESCRIPTION_RULE);
      expect(p).not.toContain('{STATE_FULL_DESCRIPTION}');
      expect(p).toContain('\\"removed\\": [');
      expect(p).toContain('\\"description\\": \\"[the whole object in this look');
    }
  });
});
