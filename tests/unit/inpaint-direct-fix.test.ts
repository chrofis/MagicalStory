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
    // Cast AND bible-figure names, after figure ids resolve to them (2026-09-24).
    expect(src).toContain('if (stripCharacterNames(resolved, { names: repairNameMap.names }) !== resolved) return null;');
  });

  it('sends that finding verbatim — no trim, no cap, no critique', () => {
    expect(src).toContain('editInstruction = `1. ${sanitizeIssueForInpaint(soleDirectFix)}`;');
    // It must be the FIRST branch, ahead of the consolidated-plan branch.
    // CRLF-tolerant: the repo checks out with \r\n.
    const direct = src.search(/if \(soleDirectFix\) \{\r?\n\s*\/\/ Verbatim\./);
    const plan = src.indexOf('consolidatedPlan = consolidation.plan;');
    expect(direct).toBeGreaterThan(-1);
    expect(plan).toBeGreaterThan(direct);
  });

  it('does not spend a consolidator call when it has nothing to consolidate', () => {
    const gate = src.indexOf('let consolidation = null;');
    expect(gate).toBeGreaterThan(-1);
    // The soleDirectFix shortcut is the first branch of the decision.
    expect(src.slice(gate, gate + 400)).toContain('if (soleDirectFix) {');
  });
});

// ONE CONSOLIDATION PER EVALUATION (2026-09-21, finding B2).
//
// consolidatePageEval consolidates every evaluation when it lands and stores
// the plan on the version; inpaintPage then called the consolidator AGAIN on
// the same evaluation. Staging consolidator_calls rows for
// job_1789853503332_riqncqg1i show p10/p12/p15 consolidated at round 0 and
// again inside inpaint at round 1 — ~7k prompt tokens each — and the two plans
// disagree, so the page was repaired from a plan nothing had scored against.
describe('inpaintPage: the plan is an input, never recomputed', () => {
  const src = read('../../server/lib/images.js');
  const body = src.slice(src.indexOf('async function inpaintPage('),
                         src.indexOf('async function inpaintPage(') + 30000);

  it('never calls the consolidator itself', () => {
    expect(body).not.toContain('consolidateFeedback({');
  });

  it('takes the plan from the options or from the evaluation it was scored with', () => {
    expect(src).toContain('consolidatedPlan: consolidatedPlanIn = null,');
    expect(src).toContain('const storedPlan = consolidatedPlanIn || evaluation?.consolidatedPlan || null;');
  });

  it('stops loudly when there is no plan — no re-consolidation, no legacy concat', () => {
    expect(src).toContain("error: 'no consolidated plan on the evaluation'");
    // The severity-ranked concat fallback is gone.
    expect(src).not.toContain('fallback to top-');
  });

  it('the repair pipeline hands the stored plan to inpaint', () => {
    const rp = read('../../server/lib/repairPipeline.js');
    expect(rp).toContain('const planForInpaint = inpaintEval.consolidatedPlan');
    expect(rp).toContain('consolidatedPlan: planForInpaint,');
  });

  it('the one surviving consolidation carries the page wardrobe', () => {
    const rp = read('../../server/lib/repairPipeline.js');
    expect(rp).toContain('resolveSceneClothingDescriptions({');
    expect(rp).toContain('sceneClothing,');
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
