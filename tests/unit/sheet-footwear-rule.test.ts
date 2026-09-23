/**
 * Every character-reference-sheet generation prompt states that the figure is
 * shod.
 *
 * Evidence: staging job_1789296188291_thezv15y1. The main character rendered
 * barefoot on all six pages AND both covers. Tracing the chain: his body
 * reference photo wears trainers, but the pass-1 identity sheet came back
 * barefoot in all four body cells, the style-transfer pass copied that, and the
 * styled sheet is the per-page reference cell — so every page faithfully drew
 * bare feet on an autumn outdoor story.
 *
 * Nothing upstream could have caught it. A trial character's `standard` clothing
 * entry carries `signature: 'none'` and no description by design (the body photo
 * IS the reference), so no clothing text reaches the sheet prompt or the page
 * prompts. And every mention of shoes in the sheet prompts and their evaluators
 * was a FRAMING rule — "both feet with shoes are fully visible inside the cell",
 * "cropped at the ankle scores 1-3" — which a barefoot figure satisfies.
 *
 * This pins the requirement itself, not its wording: each generation prompt must
 * say the figure wears footwear, and must keep the tail/fin exception so a
 * character with no feet is not given shoes.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const sheet = require('../../server/lib/character2x4Sheet');
const { buildBodyRowPrompt, buildFootwearRule } = sheet._internal;

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

// A rule "states the figure is shod" when it names footwear as worn — not merely
// as a thing that must be visible inside the cell.
const requiresFootwear = (t: string) => /Footwear is part of the (outfit|costume)/.test(t);
const keepsNoFeetException = (t: string) => /tail, fin, or single fused form with no feet at all/.test(t);

describe('reference-sheet prompts require footwear', () => {
  it('the body-row prompt (split path) requires it and keeps the no-feet exception', () => {
    const p = buildBodyRowPrompt('standard outfit', { name: 'A', physical: {} }, false, null);
    expect(requiresFootwear(p)).toBe(true);
    expect(keepsNoFeetException(p)).toBe(true);
    // The carry-over source is the body reference, so an outfit with no text
    // description still lands shod.
    expect(p).toMatch(/the footwear the body reference shows/);
  });

  it('a redress sheet takes footwear from the costume, never from the wrong-outfit reference', () => {
    const p = buildBodyRowPrompt('a long green coat', { name: 'A', physical: {} }, true, 'forest ranger');
    expect(requiresFootwear(p)).toBe(true);
    expect(p).toMatch(/never the footwear in the body reference/);
    // The non-redress "copy the reference" clause must NOT appear — the
    // reference is the outfit we are replacing.
    expect(p).not.toMatch(/the footwear the body reference shows/);
  });

  it('the styled 2x4 template carries the rule too', () => {
    const t = read('prompts/styled-costumed-avatar-2x4.txt');
    expect(requiresFootwear(t)).toBe(true);
    expect(keepsNoFeetException(t)).toBe(true);
  });

  it('the rule is stated once in code and shared by both JS builders', () => {
    const plain = buildFootwearRule(false);
    const redress = buildFootwearRule(true);
    expect(plain).not.toEqual(redress);
    expect(buildBodyRowPrompt('standard outfit', null, false, null)).toContain(plain);
    expect(buildBodyRowPrompt('standard outfit', null, true, null)).toContain(redress);
  });

  it('stays generic — no story specifics leak into the rule', () => {
    for (const t of [buildFootwearRule(false), buildFootwearRule(true), read('prompts/styled-costumed-avatar-2x4.txt')]) {
      expect(t).not.toMatch(/Omar|chestnut|hedgehog|Rohrdorf/i);
    }
  });
});
