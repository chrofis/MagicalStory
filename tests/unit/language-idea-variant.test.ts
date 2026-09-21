import { describe, it, expect } from 'vitest';
import path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const { getLanguageInstruction, LANGUAGES, QUOTE_HYGIENE_RULE } = require(path.join(ROOT, 'server/lib/languages'));

const CODES = Object.keys(LANGUAGES);

describe('getLanguageInstruction variants', () => {
  it('the story variant is unchanged for every language', () => {
    for (const code of CODES) {
      expect(getLanguageInstruction(code), code).toBe(LANGUAGES[code].instruction + QUOTE_HYGIENE_RULE);
      expect(getLanguageInstruction(code, {}), code).toBe(LANGUAGES[code].instruction + QUOTE_HYGIENE_RULE);
    }
  });

  it('the idea variant carries no dialogue typography', () => {
    for (const code of CODES) {
      const idea = getLanguageInstruction(code, { variant: 'idea' });
      expect(idea, code).not.toMatch(/[«»—]/);
      expect(idea, code).not.toContain('DIALOGUE TYPOGRAPHY');
      expect(idea, code).not.toContain('guillemet');
      expect(idea, code).not.toContain('em-dash');
      expect(idea, code).not.toContain(QUOTE_HYGIENE_RULE.trim());
    }
  });

  it('the idea variant keeps the language and the Swiss spelling rules', () => {
    const de = getLanguageInstruction('de', { variant: 'idea' });
    expect(de).toContain('You MUST write your response in German');
    expect(de).toContain('Use ä, ö, ü');
    expect(de).toContain('always use "ss" instead');
    expect(de).toContain('More formal register');

    const fr = getLanguageInstruction('fr', { variant: 'idea' });
    expect(fr).toContain('You MUST write your response in French');
    expect(fr).toContain('septante');
  });

  // Owner, 2026-09-21: round 19 produced «Rüeblinebel» in an idea with no
  // vegetable in it, because the regional vocabulary list was in front of the
  // model. The idea variant drops the list and the CORRECT/WRONG examples that
  // restate it; the spelling and register rules are what an idea needs.
  it('the idea variant carries no regional vocabulary list', () => {
    for (const code of CODES) {
      const idea = getLanguageInstruction(code, { variant: 'idea' });
      expect(idea, code).not.toMatch(/CORRECT:|WRONG:/);
      expect(idea, code).not.toMatch(/Use (Swiss|Austrian|southern|northern|British|American|Belgian|Quebec|standard) vocabulary:/);
    }
    const de = getLanguageInstruction('de-ch', { variant: 'idea' });
    for (const item of ['Bub', 'Kappe', 'Rüebli', 'Velo', 'Poulet', 'Glace', 'Znüni', 'Natel', 'Trottoir', 'Lavabo', 'grillieren', 'parkieren']) {
      expect(de, item).not.toContain(item);
    }
  });

  it('the idea variant keeps the numbered rules gapless', () => {
    for (const code of CODES) {
      const idea = getLanguageInstruction(code, { variant: 'idea' });
      const markers = [...idea.matchAll(/(?:^|[.:]\s+)\((\d+)\)\s/g)].map(m => Number(m[1]));
      expect(markers, code).toEqual(markers.map((_, i) => i + 1));
    }
  });

  it('a language with no typography clause keeps its spelling rules and loses its vocabulary', () => {
    const en = getLanguageInstruction('en', { variant: 'idea' });
    expect(en).toContain('Use British spelling');
    expect(en).toContain('Date format: day-month-year');
    expect(en).not.toContain('British vocabulary');
    expect(en).not.toContain('CORRECT:');
    expect(LANGUAGES.en.instruction).toContain('British vocabulary');
  });
});
