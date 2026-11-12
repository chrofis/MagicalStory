// Delivery by APPENDING versions (owner, 2026-11-12): a picture fixed on staging gets one new
// production version that becomes active; existing production versions are never touched.
// scripts/lib/appendStagingVersions.js + scripts/lib/noWordTraits.js, with stand-in rows.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const P = require_('../../scripts/lib/appendStagingVersions.js');
const { findNoWordFields, replaceNoWordFields } = require_('../../scripts/lib/noWordTraits.js');

const ID = 'job_1_test';
const PROD = 'https://images.magicalstory.ch';
const STG = 'https://images-staging.magicalstory.ch';
const row = (image_type, page_number, version_index, base, extra = {}) => ({
  image_type, page_number, version_index,
  image_url: `${base}/stories/${ID}/${image_type}/${page_number != null ? `p${page_number}` : 'cover'}/v${version_index}.jpg`,
  quality_score: null, generated_at: null, created_at: '2026-11-12T10:00:00Z', ...extra,
});

// Production: p1 v0..v1 (active v1), p2 v0 (active 0), frontCover v0..v1 (active v1).
const prodRows = [row('scene', 1, 0, PROD), row('scene', 1, 1, PROD), row('scene', 2, 0, PROD),
  row('frontCover', null, 0, PROD), row('frontCover', null, 1, PROD)];
const prodMeta = { 1: { activeVersion: 1 }, 2: { activeVersion: 0 }, frontCover: { activeVersion: 1, pinned: true } };
// Staging copy holds the same rows, plus: p1 v2 (new, active), p2 untouched, frontCover v2 + its art (active).
const stagingRows = [...prodRows, row('scene', 1, 2, STG, { quality_score: 88 }),
  row('frontCover', null, 2, STG), row('frontCoverArt', null, 2, STG)];
const stagingMeta = { 1: { activeVersion: 2, pinned: true }, 2: { activeVersion: 0 }, frontCover: { activeVersion: 2, pinned: true } };

const plan = () => P.planAppends({ storyId: ID, stagingMeta, stagingRows, prodMeta, prodRows });

describe('planAppends', () => {
  it('plans one new version per picture whose staging active image is not production active, at the next free index', () => {
    const p = plan();
    expect(p.map((e) => [e.key, e.prodActive, e.newIndex, e.stagingVersion])).toEqual([['1', 1, 2, 2], ['frontCover', 1, 2, 2]]);
    expect(p[0].newKey).toBe(`stories/${ID}/scene/p1/v2.jpg`);
    expect(p[0].sourceUrl).toBe(`${STG}/stories/${ID}/scene/p1/v2.jpg`);
    expect(p[0].qualityScore).toBe(88);
  });
  it('skips a picture whose active image is already production active', () => {
    expect(plan().some((e) => e.key === '2')).toBe(false);
  });
  it('carries a cover art layer at the SAME new index', () => {
    const fc = plan().find((e) => e.key === 'frontCover');
    expect(fc.art).toEqual({ imageType: 'frontCoverArt', sourceUrl: `${STG}/stories/${ID}/frontCoverArt/cover/v2.jpg`, newKey: `stories/${ID}/frontCoverArt/cover/v2.jpg` });
  });
  it('the next index follows production, not staging (a production version staging re-activated is copied, flagged)', () => {
    // Staging re-activates p1 v0 (an original production version) while production shows v1.
    const p = P.planAppends({ storyId: ID, stagingMeta: { ...stagingMeta, 1: { activeVersion: 0 } }, stagingRows, prodMeta, prodRows });
    const e = p.find((x) => x.key === '1');
    expect(e.newIndex).toBe(2);
    expect(e.sameImageAsProdVersion).toBe(0);
  });
  it('refuses a staging active version with no row, and production art already at the new index', () => {
    expect(() => P.planAppends({ storyId: ID, stagingMeta: { ...stagingMeta, 1: { activeVersion: 9 } }, stagingRows, prodMeta, prodRows })).toThrow(/v9 has no image row/);
    expect(() => P.planAppends({ storyId: ID, stagingMeta, stagingRows, prodMeta, prodRows: [...prodRows, row('frontCoverArt', null, 2, PROD)] })).toThrow(/already has frontCoverArt v2/);
  });
});

