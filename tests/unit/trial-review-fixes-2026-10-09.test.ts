// Fixes from the review of five staging trials (docs/decisions.md 2026-10-09).
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
const R = path.resolve(__dirname, '../..');
const read = (f: string) => fs.readFileSync(path.join(R, f), 'utf8');
const pb = require('../../server/lib/promptBuilders');
const { buildTextFromJson, stripEntityIds } = require('../../server/lib/sceneMetadata');
const { TRIAL_COSTUMES } = require('../../server/config/trialCostumes');

describe('trial writer prompt', () => {
  const tpl = read('prompts/story-trial-pages.txt');
  it('every foreground character gets an interactions row, so EXACT POSES is never empty', () => {
    expect(tpl).toContain('`interactions` is never empty on a page that has one');
    expect(tpl).toContain('`priority: "low"` row');
  });
  it('a creature has no written face', () => {
    expect(tpl).toContain("the look of a creature's eyes, gaze, mouth or beak");
    expect(pb.buildTrialPagesPrompt).toBeTypeOf('function');
  });
  it('page openings are capped by count, one constant for both writers', () => {
    expect(pb.PAGE_OPENING_VARIETY_RULE).toContain('at most one page in three begins with a character');
  });
});

describe('index qualifier never reaches an image prompt', () => {
  it('drops "(Stadt)" before a LOC tag in the Setting line', () => {
    // With a description the Setting line carries no place name (decisions.md 2026-10-09);
    // with none, the location stays, qualifier stripped.
    expect(buildTextFromJson({ setting: { location: 'Fislisbach (Stadt) [LOC002]', description: 'Wide meadow' } })).toBe('Setting: Wide meadow');
    expect(buildTextFromJson({ setting: { location: 'Fislisbach (Stadt) [LOC002]' } })).toBe('Setting: Fislisbach');
    expect(stripEntityIds('Kapellbrücke (Luzern) [LOC001.1]')).toBe('Kapellbrücke');
  });
  it('keeps a parenthesis that is not a location name qualifier', () => {
    expect(stripEntityIds('waves (slowly) at the dog')).toBe('waves (slowly) at the dog');
    expect(stripEntityIds('Garden [LOC001]')).toBe('Garden');
  });
});

describe('trial costumes carry explicit colours', () => {
  const colour = /\b(red|blue|green|yellow|white|black|brown|grey|gray|silver|gold|golden|pink|purple|navy|khaki|olive|tan|beige|lilac|orange|cream|pastel|bronze|rainbow|sea green)\b/i;
  it('the pirate shirt names both stripe colours (head row and body row must agree)', () => {
    expect(TRIAL_COSTUMES.adventure.pirate.male).toMatch(/red and white horizontal-striped/i);
    expect(TRIAL_COSTUMES.adventure.pirate.female).toMatch(/red and white horizontal-striped/i);
  });
  it('every adventure costume names a colour on its main garment and at least two colours in all', () => {
    const all = new RegExp(colour.source, 'gi');
    for (const [theme, byGender] of Object.entries<any>(TRIAL_COSTUMES.adventure)) {
      for (const [g, text] of Object.entries<string>(byGender)) {
        expect(String(text).split(',')[0], theme + '/' + g).toMatch(colour);
        expect((String(text).match(all) || []).length, theme + '/' + g).toBeGreaterThanOrEqual(2);
      }
    }
  });
});

describe('reference sheet: a held or attached object is drawn alone', () => {
  it('the template and the cell gate say so', () => {
    expect(read('prompts/reference-sheet.txt')).toContain('is drawn alone, lying or hanging by itself');
    expect(read('server/lib/referenceSheets.js')).toContain('is it the only thing in the cell');
  });
});
