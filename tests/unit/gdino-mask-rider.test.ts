/**
 * `_gdinoMasks` rides detection results non-enumerably (bboxDetection.js header)
 * so JSONB persistence never sees the mask PNGs. It must ALSO be redefinable:
 * the Gemini-extras merge redefines the list with [...dino, ...extras], and a
 * non-configurable property made that throw — every extra figure on p16/p18 of
 * job_1789348171785_9oxos7dwv stayed maskless.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SOURCES = ['server/lib/bboxDetection.js', 'server/lib/repairPipeline.js'];

describe('_gdinoMasks rider', () => {
  it('can be redefined with a merged list and still hides from JSON', () => {
    const result: any = { figures: [{ name: 'A' }] };
    Object.defineProperty(result, '_gdinoMasks', { value: ['m1'], enumerable: false, configurable: true });
    const extras = ['m2', 'm3'];
    Object.defineProperty(result, '_gdinoMasks',
      { value: [...result._gdinoMasks, ...extras], enumerable: false, configurable: true });
    expect(result._gdinoMasks).toHaveLength(3);
    expect(JSON.stringify(result)).not.toContain('_gdinoMasks');
  });

  it('every writer in the server declares configurable', () => {
    for (const rel of SOURCES) {
      const src = fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
      const writes = src.match(/defineProperty\([^;]*?'_gdinoMasks'[\s\S]{0,200}?\}\)/g) || [];
      expect(writes.length).toBeGreaterThan(0);
      for (const w of writes) expect(w).toContain('configurable: true');
    }
  });
});
