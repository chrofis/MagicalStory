import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * Depth is distance from the camera; a stated size wins over it. The scene
 * authors used to define `foreground` by how much of the frame height it fills
 * — the inverse of what the renderer is told — so a small foreground object
 * was written up into a frame-filling one.
 */
describe('depth is camera distance, on every path that defines it', () => {
  // The two unified writers were the only templates that ever defined `depth`
  // in their scene-hint schema, and both were deleted 2026-09-15 as
  // unreachable (docs/decisions.md). The beats Art Director does not restate
  // depth, so the only live statement of the rule is the render template
  // below — asserting it at the brief sites would assert a parity into
  // existence that has never held there.
  it('the render template states the rule', () => {
    expect(/Depth is distance from the camera, not size/.test(read('prompts/image-generation.txt'))).toBe(true);
  });
});

/**
 * shrinkPromptForModel (images.js) compresses the prompt HEAD and reattaches
 * everything from `**REQUIRED OBJECTS` / `**ART STYLE` onward verbatim. A rule
 * that must survive compression therefore lives in that tail, not above it.
 */
describe('must-survive render rules sit in the protected tail', () => {
  const tmpl = () => read('prompts/image-generation.txt');
  const tailStart = (t: string) => {
    const o = t.indexOf('{REQUIRED_OBJECTS}');
    return o >= 0 ? o : t.indexOf('**ART STYLE');
  };

  it('the depth/size rule is below the tail split', () => {
    const t = tmpl();
    expect(t.indexOf('Depth is distance from the camera')).toBeGreaterThan(tailStart(t));
  });

  it('the required-cast rule is below the tail split', () => {
    const t = tmpl();
    expect(t.indexOf('**REQUIRED CAST:')).toBeGreaterThan(tailStart(t));
  });
});
