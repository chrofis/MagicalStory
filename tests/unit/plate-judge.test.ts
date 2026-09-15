import { describe, it, expect } from 'vitest';

const { platePlacementPrompt } = require('../../server/lib/sceneComposite')._internal;

/**
 * The plate judge asks whether each silhouette is where and how its cast line
 * says. The measured depth gate it replaces asked a height ratio and refused
 * the plates that were right.
 */
describe('plate judge prompt', () => {
  const lines = [
    '- ONE red silhouette (#E60000): Fiona, right foreground, three-quarter view, presses the chart flat against her coat. Size: about two-thirds the size of the largest figure.',
    '- ONE blue silhouette (#0050D0): Malva Grimm, where the action places them, three-quarter view, watching the chart from the rowing boat below. Size: midground.',
  ].join('\n');

  it('quotes the cast lines verbatim and asks placement, posture and level', () => {
    const p = platePlacementPrompt(lines, 'watercolor');
    expect(p).toContain(lines);
    expect(p).toContain('(art style: "watercolor")');
    expect(p).toMatch(/WHERE its line says/);
    expect(p).toMatch(/posture/);
    expect(p).toMatch(/below or above another/);
    expect(p).toContain('{"ok": true or false');
  });

  it('works without a style and with empty lines', () => {
    const p = platePlacementPrompt('', '');
    expect(p).not.toContain('art style');
    expect(p).toContain('Reply as JSON');
  });
});