describe('applyPlanToData / applyPlanToMeta', () => {
  const prodData = {
    sceneImages: [{ pageNumber: 1, imageVersions: [{ type: 'original' }, { type: 'edit', dbVersionIndex: 1 }] }, { pageNumber: 2, imageVersions: [{ type: 'original' }] }],
    coverImages: { frontCover: { imageVersions: [{ type: 'original' }, { type: 'edit', dbVersionIndex: 1 }] } },
  };
  const stagingData = {
    sceneImages: [{ pageNumber: 1, imageVersions: [{ type: 'original' }, { type: 'edit', dbVersionIndex: 1 }, { type: 'edit', dbVersionIndex: 2, lastEditPrompt: 'x', imageData: 'data:...', ref: `${STG}/stories/${ID}/grid.jpg` }] }],
    coverImages: { frontCover: { imageVersions: [{ type: 'original' }, { type: 'edit' }, { type: 'regeneration', qualityScore: 90 }] } },
  };
  it('appends one admin-fix entry per planned picture, leaves existing entries and prodData untouched', () => {
    const before = JSON.stringify(prodData);
    const out = P.applyPlanToData(prodData, stagingData, plan(), { appendedAt: 'T' });
    expect(JSON.stringify(prodData)).toBe(before);
    const p1 = out.sceneImages[0].imageVersions;
    expect(p1.slice(0, 2)).toEqual(prodData.sceneImages[0].imageVersions);
    expect(p1[2]).toMatchObject({ type: 'edit', dbVersionIndex: 2, source: P.ADMIN_FIX_SOURCE, lastEditPrompt: 'x', adminFix: { from: 'staging', stagingVersion: 2, appendedAt: 'T' } });
    expect(p1[2].imageData).toBeUndefined();
    // an unstamped staging entry is found by position
    expect(out.coverImages.frontCover.imageVersions[2]).toMatchObject({ type: 'regeneration', qualityScore: 90, dbVersionIndex: 2 });
    expect(out.sceneImages[1]).toEqual(prodData.sceneImages[1]);
  });
  it('passes each copied entry through the URL rewrite', () => {
    const out = P.applyPlanToData(prodData, stagingData, plan(), { appendedAt: 'T', rewrite: (v) => JSON.parse(JSON.stringify(v).split(STG).join(PROD)) });
    expect(out.sceneImages[0].imageVersions[2].ref).toBe(`${PROD}/stories/${ID}/grid.jpg`);
  });
  it('refuses when production data already has an entry stamped at the new index', () => {
    const taken = JSON.parse(JSON.stringify(prodData));
    taken.sceneImages[0].imageVersions.push({ type: 'edit', dbVersionIndex: 2 });
    expect(() => P.applyPlanToData(taken, stagingData, plan(), { appendedAt: 'T' })).toThrow(/already has a version stamped v2/);
  });
  it('meta: each planned key active on its new version and pinned; other keys unchanged', () => {
    expect(P.applyPlanToMeta(prodMeta, plan())).toEqual({ 1: { activeVersion: 2, pinned: true }, 2: { activeVersion: 0 }, frontCover: { activeVersion: 2, pinned: true } });
  });
});

describe('provenanceProblems', () => {
  const prodData = { a: 1 };
  const base = { prodData, prodMetadata: { updatedAt: '2026-11-12T09:00:00Z' }, prodRows, stagingRows, srcSha: P.sha16(prodData), pulledAt: '2026-11-12T11:00:00Z' };
  it('is empty when production is as pulled', () => {
    expect(P.provenanceProblems(base)).toEqual([]);
  });
  it('flags changed data, a newer image row, a later version pick, a row staging lacks, and a missing stamp', () => {
    expect(P.provenanceProblems({ ...base, prodData: { a: 2 } })[0]).toMatch(/data changed/);
    expect(P.provenanceProblems({ ...base, prodRows: [...prodRows, row('scene', 2, 1, PROD, { created_at: '2026-11-12T12:00:00Z' })] }).join(' ')).toMatch(/created after the pull.*not in the staging copy/);
    expect(P.provenanceProblems({ ...base, prodMetadata: { updatedAt: '2026-11-12T11:30:00Z' } })[0]).toMatch(/version pick/);
    expect(P.provenanceProblems({ ...base, srcSha: '' })).toEqual(['no source sha for the pull']);
  });
});

