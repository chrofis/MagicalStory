/**
 * COVERS ARE JUDGED ON THEIR TEXTLESS ART (owner, 2026-09-26: "the app texts
 * (magicalstory.ch, dedication, composited title) should not be part of the
 * evaluated image — evaluate first, then add the text").
 *
 * Lab 1521 judged the back cover of staging job_1790446348343_z3fw660ie on
 * its served bytes and read the app's own "magicalstory.ch". Pinned here:
 *  - resolveCoverEvalImage returns the `${key}Art` row of EXACTLY the version
 *    judged; a stamped version without one throws NO_ART_LAYER (never the
 *    stamped bytes, never another version's art); an unstamped cover is its
 *    own art;
 *  - the whole-book view swaps every cover to its art and drops (and names)
 *    a cover that has none;
 *  - the Lab loader hands every stage the art of a cover;
 *  - the post-persist bake stores the active version's art at the ACTIVE
 *    index (it wrote v0, and the non-active loop then overwrote it).
 *
 * Only the DB boundary is stubbed. No paid call is made.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const sharp = require_('sharp');
const database = require_('../../server/services/database');
const bbox = require_('../../server/lib/bboxDetection');

const uri = (tag: string) => `data:image/jpeg;base64,${Buffer.from(tag).toString('base64')}`;
const row = (tag: string) => ({ image_url: null, image_data: Buffer.from(tag) });

type Row = { type: string; v: number; tag: string; test?: boolean };
let rows: Row[] = [];
let active: Record<string, number> = {};
let typography: Record<string, boolean> = {};
let saved: any[] = [];

database.getActiveVersion = async (_id: string, key: string) => active[key] ?? 0;
database.dbQuery = async (sql: string, params: any[]) => {
  if (/SELECT EXISTS/.test(sql)) {
    const [, artType, key] = params;
    return [{ art: rows.some(r => r.type === artType && !r.test), typo: !!typography[key] }];
  }
  if (/version_index = \$3/.test(sql)) {
    const [, type, v] = params;
    const r = rows.find(x => x.type === type && x.v === v);
    return r ? [row(r.tag)] : [];
  }
  throw new Error(`unexpected query: ${sql}`);
};

const { resolveCoverEvalImage, applyCoverEvalView } = require_('../../server/lib/coverEvalLayer');

beforeEach(() => { rows = []; active = {}; typography = {}; saved = []; });

describe('resolveCoverEvalImage — the art of exactly the judged version', () => {
  it('returns the art row of the active version, not the served stamp', async () => {
    rows = [{ type: 'backCover', v: 2, tag: 'STAMPED' }, { type: 'backCoverArt', v: 2, tag: 'ART2' }, { type: 'backCoverArt', v: 0, tag: 'ART0' }];
    active = { backCover: 2 };
    const r = await resolveCoverEvalImage('job_x', 'backCover', null);
    expect(r).toEqual({ imageData: uri('ART2'), versionIndex: 2, layer: 'art' });
  });

  it('a pinned version reads its own art', async () => {
    rows = [{ type: 'backCoverArt', v: 0, tag: 'ART0' }, { type: 'backCoverArt', v: 2, tag: 'ART2' }];
    active = { backCover: 2 };
    expect((await resolveCoverEvalImage('job_x', 'backCover', 0)).imageData).toBe(uri('ART0'));
  });

  it('a stamped version without its art throws — no stamped bytes, no other version\'s art', async () => {
    rows = [{ type: 'backCover', v: 1, tag: 'STAMPED' }, { type: 'backCoverArt', v: 0, tag: 'ART0' }];
    active = { backCover: 1 };
    await expect(resolveCoverEvalImage('job_x', 'backCover', null)).rejects.toMatchObject({ code: 'NO_ART_LAYER' });
  });

  it('a typography marker alone marks the cover stamped', async () => {
    rows = [{ type: 'frontCover', v: 0, tag: 'STAMPED' }];
    typography = { frontCover: true };
    await expect(resolveCoverEvalImage('job_x', 'frontCover', 0)).rejects.toMatchObject({ code: 'NO_ART_LAYER' });
  });

  it('a Lab art row does not make a never-stamped cover stamped', async () => {
    rows = [{ type: 'frontCover', v: 0, tag: 'RAW' }, { type: 'frontCoverArt', v: 5, tag: 'LABART', test: true }];
    const r = await resolveCoverEvalImage('job_x', 'frontCover', 0);
    expect(r).toEqual({ imageData: uri('RAW'), versionIndex: 0, layer: 'unstamped' });
  });

  it('a cover the app never stamped (baked title, first run, legacy) is its own art', async () => {
    rows = [{ type: 'frontCover', v: 0, tag: 'BAKED' }];
    expect(await resolveCoverEvalImage('job_x', 'frontCover', null)).toEqual({ imageData: uri('BAKED'), versionIndex: 0, layer: 'unstamped' });
  });

  it('a missing version is an error, not an empty eval', async () => {
    await expect(resolveCoverEvalImage('job_x', 'backCover', 3)).rejects.toThrow(/does not exist/);
  });
});

describe('applyCoverEvalView — the whole-book judges read the art', () => {
  it('swaps each cover to its art, re-points a CLONE of its detection, drops a cover without art', async () => {
    rows = [
      { type: 'backCover', v: 0, tag: 'STAMPED_B' }, { type: 'backCoverArt', v: 0, tag: 'ART_B' },
      { type: 'frontCover', v: 1, tag: 'STAMPED_F' }, { type: 'frontCoverArt', v: 0, tag: 'ART_F0' },
    ];
    active = { frontCover: 1, backCover: 0 };
    const det = { figures: [{ name: 'A' }], sourceImageFp: bbox.imageFingerprint(uri('STAMPED_B')) };
    const story: any = { coverImages: {
      backCover: { imageData: uri('STAMPED_B'), bboxDetection: det },
      frontCover: { imageData: uri('STAMPED_F') },
    } };
    const { notEvaluated, servedByKey } = await applyCoverEvalView('job_x', story);
    expect(story.coverImages.backCover.imageData).toBe(uri('ART_B'));
    expect(bbox.bboxPairsWith(story.coverImages.backCover.bboxDetection, uri('ART_B'))).toBe(true);
    expect(det.sourceImageFp).toBe(bbox.imageFingerprint(uri('STAMPED_B'))); // original untouched
    expect(servedByKey.backCover).toBe(uri('STAMPED_B'));
    expect(story.coverImages.frontCover).toBeUndefined();
    expect(notEvaluated).toHaveLength(1);
    expect(notEvaluated[0].coverKey).toBe('frontCover');
  });
});

describe('the Test Lab loads a cover as its art', () => {
  it('loadActivePageImage returns the textless layer of the active and of a pinned version', async () => {
    rows = [{ type: 'backCover', v: 0, tag: 'STAMPED' }, { type: 'backCoverArt', v: 0, tag: 'ART0' },
      { type: 'backCover', v: 4, tag: 'LAB_STAMPED', test: true }, { type: 'backCoverArt', v: 4, tag: 'LAB_ART', test: true }];
    const { loadActivePageImage } = require_('../../server/lib/testlab');
    expect(await loadActivePageImage('job_x', -3)).toBe(uri('ART0'));
    expect(await loadActivePageImage('job_x', -3, 4)).toBe(uri('LAB_ART'));
    expect(await loadActivePageImage('job_x', -3, 4, 'backCover')).toBe(uri('LAB_ART'));
  });
});

describe('the post-persist bake keeps the ACTIVE version\'s art', () => {
  it('writes the active version\'s art at its own index, and each other version\'s at its own', async () => {
    const jpeg = async (r: number) => (await sharp({ create: { width: 64, height: 64, channels: 3, background: { r, g: 90, b: 90 } } }).jpeg().toBuffer());
    const v0 = await jpeg(10);
    const v1 = await jpeg(200);
    database.saveStoryImage = async (_id: string, type: string, _p: any, data: string, opts: any) => { saved.push({ type, v: opts.versionIndex, data }); };
    const prevDbQuery = database.dbQuery;
    database.dbQuery = async (sql: string, params: any[]) => {
      if (/image_version_meta FROM stories/.test(sql)) return [{ image_version_meta: { backCover: { activeVersion: 1 } } }];
      if (/image_type=\$2 AND NOT is_test LIMIT 1/.test(sql)) return []; // not baked yet
      if (/version_index=\$3 AND NOT is_test LIMIT 1/.test(sql)) return [{ image_url: null, image_data: v1 }];
      if (/version_index <> \$3/.test(sql)) return [{ version_index: 0, image_url: null, image_data: v0 }];
      return [];
    };
    try {
      const { bakeCoverTypographyPostPersist } = require_('../../server/lib/coverTypography');
      await bakeCoverTypographyPostPersist('job_x', { coverImages: { backCover: {} } }, { title: 'T', skipKeys: ['frontCover', 'initialPage'] });
    } finally {
      database.dbQuery = prevDbQuery;
    }
    const art = saved.filter(s => s.type === 'backCoverArt');
    expect(art.map(a => a.v).sort()).toEqual([0, 1]);
    const artOf = (v: number) => Buffer.from(art.find(a => a.v === v).data.split(',')[1], 'base64');
    expect(artOf(1).equals(v1)).toBe(true);
    expect(artOf(0).equals(v0)).toBe(true);
  });
});
