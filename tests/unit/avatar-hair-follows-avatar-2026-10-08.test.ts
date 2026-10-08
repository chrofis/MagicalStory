/**
 * Owner decision 2026-10-08: for hair the AVATAR wins. Fiona (staging job_1791450210539_nwi88y9lr): the declared hair, read from
 * a headband photo, said "neck-length, brushed back" while her approved avatars show long hair worn down; that string went to the
 * sheet generator, every sheet judge, every page and the cover. The text now follows the avatar (docs/decisions.md
 * "Hair text follows the approved avatar").
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const hairMod = require('../../server/lib/avatarHair');
const { hairRequest } = require('../../server/lib/character2x4Sheet')._internal;
const { buildHairDescription } = require('../../server/lib/promptBuilders');

const photoHair = { type: 'straight', texture: 'medium', density: 'full', lengthTop: 'neck-length', lengthSides: 'same as top', bangsEndAt: 'no bangs', styling: 'brushed back', parting: 'center part' };
const avatarHair = { type: 'straight', texture: 'medium', density: 'full', lengthTop: 'shoulder-length', lengthSides: 'same as top', bangsEndAt: 'no bangs', styling: 'loose', parting: 'center part' };
const DATA_URI = 'data:image/jpeg;base64,/9j/4AAQ';

const fiona = (extra: any = {}) => ({
  id: 1787422997245, name: 'Fiona', physical: { hairColor: 'light brown', detailedHairAnalysis: { ...photoHair } },
  physicalTraitsSource: { height: 'user' }, avatars: { standard: DATA_URI }, ...extra,
});

describe('applyAvatarHair', () => {
  it('REGRESSION: the sheet request and the page hair line say what the avatar shows, not the photo reading', () => {
    const c: any = fiona();
    expect(hairRequest(c)).toContain('neck-length');            // before: the photo reading drove generator and judges
    expect(buildHairDescription(c.physical)).toContain('neck-length');
    hairMod.applyAvatarHair(c, avatarHair);
    expect(hairRequest(c)).toContain('top length shoulder-length');
    expect(hairRequest(c)).toContain('styled loose');
    expect(hairRequest(c)).not.toContain('brushed back');
    expect(buildHairDescription(c.physical)).toContain('shoulder-length');
    expect(buildHairDescription(c.physical)).not.toContain('neck-length');
  });
  it('keeps the photo reading under photoHairAnalysis and stamps the source; a second reading never overwrites the photo copy', () => {
    const c: any = fiona();
    const patch = hairMod.applyAvatarHair(c, avatarHair);
    expect(c.physical.photoHairAnalysis.lengthTop).toBe('neck-length');
    expect(c.physicalTraitsSource.detailedHairAnalysis).toBe('avatar');
    expect(c.physicalTraitsSource.height).toBe('user');
    expect(patch.physical.photoHairAnalysis.lengthTop).toBe('neck-length');
    hairMod.applyAvatarHair(c, { ...avatarHair, lengthTop: 'mid-back' });
    expect(c.physical.photoHairAnalysis.lengthTop).toBe('neck-length');
    expect(c.physical.detailedHairAnalysis.lengthTop).toBe('mid-back');
  });
  it('no prompt reads the audit copy', () => {
    const c: any = fiona();
    hairMod.applyAvatarHair(c, avatarHair);
    expect(hairRequest(c)).not.toContain('neck-length');
  });
});

describe('needsAvatarHair', () => {
  it('is true for a photo reading, false once stamped and false for a value the user typed', () => {
    expect(hairMod.needsAvatarHair(fiona())).toBe(true);
    expect(hairMod.needsAvatarHair(fiona({ physicalTraitsSource: { detailedHairAnalysis: 'avatar' } }))).toBe(false);
    expect(hairMod.needsAvatarHair(fiona({ physicalTraitsSource: { detailedHairAnalysis: 'user' } }))).toBe(false);
    expect(hairMod.needsAvatarHair(fiona({ physicalTraitsSource: { hairType: 'user' } }))).toBe(false);
  });
});

describe('applyAvatarHairToExtraction (the avatar job)', () => {
  const job = (extra: any = {}) => ({ extractedTraits: {}, photoHairAnalysis: photoHair, standard: DATA_URI, ...extra });
  it('the kept avatar reading replaces the photo reading', async () => {
    const results: any = job();
    await hairMod.applyAvatarHairToExtraction(results, { reader: async () => avatarHair });
    expect(results.extractedTraits.detailedHairAnalysis.lengthTop).toBe('shoulder-length');
    expect(results.hairFromAvatar).toBe(true);
  });
  it('reads the standard avatar first, then summer, then winter', async () => {
    const seen: string[] = [];
    const reader = async (img: string) => { seen.push(img); return avatarHair; };
    await hairMod.applyAvatarHairToExtraction(job({ standard: undefined, winter: 'data:image/jpeg;base64,W', summer: 'data:image/jpeg;base64,S' }), { reader });
    await hairMod.applyAvatarHairToExtraction(job({ winter: 'data:image/jpeg;base64,W' }), { reader });
    expect(seen).toEqual(['data:image/jpeg;base64,S', DATA_URI]);
  });
  it('no readable avatar, or a failed read: the photo reading stays, unstamped', async () => {
    const none: any = job({ standard: undefined });
    await hairMod.applyAvatarHairToExtraction(none, { reader: async () => avatarHair });
    const failed: any = job();
    await hairMod.applyAvatarHairToExtraction(failed, { reader: async () => { throw new Error('boom'); } });
    for (const r of [none, failed]) {
      expect(r.extractedTraits.detailedHairAnalysis.lengthTop).toBe('neck-length');
      expect(r.hairFromAvatar).toBe(false);
    }
  });
  it('the route calls it once, after the retries, and no longer prefers the photo reading', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../server/routes/avatars.js'), 'utf8');
    expect(src.match(/applyAvatarHairToExtraction\(results/g)?.length).toBe(1);
    expect(src.indexOf('Retry phase completed')).toBeLessThan(src.indexOf('applyAvatarHairToExtraction(results'));
    expect(src).not.toContain("evalResults.find(r => r.faceMatchResult?.detailedHairAnalysis)");
  });
});

describe('ensureAvatarDerivedHair (existing characters and the trial)', () => {
  it('reads the stored avatar once, applies it, and does not read again', async () => {
    const c: any = fiona();
    let calls = 0;
    const reader = async () => { calls++; return avatarHair; };
    const first = await hairMod.ensureAvatarDerivedHair([c], { reader });
    expect(first).toHaveLength(1);
    expect(c.physical.detailedHairAnalysis.lengthTop).toBe('shoulder-length');
    await hairMod.ensureAvatarDerivedHair([c], { reader });
    expect(calls).toBe(1);
  });
  it('two stages starting together read once', async () => {
    const c: any = fiona();
    let calls = 0;
    const reader = async () => { calls++; await new Promise(r => setTimeout(r, 20)); return avatarHair; };
    await Promise.all([hairMod.ensureAvatarDerivedHair([c], { reader }), hairMod.ensureAvatarDerivedHair([c], { reader })]);
    expect(calls).toBe(1);
  });
  it('a character with no avatar, or a failed read, keeps its hair text and stays unstamped', async () => {
    const noAvatar: any = fiona({ avatars: {} });
    const failed: any = fiona();
    await hairMod.ensureAvatarDerivedHair([noAvatar], { reader: async () => avatarHair });
    await hairMod.ensureAvatarDerivedHair([failed], { reader: async () => null });
    for (const c of [noAvatar, failed]) {
      expect(c.physical.detailedHairAnalysis.lengthTop).toBe('neck-length');
      expect(c.physicalTraitsSource.detailedHairAnalysis).toBeUndefined();
    }
  });
  it('a reader that throws is logged, not thrown, and nothing is stamped', async () => {
    const c: any = fiona();
    await expect(hairMod.ensureAvatarDerivedHair([c], { reader: async () => { throw new Error('boom'); } })).resolves.toEqual([]);
    expect(c.physicalTraitsSource.detailedHairAnalysis).toBeUndefined();
  });
  it('a user-typed hair value is never replaced', async () => {
    const c: any = fiona({ physicalTraitsSource: { detailedHairAnalysis: 'user' } });
    let calls = 0;
    await hairMod.ensureAvatarDerivedHair([c], { reader: async () => { calls++; return avatarHair; } });
    expect(calls).toBe(0);
    expect(c.physical.detailedHairAnalysis.lengthTop).toBe('neck-length');
  });
});
