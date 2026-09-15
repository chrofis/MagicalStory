/**
 * THE images.js FACADE MUST FORWARD EVERYTHING.
 *
 * CLAUDE.md states that server/lib/images.js re-exports every name of
 * server/lib/evalPipeline.js and server/lib/bboxDetection.js (the god-file split
 * of 2026-08-11). Both forward lists were written by hand; on 2026-09-15 they were
 * 15 names behind (12 eval, 3 bbox). Same defect class as the storyHelpers facade
 * (tests/unit/story-helpers-facade.test.ts): a consumer that destructures a
 * missing name from './images' binds `undefined` and Node says nothing.
 */
import { describe, it, expect } from 'vitest';
import path from 'path';

const LIB = path.join(process.cwd(), 'server', 'lib');
const images = require(path.join(LIB, 'images.js'));

const DOMAIN_MODULES = ['evalPipeline', 'bboxDetection'];

describe('images.js re-export facade', () => {
  it('forwards every export of evalPipeline.js and bboxDetection.js', () => {
    const missing: string[] = [];
    for (const name of DOMAIN_MODULES) {
      const mod = require(path.join(LIB, `${name}.js`));
      expect(Object.keys(mod).length).toBeGreaterThan(0);
      for (const key of Object.keys(mod)) {
        if (!(key in images)) missing.push(`${name}.${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('forwards the same reference, never a stale copy or a duplicate', () => {
    const stale: string[] = [];
    for (const name of DOMAIN_MODULES) {
      const mod = require(path.join(LIB, `${name}.js`));
      for (const key of Object.keys(mod)) {
        if (images[key] !== mod[key]) stale.push(`${name}.${key}`);
      }
    }
    expect(stale).toEqual([]);
  });
});
