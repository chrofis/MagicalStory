/** A character with only an original photo gets its face/body cut-outs at job start; no photo / no body fails at once. */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const r2 = require('../../server/lib/r2.js');
const { ensureCharacterCutouts, CharacterInputError } = require('../../server/lib/characterCutouts.js');
const { _internal } = require('../../server/lib/character2x4Sheet.js');

const JPEG = 'data:image/jpeg;base64,' + Buffer.from('x').toString('base64');
const ok = { success: true, face_thumbnail: 'FACE', body_crop: 'BODY', body_no_bg: 'BODYNOBG' };

describe('ensureCharacterCutouts', () => {
  it('derives face + body from the original (analyzer mocked) and the sheet reference then resolves', async () => {
    vi.spyOn(r2, 'bytesFromAnyImage').mockResolvedValue(Buffer.from('jpegbytes'));
    const analyze = vi.fn().mockResolvedValue(ok);
    const genLog = { info: vi.fn() };
    const c: any = { name: 'Lea', photos: { original: 'https://x/original.jpg', face: null, body: null, bodyNoBg: null } };
    await ensureCharacterCutouts([c], { analyze, genLog });
    // the derivation is in the story's stored log, not only the server log
    expect(genLog.info).toHaveBeenCalledWith('character_cutout_derived', expect.stringContaining('Lea'), 'Lea');
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(analyze.mock.calls[0][0]).toBe('/analyze');
    expect(c.photos.face).toBe('FACE');
    expect(c.photos.bodyNoBg).toBe('BODYNOBG');
    expect(await _internal.resolveBodyReference(c)).toMatch(/^data:image\/jpeg;base64,/);
  });
  it('skips a character that already has a cut-out (no analyzer call)', async () => {
    const analyze = vi.fn();
    await ensureCharacterCutouts([{ name: 'A', photos: { bodyNoBg: 'u' } }], { analyze });
    expect(analyze).not.toHaveBeenCalled();
  });
  it('fails at once when there is no photo at all', async () => {
    const analyze = vi.fn();
    await expect(ensureCharacterCutouts([{ name: 'Lea', photos: {} }], { analyze })).rejects.toBeInstanceOf(CharacterInputError);
    expect(analyze).not.toHaveBeenCalled();
  });
  it('fails at once when the analyzer finds no person / no body / several faces', async () => {
    vi.spyOn(r2, 'bytesFromAnyImage').mockResolvedValue(Buffer.from('b'));
    const c = () => [{ name: 'Lea', photos: { original: 'u' } }];
    await expect(ensureCharacterCutouts(c(), { analyze: vi.fn().mockRejectedValue(new Error('no_face_detected')) })).rejects.toThrow(/Lea/);
    await expect(ensureCharacterCutouts(c(), { analyze: vi.fn().mockResolvedValue({ success: true, face_thumbnail: 'F' }) })).rejects.toThrow(/no body/);
    await expect(ensureCharacterCutouts(c(), { analyze: vi.fn().mockResolvedValue({ success: true, multiple_faces_detected: true, face_count: 2 }) })).rejects.toThrow(/2 faces/);
  });
  it('the job runs it before the writer, at job start', () => {
    const src = fs.readFileSync('storyJobPipeline.js', 'utf8');
    const i = src.indexOf('ensureCharacterCutouts');
    expect(i).toBeGreaterThan(0);
    expect(i).toBeLessThan(src.indexOf('ensureAvatarDerivedHair(inputData.characters'));
    expect(src).toMatch(/ensureCharacterCutouts\(inputData\.characters \|\| \[\], \{ userId, genLog \}\)/);
  });
});
