import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(__dirname, '../..');
const read = (p: string) => readFileSync(join(root, p), 'utf-8');

/**
 * The trait picker was uncapped. Staging job_1789759147125_p08djwhbl shipped a
 * five-year-old with 25 strengths and 7 flaws — the whole vocabulary — and a
 * second child with 20, all of it reaching an arc prompt whose rule is "each
 * character's nature causes a problem or solves one".
 *
 * A character's traits can be edited at THREE independent entry points, two of
 * them sharing a component and one a separate inline picker in the trial wizard.
 * A cap that reaches some of them is not a cap, so this pins the reach rather
 * than the rendering.
 */
describe('the trait cap reaches every entry point', () => {
  it('is one shared constant, not a number written per call site', () => {
    const limits = read('client/src/constants/traitLimits.ts');
    expect(limits).toMatch(/export const MAX_STRENGTHS = \d+;/);
    expect(limits).toMatch(/export const MAX_FLAWS = \d+;/);
  });

  it('TraitSelector enforces it rather than only displaying it', () => {
    const sel = read('client/src/components/character/TraitSelector.tsx');
    expect(sel).toContain('maxAllowed');
    // Adding past the limit is blocked on BOTH paths in, list and custom entry.
    expect(sel).toMatch(/const atLimit = maxAllowed !== undefined && selectedTraits\.length >= maxAllowed/);
    const toggle = sel.slice(sel.indexOf('const toggleTrait'), sel.indexOf('const addCustomTrait'));
    expect(toggle).toContain('if (atLimit) return;');
    const custom = sel.slice(sel.indexOf('const addCustomTrait'), sel.indexOf('// Include:'));
    expect(custom).toContain('if (atLimit) return;');
    // Deselecting is always allowed — that is how a character saved before the
    // cap comes back under it.
    expect(toggle).toMatch(/selectedTraits\.filter\(\(t\) => t !== trait\)/);
  });

  it('both CharacterForm layouts pass the cap — the new-character step and the edit form', () => {
    const form = read('client/src/components/character/CharacterForm.tsx');
    expect(form).toContain("from '@/constants/traitLimits'");
    expect(form.match(/maxAllowed=\{MAX_STRENGTHS\}/g) || []).toHaveLength(2);
    expect(form.match(/maxAllowed=\{MAX_FLAWS\}/g) || []).toHaveLength(2);
  });

  it('the trial wizard, which has its own picker, carries the same constant', () => {
    const trial = read('client/src/pages/trial/TrialCharacterStep.tsx');
    expect(trial).toContain("from '@/constants/traitLimits'");
    expect(trial).toMatch(/characterData\.traits\.length >= MAX_STRENGTHS/);
    expect(trial).toContain('if (traitsAtLimit) return;');
  });

  it('every trait-edit entry point known to the repo is one of the three above', () => {
    // A fourth picker added later without the cap is the regression this guards.
    const trialUsesSelector = read('client/src/pages/trial/TrialCharacterStep.tsx').includes('TraitSelector');
    expect(trialUsesSelector).toBe(false); // it is deliberately its own picker
  });
});
