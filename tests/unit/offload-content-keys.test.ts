/**
 * Offloaded images are named by CONTENT. A positional name (`styledAvatars-0-standard.jpg`) let a later story's
 * sheet overwrite the bytes an earlier story still referenced (staging: 26 of 78 story sheet references).
 * r2 is stubbed with an in-memory bucket; nothing touches the network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require_ = createRequire(import.meta.url);
const r2 = require_('../../server/lib/r2');
const { offloadCharacterImages } = require_('../../server/services/database');

const realIsConfigured = r2.isConfigured;
const realUploadImage = r2.uploadImage;
const bucket = new Map<string, string>();
const bytes = (seed: string) => `data:image/jpeg;base64,${seed.repeat(4000)}`;

beforeEach(() => {
  bucket.clear();
  r2.isConfigured = vi.fn(() => true);
  r2.uploadImage = vi.fn(async (input: string, key: string) => { bucket.set(key, input); return `https://r2.example/${key}`; });
});
afterEach(() => { r2.isConfigured = realIsConfigured; r2.uploadImage = realUploadImage; });

const key = (url: string) => url.replace('https://r2.example/', '');

describe('offloadCharacterImages names objects by content', () => {
  it('two offloads of different bytes at the same field and position get different keys; the first stays intact', async () => {
    const a = { styledAvatars: [{ standard: bytes('A') }] };
    const b = { styledAvatars: [{ standard: bytes('B') }] };
    await offloadCharacterImages('c1', 'u1', a);
    await offloadCharacterImages('c1', 'u1', b);
    const ka = key(a.styledAvatars[0].standard), kb = key(b.styledAvatars[0].standard);
    expect(ka).not.toBe(kb);
    expect(bucket.get(ka)).toBe(bytes('A'));
    expect(bucket.get(kb)).toBe(bytes('B'));
  });

  it('identical bytes at the same position dedupe to one key', async () => {
    const a = { styledAvatars: [{ standard: bytes('A') }] };
    const b = { styledAvatars: [{ standard: bytes('A') }] };
    await offloadCharacterImages('c1', 'u1', a);
    await offloadCharacterImages('c1', 'u1', b);
    expect(a.styledAvatars[0].standard).toBe(b.styledAvatars[0].standard);
    expect(bucket.size).toBe(1);
  });
});

describe('styled sheets and VB references are named by content', () => {
  const { saveStyledAvatarToR2, saveVbReferenceToR2 } = require_('../../server/services/database');
  it('a later sheet for the same style and category does not overwrite the earlier one', async () => {
    const u1 = await saveStyledAvatarToR2('u1', 'c1', 'anime/standard', bytes('A'));
    const u2 = await saveStyledAvatarToR2('u1', 'c1', 'anime/standard', bytes('B'));
    expect(u1).not.toBe(u2);
    expect(bucket.get(key(u1))).toBe(bytes('A'));
    expect(bucket.get(key(u2))).toBe(bytes('B'));
  });
  it('a VB reference rewritten for the same entry keeps the earlier bytes under the earlier URL', async () => {
    const u1 = await saveVbReferenceToR2('s1', 'LOC001', bytes('A'));
    const u2 = await saveVbReferenceToR2('s1', 'LOC001', bytes('B'));
    expect(u1).not.toBe(u2);
    expect(bucket.get(key(u1))).toBe(bytes('A'));
    expect(bucket.get(key(u2))).toBe(bytes('B'));
  });
});
