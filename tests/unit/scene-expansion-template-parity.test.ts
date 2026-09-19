import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const PER_PAGE = path.join(ROOT, 'prompts/scene-expansion.txt');
const ALL_PAGES = path.join(ROOT, 'prompts/scene-expansion-all.txt');

const FENCE = /^```[a-z]*\r?\n([\s\S]*?)^```/gm;

/** Top-level keys of the single-line JSON metadata example in an AD template. */
function metadataKeys(file: string): string[] {
  const text = fs.readFileSync(file, 'utf8');
  const fences = [...text.matchAll(FENCE)].map((m) => m[1]);
  const block = fences.find((b) => b.includes('"sceneIntent"'));
  expect(block, `${path.basename(file)} has a fenced metadata example`).toBeTruthy();
  const keys = new Set<string>();
  for (const line of (block as string).split('\n')) {
    const m = line.match(/^ {2}"([A-Za-z0-9_]+)":/); // two-space indent = top level
    if (m) keys.add(m[1]);
  }
  return [...keys].sort();
}

describe('Art Director template parity', () => {
  it('both templates declare the same metadata schema keys', () => {
    expect(metadataKeys(ALL_PAGES)).toEqual(metadataKeys(PER_PAGE));
  });

  // The per-page template is the beats fallback (beatsPipeline expandOnePage
  // gap-fill and the all-pages fallback), so a rule that reaches only the
  // all-pages template silently stops applying on the pages that fall back.
  const SHARED_RULES = [
    '- A NAME IS NOT A PRESENCE.',
    'An object WITH states is always cited dotted',
  ];
  for (const rule of SHARED_RULES) {
    it(`both templates carry: ${rule.slice(0, 48)}`, () => {
      for (const file of [PER_PAGE, ALL_PAGES]) {
        expect(fs.readFileSync(file, 'utf8').includes(rule), path.basename(file)).toBe(true);
      }
    });
  }

  // `crowdExpected` became the three-state `population` on 2026-09-19 — a
  // public square holds people who are neither cast nor a crowd, and the
  // boolean had no way to say so. The parity requirement is unchanged: the
  // field and its rule must exist in BOTH templates or the fallback path
  // silently reads the page as cast-only.
  it('population is declared and ruled in both templates, with all three values', () => {
    for (const file of [PER_PAGE, ALL_PAGES]) {
      const text = fs.readFileSync(file, 'utf8');
      expect(metadataKeys(file), path.basename(file)).toContain('population');
      // A rule line, not just the schema example.
      expect(
        /^- `population`/m.test(text),
        `${path.basename(file)} states a population rule`
      ).toBe(true);
      for (const value of ['"crowd"', '"ambient"', '"cast_only"']) {
        expect(text.includes(value), `${path.basename(file)} names ${value}`).toBe(true);
      }
      // The prose must never assert a populated place is empty — that claim is
      // what the judge was holding correct pictures to.
      expect(text).toContain('no other people are present');
    }
  });
});
