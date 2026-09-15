import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * One defect, one D-code. A missing limb inside the frame belongs to the
 * figure_completeness ladder (D-11 to D-13), which carries the guard that
 * exempts a figure cropped, occluded, shown from behind or loosely brushed.
 * While D-09 also claimed it, the same defect could be charged CRITICAL as
 * anatomy — bypassing that guard — or MAJOR as completeness, three lines apart.
 */
describe('image-evaluation: a missing limb has one owner', () => {
  const t = () => read('prompts/image-evaluation.txt');

  it('D-12 (figure_completeness) owns a missing hand, arm or leg', () => {
    expect(/\*\*D-12 `figure_completeness` → MAJOR\.\*\* A missing hand, arm or leg inside the frame/.test(t())).toBe(true);
  });

  it('D-09 (anatomy) does not also claim it', () => {
    const d09 = t().split('\n').find((l) => l.startsWith('**D-09 `anatomy`')) || '';
    expect(d09).not.toMatch(/missing hand|missing arm|missing leg/);
    expect(d09).toMatch(/extra limbs/); // it still owns surplus and malformed limbs
  });
});

/**
 * The blind judge (image-prompt-compliance.txt) reads BOTH figure inventories,
 * so the two must describe items_held in the same shape. A free-text list on one
 * side and a two-key object on the other made the same picture read two ways.
 */
describe('items_held has one schema across both inventories', () => {
  for (const rel of ['prompts/image-inventory-unified.txt', 'prompts/image-evaluation.txt']) {
    it(`${path.basename(rel)} declares the two-key {left,right} shape`, () => {
      const text = read(rel);
      expect(/`items_held`[^\n]*`\{"left": \.\.\., "right": \.\.\.\}`/.test(text), 'prose rule').toBe(true);
      expect(/"items_held": \{ "left":/.test(text), 'JSON example').toBe(true);
      expect(/"items_held": \[/.test(text), 'no array example left').toBe(false);
    });
  }
});
