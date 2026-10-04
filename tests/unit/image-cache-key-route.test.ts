import { describe, it, expect } from 'vitest';
const { generateImageCacheKey, imageRouteCacheMarkers } = require('../../server/lib/images');

// Code review 2026-10 A11: same prompt + photos on a different model / backend /
// aspect must not share a cached image.
const key = (route: any) => generateImageCacheKey('p', [], null, 1, ...imageRouteCacheMarkers(route));

describe('image cache key carries the route', () => {
  it('differs by model, backend, aspect and Lab packing knobs', () => {
    const base = { model: 'grok-imagine', backend: 'grok', aspect: '3:4' };
    const k0 = key(base);
    expect(key({ ...base, model: 'grok-imagine-2' })).not.toBe(k0);
    expect(key({ ...base, backend: 'gemini' })).not.toBe(k0);
    expect(key({ ...base, aspect: '1:1' })).not.toBe(k0);
    expect(key({ ...base, maxRefSlots: 5 })).not.toBe(k0);
    expect(key({ ...base, vbColumnFraction: 0.4 })).not.toBe(k0);
  });
  it('is stable for identical routes', () => {
    expect(key({ model: 'a', aspect: '1:1' })).toBe(key({ model: 'a', aspect: '1:1' }));
  });
});
