import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// THE PRESERVE CHANNEL (2026-09-19).
//
// Measured on job_1789759147125_p08djwhbl p5: every attempt to shrink the
// oversized egg stranded the four boys' hands where the larger egg had been.
// The consolidator DRAFTED the combined instruction — "Redraw the egg at
// child's-head size and move all four boys' hands with it" — and collapsed it
// to "Resize the dragon egg to the size of a child's head", logging the other
// half in dropped_issues as "a constraint, not an action". So the interaction
// clause never reached the image model, and the combined arm and the
// object-only arm were byte-identical through inpaintPage.
//
// scene_fix.preserve already existed for exactly this — produced by the
// consolidator, seeded with landmark names, sanitized — and nothing read it.
// These tests pin the wire: the clause is built, it is capped, and it is
// appended to the instruction the image model receives.

// @ts-expect-error - JS module without types
import { buildPreserveClause, PRESERVE_MAX } from '../../server/lib/repairLogic.js';

describe('buildPreserveClause', () => {
  it("carries the page's declared interaction to the image model", () => {
    const out = buildPreserveClause(["the four boys' hands rest on the shell"]);
    expect(out).toContain('Still true after the edit');
    expect(out).toContain("the four boys' hands rest on the shell");
    // Its own sentence AFTER the numbered actions, never merged into one.
    expect(out.slice(0, 2)).toBe(String.fromCharCode(10, 10));
  });

  it('is empty when there is nothing to preserve', () => {
    expect(buildPreserveClause([])).toBe('');
    expect(buildPreserveClause(null)).toBe('');
    expect(buildPreserveClause(['', '   '])).toBe('');
  });

  it('stays narrow: caps the list and drops duplicates', () => {
    const out = buildPreserveClause(['one', 'ONE', 'two', 'three', 'fourth-item', 'fifth-item']);
    expect(out.split(';')).toHaveLength(PRESERVE_MAX);
    expect(out).not.toContain('fourth-item');
  });

  it("does not leave stray punctuation from the plan's wording", () => {
    expect(buildPreserveClause(['the hands rest on the shell.'])).toContain('shell.');
    expect(buildPreserveClause(['the hands rest on the shell.'])).not.toContain('shell..');
  });
});

// The payload the image call actually receives. Mirrors the assembly in
// images.js inpaintPage: numbered actions, then the preserve clause, then the
// quiet zone. Pins that the clause is present and that it follows the actions.
describe('the inpaint payload', () => {
  const buildFullInstruction = (editInstruction: string, preserveClause: string, quietZoneSuffix = '') =>
    `Fix these issues in this children's book illustration:\n${editInstruction}${preserveClause}${quietZoneSuffix}`;

  it('reaches Grok with the interaction the shrink would otherwise strand', () => {
    const plan = {
      scene_fix: {
        instruction: "Resize the dragon egg to the size of a child's head.",
        preserve: ["the four boys' hands rest on the shell"],
      },
    };
    const full = buildFullInstruction(
      `1. ${plan.scene_fix.instruction}`,
      buildPreserveClause(plan.scene_fix.preserve),
    );
    expect(full).toContain('Resize the dragon egg');
    expect(full).toContain("the four boys' hands rest on the shell");
    // Order matters: the action leads, the constraint follows it.
    expect(full.indexOf('Resize')).toBeLessThan(full.indexOf('Still true'));
  });

  it('is byte-identical to the old payload when preserve is empty', () => {
    const before = buildFullInstruction('1. Open the eyes wide.', '');
    const after = buildFullInstruction('1. Open the eyes wide.', buildPreserveClause([]));
    expect(after).toBe(before);
  });
});

// The mirror above is only worth what its fidelity to inpaintPage is worth, so
// pin the real assembly by source: images.js must read scene_fix.preserve and
// must interpolate the clause into the string handed to the image model.
// images.js is not imported here — it pulls the whole image stack.
describe('images.js inpaintPage wiring', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../../server/lib/images.js', import.meta.url)), 'utf8');

  it('reads scene_fix.preserve', () => {
    expect(src).toContain('scene_fix?.preserve');
    expect(src).toContain('buildPreserveClause');
  });

  it('interpolates the clause into the instruction the image model receives', () => {
    const line = src.split(String.fromCharCode(10)).find(l => l.includes('const fullInstruction ='));
    expect(line).toBeDefined();
    expect(line).toContain('${preserveClause}');
  });
});
