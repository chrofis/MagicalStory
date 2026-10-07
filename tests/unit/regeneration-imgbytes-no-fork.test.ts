/**
 * REV-7 (docs/review-2026-07-04.html): routes/regeneration.js once carried
 * `imgRowToBytes`, a hand-copied replica of database.js `imgBytesAsync`, kept
 * local "because imgBytesAsync isn't exported". It is exported now, and two
 * copies of the same byte materialiser drift (one already logged through a
 * different logger). The single-page rehydrate must read bytes through the
 * one exported function.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);
const ROOT = path.join(__dirname, '..', '..');
const src = fs.readFileSync(path.join(ROOT, 'server/routes/regeneration.js'), 'utf8');

describe('regeneration.js reads image bytes through database.imgBytesAsync', () => {
  it('has no local replica of imgBytesAsync', () => {
    expect(src).not.toMatch(/imgRowToBytes/);
    expect(src).not.toMatch(/async function imgBytesAsync/);
  });

  it('imports imgBytesAsync from the database service and uses it for the single-page rehydrate', () => {
    const importLine = src.match(/const \{[^}]*\} = require\('\.\.\/services\/database'\);/)?.[0] || '';
    expect(importLine).toMatch(/\bimgBytesAsync\b/);
    expect(src).toMatch(/sceneEntry\.imageData = await imgBytesAsync\(activeRow\)/);
  });

  it('the database service exports imgBytesAsync', () => {
    const db = req('../../server/services/database');
    expect(typeof db.imgBytesAsync).toBe('function');
  });
});
