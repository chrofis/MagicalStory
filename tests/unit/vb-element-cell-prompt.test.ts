/**
 * Visual Bible element cells: the kind sentence, the text sentence and the
 * cell-gate questions (server/lib/referenceSheets.js).
 *
 * Regression origin: staging story job_1789078732136_622wecmhj. The cell line
 * was the description alone — "an oval, slightly convex scale…" with no noun
 * naming what the object IS — and both scale artifacts rendered as ceramic
 * dishes. The noun goes back in as plain prose (owner, 2026-09-11): never a
 * heading, a bold line or a quoted title, which is what once got a name
 * painted onto a parchment. Entries with `text` quote the words in a sentence
 * and are the only cells allowed lettering.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

const cjs = createRequire(import.meta.url);
const {
  elementKindSentence,
  elementCellText,
  buildReferenceSheetPrompt,
  buildReferenceSheetBatches,
  expandElementStateCells,
  elementCellGatePrompt,
  stateCellsGatePrompt,
} = cjs('../../server/lib/referenceSheets.js');

const scale = {
  id: 'ART001',
  name: 'small dragon scale',
  type: 'single reptile scale',
  description: 'an oval, slightly convex scale about as wide as a child\'s palm; deep teal with a faint warm bronze sheen',
  pageCount: 5,
};
const ball = {
  id: 'ART003',
  name: "Julian's ball",
  type: 'rubber play ball',
  description: 'a round rubber ball about 20 cm in diameter; bright yellow with a single wide white band',
  states: [
    { id: 'ART003.1', name: 'in play', delta: 'surface clean and round', pages: [9] },
    { id: 'ART003.2', name: 'lost below', delta: 'resting among brown leaves', pages: [11] },
  ],
  pageCount: 3,
};
const sign = {
  id: 'ART005',
  name: 'trail sign (face to camera)',
  type: 'wooden trail fork sign, front face',
  description: 'a weathered pale brown plank 40 cm wide on a rough post; three small arrow shapes painted in faded dark brown',
  text: 'Windchopf',
  pageCount: 2,
};
const location = { id: 'LOC003', name: 'hillside cave entrance', type: 'location', description: 'outdoor, a dark cave mouth under a mossy rock lip', pageCount: 2 };
const character = { id: 'CHR001', name: 'Fenn', type: 'character', build: 'a dragon, broad-chested', description: 'a dragon, broad-chested and sturdy', pageCount: 4 };

describe('elementKindSentence — the noun as prose', () => {
  it('says what the object is from name and type, as a sentence', () => {
    expect(elementKindSentence(scale)).toBe('This is the small dragon scale, a single reptile scale: ');
  });
  it('keeps a possessive or capitalised name definite on its own', () => {
    expect(elementKindSentence(ball)).toBe("This is Julian's ball, a rubber play ball: ");
    expect(elementKindSentence({ ...scale, name: 'Nordwind', type: 'two-masted ship' })).toBe('This is Nordwind, a two-masted ship: ');
    // A multi-word name that merely starts with a proper noun keeps its article.
    expect(elementKindSentence({ ...scale, name: 'Windchopf sign', type: 'wooden trail sign' })).toBe('This is the Windchopf sign, a wooden trail sign: ');
  });
  it('drops a trailing parenthetical from the name and uses "an" before a vowel', () => {
    expect(elementKindSentence({ ...sign, text: null, type: 'oak plank sign' })).toBe('This is the trail sign, an oak plank sign: ');
  });
  it('ignores the pool label the sheet code stamps as type', () => {
    expect(elementKindSentence(location)).toBe('This is the hillside cave entrance: ');
  });
  it('leaves characters alone', () => {
    expect(elementKindSentence(character)).toBe('');
  });
  it('a state cell names the parent, not the identification suffix', () => {
    const cells = expandElementStateCells(ball);
    expect(cells).toHaveLength(2);
    expect(cells[0].name).toContain(' — in play');
    expect(elementKindSentence(cells[0])).toBe("This is Julian's ball, a rubber play ball: ");
    expect(cells[0].baseDescription).toBe(ball.description);
  });
});

describe('cell line shape — no heading, no bold, no quoted title', () => {
  it('is one prose line: sentence, then the description', () => {
    const line = elementCellText(scale);
    expect(line.startsWith('This is the small dragon scale, a single reptile scale: an oval')).toBe(true);
    expect(line).not.toMatch(/\*\*|^#|\n/);
    expect(line).not.toMatch(/["“”«]small dragon scale["“”»]/);
    expect(line).not.toMatch(/\(artifact\)|ART001/);
  });
  it('quotes the words for a text-bearing element, inside a sentence', () => {
    const line = elementCellText(sign);
    expect(line).toContain('painted in faded dark brown. It carries the words "Windchopf" in clear, legible lettering');
    expect(line).not.toMatch(/\*\*Windchopf\*\*|^Windchopf/);
  });
});

describe('buildReferenceSheetPrompt / batches with the new cells', () => {
  beforeAll(async () => {
    await cjs('../../server/services/prompts.js').loadPromptTemplates();
  });
  it('a multi-cell sheet carries the kind sentences and the blanket no-text rule', () => {
    const p = buildReferenceSheetPrompt([scale, { ...scale, id: 'ART002', name: 'large dragon scale' }], 'soft watercolor');
    expect(p).toContain('Row 1: This is the small dragon scale, a single reptile scale: ');
    expect(p).toContain('Row 2: This is the large dragon scale, a single reptile scale: ');
    expect(p).toContain('Zero text, zero labels');
    expect(p).not.toContain('{TEXT_RULE}');
  });
  it('a solo text cell swaps the no-text rule for the quoted-words-only rule', () => {
    const p = buildReferenceSheetPrompt([sign], 'soft watercolor');
    expect(p).toContain('the words "Windchopf"');
    expect(p).toContain('The only lettering anywhere in the image is the quoted words');
    expect(p).not.toContain('Zero text, zero labels');
    expect(p).not.toMatch(/^Row 1:/m);
  });
  it('an entry with text is quarantined into a solo batch', () => {
    const batches = buildReferenceSheetBatches([scale, sign, location], { artifacts: [], vehicles: [], clothing: [] }, 4);
    const solo = batches.find(b => b.length === 1 && b[0].id === 'ART005');
    expect(solo).toBeTruthy();
    expect(batches.some(b => b.length > 1 && b.some(e => e.id === 'ART005'))).toBe(false);
  });
});

describe('gate questions — classification lives in the prompt', () => {
  it('asks whether the cell reads as the entry\'s kind and quotes the description', () => {
    const q = elementCellGatePrompt(scale, 'soft watercolor');
    expect(q).toContain('meant to show a single reptile scale');
    expect(q).toContain(scale.description);
    expect(q).toContain('"soft watercolor"');
    expect(q).toContain('{"ok": true or false');
    expect(q).not.toContain('Lettering');
  });
  it('adds the lettering check only for a text-bearing element', () => {
    expect(elementCellGatePrompt(sign, 'x')).toContain('the words "Windchopf" are readable');
  });
  it('the state question lists every state in order and asks for one object', () => {
    const cells = expandElementStateCells(ball);
    const q = stateCellsGatePrompt({ ...cells[0], name: cells[0].displayName, description: cells[0].baseDescription }, cells);
    expect(q).toContain('2 cells');
    expect(q).toContain('1. in play: surface clean and round 2. lost below: resting among brown leaves');
    expect(q).toContain('same object in every cell');
    expect(q).toContain(ball.description);
  });
});
