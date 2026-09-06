/**
 * offloadCharacterImages — the single guard on every full-blob
 * `characters.data` write.
 *
 * Contract under test (owner's ruling 2026-09-06): images live in R2, the row
 * holds URLs; if R2 fails we PERSIST the row anyway and alarm at ERROR rather
 * than throwing away the user's work.
 *
 * r2's uploader is stubbed so nothing touches the network or a database.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

// database.js is CommonJS and holds its own `require('../lib/r2')` reference,
// which vi.mock's ESM interception does not reach. So load the REAL modules
// through createRequire and swap r2's two functions on the module object —
// database.js calls them as `r2.isConfigured()` / `r2.uploadImage()`, so the
// swap is what it sees. Nothing touches the network or a database.
const require_ = createRequire(import.meta.url);
const r2 = require_('../../server/lib/r2');
const { offloadCharacterImages, measureInlineImageBytes } = require_('../../server/services/database');

const realIsConfigured = r2.isConfigured;
const realUploadImage = r2.uploadImage;

// A ">1024 chars, data:-prefixed" string is what the extractor recognises.
const bytes = (n = 4000) => `data:image/jpeg;base64,${'A'.repeat(n)}`;
const fakeLog = () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() });

beforeEach(() => {
  r2.isConfigured = vi.fn(() => true);
  r2.uploadImage = vi.fn(async (_input: string, key: string) => `https://r2.example/${key}`);
});
afterEach(() => {
  r2.isConfigured = realIsConfigured;
  r2.uploadImage = realUploadImage;
});

describe('offloadCharacterImages', () => {
  it('is a near no-op when the payload carries no image bytes', async () => {
    const log = fakeLog();
    const data = {
      characters: [{ id: 1, name: 'Ada', photos: { face: 'https://r2.example/face.jpg' } }],
      relationships: {},
    };
    const out = await offloadCharacterImages('characters_7', '7', data, log);

    expect(out).toBe(data);                       // same object, untouched
    expect(data.characters[0].photos.face).toBe('https://r2.example/face.jpg');
    expect(r2.isConfigured).not.toHaveBeenCalled();  // no R2 work at all
    expect(r2.uploadImage).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it('returns the swept payload when the offload succeeds', async () => {
    const log = fakeLog();
    const data = {
      characters: [{
        id: 1,
        name: 'Ada',
        photos: { face: bytes(), bodyNoBg: bytes() },
        avatars: { styledAvatars: { watercolor: { standard: bytes() } } },
      }],
    };
    const out = await offloadCharacterImages('characters_7', '7', data, log);

    expect(out).toBe(data);
    expect(r2.uploadImage).toHaveBeenCalledTimes(3);
    expect(data.characters[0].photos.face).toMatch(/^https:\/\/r2\.example\//);
    expect(data.characters[0].photos.bodyNoBg).toMatch(/^https:\/\/r2\.example\//);
    expect(data.characters[0].avatars.styledAvatars.watercolor.standard).toMatch(/^https:\/\/r2\.example\//);
    expect(measureInlineImageBytes(data)).toBe(0);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('never throws: on extractor failure it alarms and returns the ORIGINAL payload', async () => {
    const log = fakeLog();
    r2.isConfigured = vi.fn(() => false);   // extractor throws before mutating

    const inline = bytes();
    const data = { characters: [{ id: 1, name: 'Ada', photos: { face: inline } }] };
    const out = await offloadCharacterImages('characters_7', '7', data, log);

    expect(out).toBe(data);
    expect(data.characters[0].photos.face).toBe(inline);   // work preserved
    expect(log.error).toHaveBeenCalledTimes(1);
    const msg = log.error.mock.calls[0][0];
    expect(msg).toContain('characters_7');                 // names the row
    expect(msg).toMatch(/MB/);                             // names the size
    expect(msg).toMatch(/housekeeping/i);                  // names the backstop
  });

  it('alarms but still returns the payload when an individual upload fails', async () => {
    const log = fakeLog();
    r2.uploadImage = vi.fn(async () => null);   // no URL → extractor throws

    const data = { characters: [{ id: 1, photos: { face: bytes() } }] };
    const out = await offloadCharacterImages('characters_9', '9', data, log);

    expect(out).toBe(data);
    expect(log.error).toHaveBeenCalledTimes(1);
  });
});

describe('measureInlineImageBytes', () => {
  it('counts nested byte strings and survives cycles', () => {
    const node: any = { photos: { face: bytes(2000) } };
    node.self = node;                          // cycle
    expect(measureInlineImageBytes(node)).toBeGreaterThan(2000);
  });

  it('ignores short strings and URLs', () => {
    expect(measureInlineImageBytes({ a: 'https://r2.example/x.jpg', b: 'data:image/jpeg;base64,AAAA' })).toBe(0);
  });
});
