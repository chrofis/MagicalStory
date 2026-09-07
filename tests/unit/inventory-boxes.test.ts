import { describe, it, expect } from 'vitest';
// @ts-ignore — CommonJS module
import { normaliseBox, normaliseInventoryBoxes } from '../../server/lib/inventoryBoxes.js';

describe('normaliseBox', () => {
  it('passes a well-formed 0-1 box through unchanged', () => {
    expect(normaliseBox([0.22, 0.34, 0.48, 0.93])).toEqual([0.22, 0.34, 0.48, 0.93]);
  });

  it('rescales a mixed 0-1 / 0-1000 box element by element (Qwen3-VL, Lab 1053)', () => {
    expect(normaliseBox([0.23, 350, 486, 947])).toEqual([0.23, 0.35, 0.486, 0.947]);
  });

  it('rescales an all-0-1000 box', () => {
    expect(normaliseBox([533, 294, 752, 947])).toEqual([0.533, 0.294, 0.752, 0.947]);
  });

  it('accepts numeric strings', () => {
    expect(normaliseBox(['0.1', '200', '0.5', '900'])).toEqual([0.1, 0.2, 0.5, 0.9]);
  });

  it('returns null for an inverted, out-of-range, short or non-array box', () => {
    expect(normaliseBox([0.5, 0.5, 0.2, 0.9])).toBeNull();
    expect(normaliseBox([0.1, 0.1, 0.5, 1500])).toBeNull();
    expect(normaliseBox([0.1, 0.1, 0.5])).toBeNull();
    expect(normaliseBox('0.1,0.1,0.5,0.9')).toBeNull();
    expect(normaliseBox(null)).toBeNull();
  });
});

describe('normaliseInventoryBoxes', () => {
  it('fixes mixed boxes on every figure, nulls the unfixable, and leaves Gemini output alone', () => {
    const inv = {
      figures: [
        { id: 1, body_bbox: [0.23, 350, 486, 947], face_bbox: [0.3, 0.4, 0.5, 0.6] },
        { id: 2, body_bbox: [0.5, 0.5, 0.2, 0.9], face_bbox: null },
        { id: 3, body_bbox: [0.1, 0.2, 0.3, 0.4] },
      ],
    };
    const stats = normaliseInventoryBoxes(inv);
    expect(inv.figures[0].body_bbox).toEqual([0.23, 0.35, 0.486, 0.947]);
    expect(inv.figures[0].face_bbox).toEqual([0.3, 0.4, 0.5, 0.6]);
    expect(inv.figures[1].body_bbox).toBeNull();
    expect(inv.figures[1].face_bbox).toBeNull();
    expect(inv.figures[2].body_bbox).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(stats).toEqual({ fixed: 1, dropped: 1 });
  });

  it('tolerates a missing or empty figures array', () => {
    expect(normaliseInventoryBoxes({})).toEqual({ fixed: 0, dropped: 0 });
    expect(normaliseInventoryBoxes(null)).toEqual({ fixed: 0, dropped: 0 });
  });
});
