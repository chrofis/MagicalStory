/**
 * HEIGHT LINE = end state against a body landmark (staging test, 2026-11-06).
 * Pins the band mapping, the kept order header, the one-line shape images.js
 * relies on, and that the no-staircase rule reaches every template that carries
 * {HEIGHT_ORDER}. Never the exact prose beyond the pinned phrases.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require_ = createRequire(import.meta.url);
const { buildRelativeHeightDescription: build, HEIGHT_NO_STAIRCASE_RULE } = require_('../../server/lib/promptBuilders');

const pair = (diff: number) => build([{ name: 'Ann', height: 100 }, { name: 'Bea', height: 100 + diff }]);

describe('height line landmarks', () => {
  const cases: Array<[number, string]> = [
    [2, 'about the same height as Ann'],
    [4, "level with Bea's forehead"],
    [8, "level with Bea's eyebrows"],
    [13, "level with Bea's nose"],
    [20, "level with Bea's chin"],
    [30, "level with Bea's shoulders"],
    [50, 'clearly taller than Ann'],
  ];
  for (const [diff, text] of cases) {
    it(`${diff} cm -> ${text}`, () => expect(pair(diff)).toContain(text));
  }

  it('keeps the order header and never says "slightly taller"', () => {
    const l = build([{ name: 'A', height: 106 }, { name: 'B', height: 114 }, { name: 'C', height: 118 }]);
    expect(l).toContain('**HEIGHT ORDER (shortest to tallest):** A (shortest) -> B -> C');
    expect(l).not.toMatch(/slightly taller/);
    expect(l).toContain("The top of A's head is level with B's eyebrows.");
    expect(l).toContain("The top of B's head is level with C's forehead.");
  });

  it('is one line and carries the no-staircase rule', () => {
    const l = pair(8);
    expect(l.includes('\n')).toBe(false);
    expect(l).toContain(HEIGHT_NO_STAIRCASE_RULE);
  });

  it('every template with {HEIGHT_ORDER} reaches the line (placeholder present)', () => {
    for (const f of ['scene-briefs-all', 'scene-expansion', 'scene-iteration', 'scene-iteration-free', 'visual-bible']) {
      expect(fs.readFileSync(`prompts/${f}.txt`, 'utf8')).toContain('{HEIGHT_ORDER}');
    }
  });
});
