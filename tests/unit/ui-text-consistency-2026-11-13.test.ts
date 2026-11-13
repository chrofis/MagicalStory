/**
 * Customer-facing language consistency (language review 2026-11-13).
 * German is Swiss (ss, never ss-sharp) and addresses the customer with "du" everywhere,
 * the legal pages included. Gender is male or female only (docs/decisions.md 2026-11-13),
 * so an unset gender must never print as "Other".
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const read = (p: string) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');

/** The German block of a page that keeps its text as { en: {...}, de: {...}, fr: {...}, it: {...} }. */
function germanBlock(src: string): string {
  const start = src.indexOf('\n  de: {');
  const end = src.indexOf('\n  fr: {');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

const LEGAL_PAGES = ['client/src/pages/PrivacyPolicy.tsx', 'client/src/pages/TermsOfService.tsx'];

describe('German legal pages', () => {
  for (const page of LEGAL_PAGES) {
    const de = germanBlock(read(page));

    it(`${page}: no sharp s`, () => {
      expect(de).not.toMatch(/ß/);
    });

    it(`${page}: addresses the reader with du, never formal Sie/Ihr`, () => {
      // "Ihr..." / "Ihnen" with a capital are always the formal address.
      expect(de.match(/\bIhr\w*|\bIhnen\b/g) || []).toEqual([]);
      // "Sie" at a sentence or bullet start, or capitalised mid-sentence, is the formal address;
      // lower-case "sie" (they) is not matched.
      expect(de.match(/(?:^|[.!?:;•\n]\s*)Sie\b|[a-zäöü,)] Sie\b/g) || []).toEqual([]);
    });
  }
});

describe('CharacterForm gender summary', () => {
  it("no longer prints 'Andere' for a gender that is not male or female", () => {
    expect(read('client/src/components/character/CharacterForm.tsx')).not.toContain("'Andere'");
  });
});
