/**
 * D20 — a creature's tone must reach the PAGE, not just the bible entry.
 *
 * job_1789147573901_m3uam0nxi p11: a commissioned pet dog was drawn snarling
 * with bared teeth in a book whose reader is 5. The tone level in force says
 * teeth are "not bared, raised or displayed" — and it applied: the level text
 * opens "Animals, creatures and non-human characters…", so the ticket's premise
 * (that a commissioned pet was out of scope) was wrong.
 *
 * What actually failed: {CREATURE_TONE} was injected into ONE template
 * (scene-expansion-all.txt), in the section that governs Visual Bible ENTRY
 * descriptions. An animal's entry description never reaches a page — the
 * REQUIRED OBJECTS block is name-only (2026-09-02 ruling) plus its size
 * (2026-09-11) — so the page's own prose is the only place a creature's face is
 * decided per page. p11's entire prose for the dog was "At the base of the
 * block, Nia digs vigorously at the dirt with her paws", and effort read as
 * teeth. The single-page template had no {CREATURE_TONE} at all.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// @ts-expect-error - JS module without types
import { buildCreatureToneSection } from '../../server/lib/promptBuilders.js';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const child = (age: string) => ({ characters: [{ name: 'A', age, isMain: true }] });

describe('the creature-tone block', () => {
  it('covers ANIMALS, not only creatures and non-human characters', () => {
    // The ticket claimed a commissioned pet was out of scope. It is not.
    expect(buildCreatureToneSection(child('5'))).toMatch(/^Animals, creatures and non-human characters/);
    expect(buildCreatureToneSection(child('3'))).toMatch(/^Animals, creatures and non-human characters/);
  });

  it('tells the AD to write the creature\'s face into the PAGE prose', () => {
    for (const age of ['3', '5', '9']) {
      const t = buildCreatureToneSection(child(age));
      expect(t).toMatch(/Where a creature is in frame, the page's own prose states its face and expression/);
      expect(t).toMatch(/a creature's entry does not travel to the page/);
    }
  });

  it('still emits NOTHING when the reader age cannot be read', () => {
    // Unchanged contract: never harden creatures in a story whose age is unknown.
    expect(buildCreatureToneSection({ characters: [{ name: 'A', isMain: true }] })).toBe('');
    expect(buildCreatureToneSection({})).toBe('');
  });

  it('keeps the age boundaries', () => {
    expect(buildCreatureToneSection(child('4'))).toMatch(/drawn cute/);
    expect(buildCreatureToneSection(child('6'))).toMatch(/open friendly face/);
    expect(buildCreatureToneSection(child('7'))).toMatch(/powerful, wild or formidable/);
  });
});

describe('both Art Director templates receive it', () => {
  for (const f of ['prompts/scene-expansion.txt', 'prompts/scene-expansion-all.txt']) {
    it(`${f} carries the {CREATURE_TONE} placeholder`, () => {
      expect(read(f)).toContain('{CREATURE_TONE}');
    });
  }

  it('the single-page builder fills it, not only the all-pages one', () => {
    // Matched on the CALL, not its argument: the two builders read the story
    // from different places (the all-pages one has `inputData`, the single-page
    // one has `options.story`), and pinning the argument text made this test
    // fail on a correct fix.
    const src = read('server/lib/promptBuilders.js');
    expect((src.match(/CREATURE_TONE: buildCreatureToneSection\(/g) || []).length).toBe(2);
  });
});
