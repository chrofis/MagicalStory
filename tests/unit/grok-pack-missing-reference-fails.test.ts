import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const grok: any = nodeRequire('../../server/lib/grok.js');

// Code review 2026-10 A4 / decisions #4: a character whose reference cannot be
// loaded must stop the render, not be dropped with a warning.
describe('packReferences: a named character whose bytes cannot be loaded', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('throws instead of rendering without that character', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) })));
    await expect(grok.packReferences({
      characterPhotos: [{ name: 'Mia', photoUrl: 'https://images.magicalstory.ch/missing/mia.png', photoType: 'standard' }],
    }, {})).rejects.toThrow(/Mia/);
  });
});
