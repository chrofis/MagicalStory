import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../..');

/**
 * getElementReferenceImagesForPage takes the page's cited object ids as its
 * fourth argument. Passing null selects references from the Visual Bible's own
 * appearsInPages alone, so a prop the brief names — and the prompt therefore
 * describes — can lose its reference cell, and the model invents its look.
 * Every caller that HOLDS scene metadata must pass the page's objects[].
 */
describe('element reference selection is fed the page\'s own objects', () => {
  it('no regeneration call site passes a literal null for sceneObjectIds', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/routes/regeneration.js'), 'utf8');
    const calls = src.match(/getElementReferenceImagesForPage\([^)]*\)/g) || [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const args = call.slice(call.indexOf('(') + 1, -1).split(',').map((a) => a.trim());
      // A 3-argument call takes the parameter default (null) and holds no scene
      // metadata at all; only the 5-argument calls are in scope here.
      if (args.length < 5) continue;
      expect(args[3], call).not.toBe('null');
      expect(args[3], call).toMatch(/objects/);
    }
  });
});
