/**
 * Owner decision 2026-10-08 ("drop the left right"): the side of a hair parting is never written into
 * hair text and never judged (staging Lukas: text "side part right", judge "parting is left, requested
 * right" on profile and rear cells, hair score 1). docs/decisions.md "Parting side is not recorded".
 */
import { describe, it, expect, beforeAll } from 'vitest';

const fs = require('fs');
const path = require('path');
const { loadPromptTemplates, PROMPT_TEMPLATES } = require('../../server/services/prompts');
const { buildHairDescription, partingWord } = require('../../server/lib/promptBuilders');
const { _internal } = require('../../server/lib/character2x4Sheet');

beforeAll(async () => { await loadPromptTemplates(); });

const prompt = (n: string) => fs.readFileSync(path.join(__dirname, '../../prompts', n), 'utf8');

describe('composed hair text carries no parting side', () => {
  const stored = (parting: string) => ({
    hairColor: 'brown',
    detailedHairAnalysis: { type: 'straight', lengthTop: 'short', styling: 'side-swept', parting },
  });
  it('a stored "side part right" / "side part left" trait becomes "side part"', () => {
    for (const p of ['side part right', 'side part left']) {
      const t = buildHairDescription(stored(p));
      expect(t).toMatch(/side part/);
      expect(t).not.toMatch(/\b(left|right)\b/i);
    }
  });
  it('center part stays, none and legacy non-enum values give no parting', () => {
    expect(buildHairDescription(stored('center part'))).toMatch(/center part/);
    expect(buildHairDescription(stored('none'))).not.toMatch(/part/);
    expect(partingWord('left')).toBe('');
    expect(partingWord('natural')).toBe('');
    expect(partingWord(undefined)).toBe('');
  });
  it('a user override with a side is neutralised the same way', () => {
    const c = { ...stored('none'), userHairOverride: { parting: 'side part left' } };
    expect(buildHairDescription(c)).not.toMatch(/\b(left|right)\b/i);
  });
  it('the sheet prompt / judge request (hairRequest) has no side either', () => {
    const c = { physical: { hairColor: 'brown', detailedHairAnalysis: { type: 'straight', parting: 'side part right' } } };
    const t = _internal.hairRequest(c);
    expect(t).toMatch(/side part/);
    expect(t).not.toMatch(/\b(left|right)\b/i);
  });
});

describe('extractor prompts never offer a parting side', () => {
  for (const f of ['avatar-hair-read.txt', 'avatar-evaluation.txt', 'character-analysis.txt']) {
    it(`${f} lists side part without left or right`, () => {
      const line = prompt(f).split('\n').find((l: string) => /parting/.test(l)) || '';
      expect(line).toMatch(/side part/);
      expect(line).not.toMatch(/side part (left|right)/);
      expect(line).toMatch(/never (say )?left or right/);
    });
  }
});

describe('judge prompts say the side is not checked', () => {
  it('page image evaluation', () => {
    expect(prompt('image-evaluation.txt')).toMatch(/which side a parting falls on is never checked/);
  });
});
