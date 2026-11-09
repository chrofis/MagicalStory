/**
 * Prod job_1794231161354_l3n2o3afm (2026-11-09): "three monsters" became Grumbo / Plodd / Squelch in three colours
 * because the bible schema forced a proper name on every animal; the Jev citation question asked about "Grumbo"
 * (never on a page) and scored 0.22-0.47 against the bar 0.7. Owner design: ONE `name` (the story's name, else the
 * English role noun); a group the story never tells apart is ONE entry with `count`. docs/decisions.md 2026-11-09.
 */
import { describe, it, beforeAll, expect } from 'vitest';
import fs from 'fs';

const CR = require('../../server/lib/castResolver');
const PB = require('../../server/lib/promptBuilders');
const VB = require('../../server/lib/visualBible');
const JD = require('../../server/lib/jevDecisions');
const EP = require('../../server/lib/evalPipeline');
const SC = require('../../server/lib/sceneMetadata');
const { loadPromptTemplates, buildEvaluationPrompt } = require('../../server/services/prompts');

beforeAll(async () => { await loadPromptTemplates(); });

describe('canonicalName tolerates an article and a plural', () => {
  it('"the bog monsters" and "bog monster" compare equal', () => {
    expect(CR.canonicalName('The bog monsters')).toBe(CR.canonicalName('bog monster'));
    expect(CR.canonicalName('a guard')).toBe(CR.canonicalName('Guards'));
    expect(CR.canonicalName('Die Wächter')).toBe(CR.canonicalName('wachter'));
  });
  it('a proper name that merely ends in s is not singularised, and two distinct names stay distinct', () => {
    expect(CR.canonicalName('Lucas')).toBe('lucas');
    expect(CR.canonicalName('Thomas')).toBe('thomas');
    expect(CR.canonicalName('Mother')).not.toBe(CR.canonicalName('Mother Dragon'));
  });
  it('a lone article-like word is kept (nothing left to compare)', () => {
    expect(CR.canonicalName('The')).toBe('the');
    expect(CR.canonicalName('')).toBe('');
  });
  it('a role noun is found in the plural in text, a proper name is not', () => {
    expect(CR.isNameMentioned('Three bog monsters stomped in.', 'bog monster')).toBe(true);
    expect(CR.isNameMentioned('Anna came.', 'Ann')).toBe(false);
  });
});

describe('every name-match site accepts the role noun with an article and in the plural', () => {
  const vb = {
    animals: [{ id: 'ANI001', name: 'bog monster', count: 3, species: 'bog monster', description: 'green, hunched, mossy' }],
    secondaryCharacters: [{ id: 'CHR001', name: 'shopkeeper' }],
  };
  it('findVbFigure (repairLogic) resolves "the bog monsters"', () => {
    const RL = require('../../server/lib/repairLogic');
    if (RL.findVbFigure) expect(RL.findVbFigure(vb, 'the bog monsters')).toBeTruthy();
  });
  it('entryMatchesCitation (page prompt REQUIRED OBJECTS walk) matches the plural with article', () => {
    expect(VB.entryMatchesCitation(vb.animals[0], 'the bog monsters')).toBe(true);
    expect(VB.entryMatchesCitation(vb.animals[0], 'ANI001.1')).toBe(true);
    expect(VB.entryMatchesCitation(vb.secondaryCharacters[0], 'the bog monsters', true)).toBe(false);
  });
  it('collectSceneObjectFigureNames files "the bog monster" cited by name under the bible entry', () => {
    const names = SC.collectSceneObjectFigureNames({ objects: ['the bog monsters'] }, vb);
    expect(names).toEqual(['bog monster']);
  });
  it('collectSceneCharacterNames folds "the shopkeeper" and "shopkeeper" into one', () => {
    const out = SC.collectSceneCharacterNames({ characters: ['the shopkeeper', 'shopkeeper', 'Mia'] });
    expect(out).toHaveLength(2);
  });
  it('resolveEntity finds the entry whatever the spelling', () => {
    const idx = CR.buildCastIndex({ characters: [] }, vb);
    expect(CR.resolveEntity('the bog monsters', idx).id).toBe('ANI001');
  });
});

