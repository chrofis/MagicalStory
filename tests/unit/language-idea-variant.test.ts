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
    expect(de).toContain('"Rüebli"');
    expect(de).toContain('CORRECT:');
    expect(de).toContain('WRONG:');

    const fr = getLanguageInstruction('fr', { variant: 'idea' });
    expect(fr).toContain('You MUST write your response in French');
    expect(fr).toContain('septante');
  });

  it('a language with no typography clause is only shortened by the hygiene rule', () => {
    expect(getLanguageInstruction('en', { variant: 'idea' })).toBe(LANGUAGES.en.instruction);
  });
});
