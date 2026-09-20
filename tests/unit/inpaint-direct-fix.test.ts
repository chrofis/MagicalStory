import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ONE CLEAN FINDING NEEDS NO CONSOLIDATION (owner, 2026-09-20).
//
// Measured on job_1789853503332_riqncqg1i p13/p14. The object-scale check
// produced one finding per page, already phrased as an instruction and already
// free of character names. It still went through the consolidator, whose
// fix-instruction shape rules ("≤10 words", "no adverbs", "flag every
// prepositional phrase that doesn't carry a fact") trimmed
//
//   "…drawn too large — it should be about as big as a human head…
//    Draw it smaller, matching the nearer boy's head in size…"   (49 words)
//
// down to
//
//   "Resize the egg to match the size of the boy in the right foreground."
//
// Two separate losses. The direction word "smaller" was cut as redundancy, and
// the referent moved from a head to a whole child. A target with no direction
// reads as already satisfied: p13 came back 0.64 → 0.58 (wrong way) and p14
// 1.29 → 1.52 (inverted). Neither the dedupe, the per-character split, the
// name strip nor the cap-at-3 had anything to do on a single clean finding.
//
// These tests pin both halves of the fix: the code path that sends such a
// finding verbatim, and the prompt rule that protects the direction word when
// the consolidator DOES run.

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('inpaintPage: a lone name-free instruction skips consolidation', () => {
  const src = read('../../server/lib/images.js');

  it('gates the shortcut on exactly one issue that carries its own fix', () => {
    expect(src).toContain('const soleDirectFix = (() => {');
    expect(src).toContain('if (inpaintableIssues.length !== 1) return null;');
    // A diagnosis is not an instruction — no fix text, no shortcut.
    expect(src).toMatch(/if \(!fix\) return null;/);
  });

  it('refuses the shortcut when a character name is present', () => {
    // Rule 3 is the consolidator's to enforce. A name means it has real work.
    expect(src).toContain('if (stripCharacterNames(fix, { names }) !== fix) return null;');
  });

  it('sends that finding verbatim — no trim, no cap, no critique', () => {
    expect(src).toContain('editInstruction = `1. ${sanitizeIssueForInpaint(soleDirectFix)}`;');
    // It must be the FIRST branch, ahead of the consolidated-plan branch.
    const direct = src.indexOf('if (soleDirectFix) {\n    // Verbatim.');
    const plan = src.indexOf('} else if (consolidation?.plan && !consolidation.error) {');
    expect(direct).toBeGreaterThan(-1);
    expect(plan).toBeGreaterThan(direct);
  });

  it('does not spend a consolidator call when it has nothing to consolidate', () => {
    const gate = src.indexOf('let consolidation = null;');
    const call = src.indexOf('consolidation = await consolidateFeedback({');
    expect(gate).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(gate);
    // The call sits inside the else of the soleDirectFix gate.
    expect(src.slice(gate, call)).toContain('if (soleDirectFix) {');
    expect(src.slice(gate, call)).toContain('} else {');
  });
});

describe('the consolidator prompt protects the direction word', () => {
  const prompt = read('../../prompts/feedback-consolidator.txt');

  it('names direction words as the defect, not as adverbs to strip', () => {
    expect(prompt).toContain('A direction word is the defect');
    for (const w of ['larger', 'smaller', 'closer', 'farther', 'fewer']) {
      expect(prompt).toContain('`' + w + '`');
    }
  });

  it('states why a target without a direction is not executable', () => {
    expect(prompt).toMatch(/no direction is not executable/);
    expect(prompt).toMatch(/reads it as already satisfied/);
  });

  it('exempts them from the no-adverbs rule explicitly', () => {
    // Rule 4 is "No adverbs" — rule 9 must say it does not reach these.
    expect(prompt).toMatch(/Rule 4 does not touch them/);
  });

  it('carries a worked example that keeps the direction word in final', () => {
    // The example's Final line must still contain the direction word.
    const finals = prompt.match(/^Final: `"[^"]+"`$/gm) || [];
    expect(finals.some(f => /smaller/.test(f))).toBe(true);
  });

  it('keeps the examples generic — no story-specific props', () => {
    const shape = prompt.slice(prompt.indexOf('## Fix-instruction shape'));
    expect(shape).not.toMatch(/\begg\b/i);
    expect(shape).not.toMatch(/\bdragon\b/i);
  });
});