describe('the questions and labels read the role noun, a group says so', () => {
  const role = { type: 'creature', id: 'ANI001', name: 'bog monster', species: 'bog monster', count: 3, label: '', desc: 'green, hunched' };
  const named = { type: 'creature', id: 'ANI002', name: 'Bello', species: 'dog', desc: 'brown' };
  it('a role name reads "the bog monster", never "X, the X"', () => {
    const q = JD.vbQuestion({ ...role, count: undefined });
    expect(q).toMatch(/^the bog monster \(green/);
    expect(q).not.toMatch(/the bog monster, the bog monster/);
  });
  it('a group says how many and that they are alike', () => {
    expect(JD.vbQuestion(role)).toMatch(/the bog monster \(3 of them, all alike\)/);
    expect(JD.stateQuestion(role)).toMatch(/does the bog monster \(3 of them, all alike\) show/);
    expect(JD.rideQuestion(role)).toMatch(/ride on the bog monster \(3 of them/);
  });
  it('a story name keeps its species', () => {
    expect(JD.vbQuestion(named)).toMatch(/^Bello, the dog \(brown\)/);
  });
  it('gazeIndex carries count for a group and only then', () => {
    const idx = JD.gazeIndex({ animals: [{ id: 'ANI001', name: 'bog monster', count: 3, description: 'x' }, { id: 'ANI002', name: 'Bello', description: 'y' }] });
    expect(idx.ANI001.count).toBe(3);
    expect('count' in idx.ANI002).toBe(false);
  });
});

describe('the parse keeps count, only from 2 up', () => {
  it('normaliseCount', () => {
    expect(VB.normaliseCount(3)).toBe(3);
    expect(VB.normaliseCount('2')).toBe(2);
    expect(VB.normaliseCount(1)).toBeUndefined();
    expect(VB.normaliseCount(undefined)).toBeUndefined();
    expect(VB.normaliseCount('many')).toBeUndefined();
    expect(VB.normaliseCount(2.5)).toBeUndefined();
  });
  it('the bible parse copies count onto an animal and a secondary character, and omits it otherwise', () => {
    const json = {
      animals: [{ id: 'ANI001', name: 'bog monster', count: 3, pages: [1], scaleClass: 'person', species: 'monster' }, { id: 'ANI002', name: 'Bello', pages: [1], scaleClass: 'person', species: 'dog' }],
      secondaryCharacters: [{ id: 'CHR001', name: 'guard', count: 2, pages: [1], scaleClass: 'person' }],
    };
    const { UnifiedStoryParser } = require('../../server/lib/outlineParser/unified');
    const text = `---STORY ARC---\nPAGE 1: x | WITH: a | STATE: none\n\n---TITLE---\nTITLE: T\n\n---VISUAL BIBLE---\n\`\`\`json\n${JSON.stringify(json)}\n\`\`\`\n`;
    const parsed = new UnifiedStoryParser(text, { isTrial: true }).extractVisualBible();
    expect(parsed.animals[0].count).toBe(3);
    expect('count' in parsed.animals[1]).toBe(false);
    expect(parsed.secondaryCharacters[0].count).toBe(2);
  });
});

describe('the writers are told the rule through ONE constant', () => {
  it('both templates carry the placeholder and both built prompts the sentence; no test-story word', () => {
    const rule = PB.VB_FIGURE_NAME_RULE;
    expect(rule).toMatch(/role in English/);
    expect(rule).toMatch(/`count`/);
    expect(rule).not.toMatch(/Grumbo|Plodd|Squelch|monster\b.*Tell/);
    for (const f of ['prompts/visual-bible.txt', 'prompts/story-trial-arc.txt']) {
      const t = fs.readFileSync(f, 'utf8');
      expect(t).toContain('{VB_FIGURE_NAME}');
      expect(t).not.toMatch(/"id": "(?:CHR|ANI)001",\s*"name": "\[Name\]"/);
      expect(t).toMatch(/"count"/);
    }
    const input = { pages: 4, season: 'autumn', language: 'en', storyDetails: 'x', characters: [{ id: 'a', name: 'Levin', age: 5, isMainCharacter: true }], mainCharacters: ['a'], storyCategory: 'adventure', storyType: 'adventure', artStyle: 'watercolor', languageLevel: 'standard' };
    const trial = PB.buildTrialArcPrompt(input, 6);
    expect(trial).toContain(rule);
    expect(trial).not.toContain('{VB_FIGURE_NAME}');
    const beats = [{ pageNumber: 1, planLine: 'medium — Levin — waits — nothing', fixed: { timeOfDay: 'dusk', indoor: false } }];
    const full = PB.buildVisualBibleCallPrompt(input, beats, { maxCharactersPerScene: 6, finalArc: '1.' });
    expect(full).toContain(rule);
    expect(full).not.toContain('{VB_FIGURE_NAME}');
  });
});

describe('the page and its critic agree on a group', () => {
  const vb = { animals: [{ id: 'ANI001', name: 'bog monster', count: 3 }], secondaryCharacters: [{ id: 'CHR001', name: 'guard', count: 2 }, { id: 'CHR002', name: 'cook' }] };
  it('pageGroups lists a counted group the brief cites by id or by name, not an uncounted figure', () => {
    expect(PB.pageGroups({ objects: ['ANI001'] }, vb)).toEqual([{ name: 'bog monster', count: 3 }]);
    expect(PB.pageGroups({ objects: [], characters: ['the guards', 'cook'] }, vb)).toEqual([{ name: 'guard', count: 2 }]);
    expect(PB.pageGroups({ objects: [] }, vb)).toEqual([]);
  });
  it('REQUIRED CAST carries the exception and the shared sentence only when a group is on the page', () => {
    const none = PB.buildRequiredCastRule('cast_only', []);
    expect(none).not.toMatch(/except/);
    expect(none).not.toContain(PB.GROUP_ALIKE_RULE);
    const one = PB.buildRequiredCastRule('cast_only', [{ name: 'bog monster', count: 3 }]);
    expect(one).toMatch(/exactly one of each, except the bog monster \(a group: exactly 3 members, all alike\)/);
    expect(one).toContain(PB.GROUP_ALIKE_RULE);
  });
  it('the quality judge reads the same sentence, so N alike members are never a duplicate_character', () => {
    const t = buildEvaluationPrompt({ originalPrompt: 'x' });
    expect(t).toContain(PB.GROUP_ALIKE_RULE);
    expect(t).toMatch(/never a D-03 duplicate/);
    expect(t).not.toContain('{GROUP_ALIKE}');
  });
  it('the EXPECTED CAST line tells the judge the number, and the people count counts the members', () => {
    const cast = EP.buildExpectedCastBlock({ sceneCharacters: ['Mia'], visualBible: { secondaryCharacters: [{ id: 'CHR001', name: 'guard', count: 2, pages: [1] }], animals: [] }, sceneMetadata: { objects: ['CHR001'], characters: [{ name: 'Mia' }] }, pageNumber: 1 });
    expect(cast.block).toMatch(/guard \(secondary character\) x2, one group of 2 alike members/);
    expect(cast.groups).toEqual({ guard: 2 });
    expect(EP.castPeopleCount(cast)).toBe(3);
  });
});