describe('provenanceProblems after an earlier append', () => {
  // Production already holds p1 v2 appended from staging: prod-bucket URL, admin-fix marker.
  const appended = row('scene', 1, 2, PROD);
  const adminFixData = (marker) => ({ sceneImages: [{ pageNumber: 1, imageVersions: [{ dbVersionIndex: 2, ...(marker ? { source: 'admin-fix', adminFix: { from: 'staging', stagingVersion: 2, appendedAt: 'T' } } : {}) }] }] });
  const mk = (prodData) => ({ prodData, prodMetadata: { updatedAt: '2026-11-12T09:00:00Z' }, prodRows: [...prodRows, appended], stagingRows, srcSha: P.sha16(prodData), pulledAt: '2026-11-12T11:00:00Z' });
  it('accepts a row this tool appended (same type/page/index/path, other bucket)', () => {
    expect(P.provenanceProblems(mk(adminFixData(true)))).toEqual([]);
  });
  it('accepts the textless art row of an appended cover (marker is on the cover entry)', () => {
    const data = { coverImages: { frontCover: { imageVersions: [{ dbVersionIndex: 2, source: 'admin-fix', adminFix: { from: 'staging', stagingVersion: 2, appendedAt: 'T' } }] } } };
    const art = row('frontCoverArt', null, 2, PROD);
    expect(P.provenanceProblems({ ...mk(data), prodRows: [...prodRows, art] })).toEqual([]);
  });
  it('still reports a row with the same path but no admin-fix marker (a customer row)', () => {
    expect(P.provenanceProblems(mk(adminFixData(false))).join(' ')).toMatch(/1 production image row.*not in the staging copy/);
  });
  it('still reports an admin-fix row the staging copy does not hold at that index', () => {
    const b = mk(adminFixData(true));
    const noRow = { ...b, stagingRows: stagingRows.filter((r) => !(r.image_type === 'scene' && r.page_number === 1 && r.version_index === 2)) };
    expect(P.provenanceProblems(noRow).join(' ')).toMatch(/not in the staging copy/);
  });
});

describe('noWordTraits', () => {
  it("replaces only glasses/other values that are exactly a stored 'no' word, anywhere in the snapshot", () => {
    const data = {
      characters: [{ physical: { glasses: 'nein', other: 'Sommersprossen' }, avatars: { extractedTraits: { glasses: 'nein' } } }],
      sceneImages: [{ sceneCharacters: [{ physical: { other: 'nein', glasses: 'schwarze Brille' } }] }],
      note: 'nein',
    };
    expect(findNoWordFields(data).map((h) => h.path)).toEqual(['.characters[0].physical.glasses', '.characters[0].avatars.extractedTraits.glasses', '.sceneImages[0].sceneCharacters[0].physical.other']);
    replaceNoWordFields(data);
    expect(data.characters[0].physical).toEqual({ glasses: 'none', other: 'Sommersprossen' });
    expect(data.sceneImages[0].sceneCharacters[0].physical).toEqual({ other: 'none', glasses: 'schwarze Brille' });
    expect(data.note).toBe('nein');
  });
});

describe('applySheetSwap', () => {
  const OLD = `${PROD}/characters/u/row/inline/styledAvatars-0-standard-aaa.jpg`;
  const COPY = `${PROD}/stories/${ID}/debug/p1/ref-photo-0-orig.jpg`;
  const NEW = `${PROD}/stories/${ID}/sheets/styled-7-standard-bbb.jpg`;
  const data = () => ({
    artStyle: 'realistic',
    characters: [{ id: 7, name: 'Kim, Freund von Lea', avatars: { styledAvatars: { realistic: { standard: OLD } } } }, { id: 8, name: 'Lea', avatars: { styledAvatars: { realistic: { standard: 'x' } } } }],
    characterAvatars: { 'Kim, Freund von Lea': { 'styled-standard': COPY }, Lea: { 'styled-standard': 'y' } },
    sceneImages: [{ pageNumber: 1, sceneCharacters: [{ id: 7, avatars: { styledAvatars: { realistic: { standard: OLD } } } }] }],
  });
  it('repoints both live references of that character only; snapshots and prodData stay', () => {
    const d = data(); const before = JSON.stringify(d);
    const { data: out, changes } = P.applySheetSwap(d, [{ characterId: '7', newUrl: NEW }]);
    expect(JSON.stringify(d)).toBe(before);
    expect(out.characters[0].avatars.styledAvatars.realistic.standard).toBe(NEW);
    expect(out.characterAvatars['Kim, Freund von Lea']['styled-standard']).toBe(NEW);
    expect(out.characters[1]).toEqual(d.characters[1]);
    expect(out.characterAvatars.Lea).toEqual(d.characterAvatars.Lea);
    expect(out.sceneImages[0].sceneCharacters[0].avatars.styledAvatars.realistic.standard).toBe(OLD);
    expect(changes.map((c) => c.from)).toEqual([OLD, COPY]);
  });
  it('refuses an unknown character, a missing reference, and a no-op', () => {
    expect(() => P.applySheetSwap(data(), [{ characterId: 99, newUrl: NEW }])).toThrow(/not in this story/);
    const noSlot = data(); delete noSlot.characterAvatars['Kim, Freund von Lea'];
    expect(() => P.applySheetSwap(noSlot, [{ characterId: 7, newUrl: NEW }])).toThrow(/characterAvatars/);
    expect(() => P.applySheetSwap(data(), [{ characterId: 7, newUrl: OLD }])).toThrow(/already referenced/);
  });
});
