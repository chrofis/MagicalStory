import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const nodeRequire = createRequire(import.meta.url);
const u = nodeRequire('../../scripts/lib/promoteStoryUrls.js');

const OLD = 'job_1792226018737_lb65hzkqs';
const NEW = 'job_1792300000000_abcdefghi';
const S = 'https://images-staging.magicalstory.ch';
const P = 'https://images.magicalstory.ch';

const fixture = () => ({
  id: OLD,
  coverImages: { front: `${S}/stories/${OLD}/frontCover/v1.jpg` },
  vb: [{ referenceImageUrl: `${S}/stories/${OLD}/vb/e1-abc.jpg?x=1` }],
  styled: `${S}/characters/680c/characters_680c/pixar/standard-1.jpg`,
  already: `${P}/characters/6a6d/a.jpg`,
  external: 'https://upload.wikimedia.org/x.jpg',
  debug: [`${S}/stories/${OLD}/debug/backCover/v0/grok-ref-0.jpg`, `${S}/stories/${OLD}/debug/backCover/v0/grok-ref-0.jpg`],
  prose: `see ${S}/stories/${OLD}/a.jpg, and ${S}/stories/${OLD}/b.jpg.`,
});

describe('promoteStoryUrls', () => {
  it('maps keys, swapping the story id only when re-identified', () => {
    expect(u.keyForUrl(`${S}/stories/${OLD}/x/v0.jpg`, OLD, NEW)).toBe(`stories/${NEW}/x/v0.jpg`);
    expect(u.keyForUrl(`${S}/stories/${OLD}/x/v0.jpg`, OLD, OLD)).toBe(`stories/${OLD}/x/v0.jpg`);
    expect(u.keyForUrl(`${S}/characters/680c/a.jpg`, OLD, NEW)).toBe('characters/680c/a.jpg');
  });

  it('collects distinct staging URLs, ignoring prod and external ones, query strings and trailing punctuation', () => {
    const urls = u.collectStagingUrls(fixture());
    expect(urls.size).toBe(6);
    expect(urls.has(`${S}/stories/${OLD}/vb/e1-abc.jpg`)).toBe(true);
    expect(urls.has(`${S}/stories/${OLD}/b.jpg.`)).toBe(false);
  });

  it('as-new rewrite: no staging URL left, id replaced everywhere, query kept, foreign URLs untouched', () => {
    const out = u.rewriteDeep(fixture(), OLD, NEW);
    expect(u.countStagingHostMentions(out)).toBe(0);
    expect(() => u.assertNoStagingUrls(out)).not.toThrow();
    expect(JSON.stringify(out)).not.toContain(OLD);
    expect(out.id).toBe(NEW);
    expect(out.coverImages.front).toBe(`${P}/stories/${NEW}/frontCover/v1.jpg`);
    expect(out.vb[0].referenceImageUrl).toBe(`${P}/stories/${NEW}/vb/e1-abc.jpg?x=1`);
    expect(out.styled).toBe(`${P}/characters/680c/characters_680c/pixar/standard-1.jpg`);
    expect(out.already).toBe(`${P}/characters/6a6d/a.jpg`);
    expect(out.external).toBe('https://upload.wikimedia.org/x.jpg');
    expect(out.prose).toBe(`see ${P}/stories/${NEW}/a.jpg, and ${P}/stories/${NEW}/b.jpg.`);
  });

  it('update-mode rewrite keeps the id', () => {
    const out = u.rewriteDeep(fixture(), OLD, OLD);
    expect(out.id).toBe(OLD);
    expect(out.coverImages.front).toBe(`${P}/stories/${OLD}/frontCover/v1.jpg`);
  });

  it('does not mutate the input', () => {
    const f = fixture();
    u.rewriteDeep(f, OLD, NEW);
    expect(f.id).toBe(OLD);
  });

  it('guard throws when a staging URL survives', () => {
    expect(() => u.assertNoStagingUrls(fixture())).toThrow(/staging URL/);
    expect(() => u.assertNoStagingUrls({ a: [`${S}/k.jpg`] })).toThrow(/1 staging URL/);
  });

  it('makeJobId matches the app format', () => {
    expect(u.makeJobId()).toMatch(/^job_\d{13}_[a-z0-9]{1,9}$/);
  });

  // Regression: a story pulled from production keeps its untouched images at the PRODUCTION
  // bucket under stories/<oldId>/. as-new used to rewrite the id in those URLs without copying
  // the object, so the new story pointed at keys that never existed.
  it('as-new: production URLs under the old story id are rewritten AND scheduled for copy', () => {
    const v = { img: `${P}/stories/${OLD}/scene/3/v2.jpg`, shared: `${P}/characters/680c/a.jpg`, stg: `${S}/stories/${OLD}/x.jpg` };
    const out = u.rewriteDeep(v, OLD, NEW);
    expect(out.img).toBe(`${P}/stories/${NEW}/scene/3/v2.jpg`);
    const copy = u.collectCopySources(v, OLD, NEW);
    expect(copy.has(`${P}/stories/${OLD}/scene/3/v2.jpg`)).toBe(true);
    expect(copy.has(`${S}/stories/${OLD}/x.jpg`)).toBe(true);
    expect(copy.has(`${P}/characters/680c/a.jpg`)).toBe(false); // shared character art stays where it is
    expect(u.rewriteDeep({ l: `${P}/landmarks/index/1/a.jpg` }, OLD, NEW, S).l).toBe(`${P}/landmarks/index/1/a.jpg`); // shared asset keeps its URL even for a staging target
  });

  it('update mode copies only staging-bucket URLs; production URLs stay put', () => {
    const copy = u.collectCopySources(fixture(), OLD, OLD);
    expect(copy.size).toBe(6);
    expect([...copy].every((x) => x.startsWith(S))).toBe(true);
  });

  it('staging target: staging URLs of the old id are copied under the new id inside the same bucket', () => {
    const v = { a: `${S}/stories/${OLD}/a.jpg`, c: `${S}/characters/680c/c.jpg` };
    expect(u.rewriteDeep(v, OLD, NEW, S).a).toBe(`${S}/stories/${NEW}/a.jpg`);
    const copy = u.collectCopySources(v, OLD, NEW, S);
    expect([...copy]).toEqual([`${S}/stories/${OLD}/a.jpg`]);
    expect(() => u.assertAllOnBase(u.rewriteDeep(v, OLD, NEW, S), S, 'x', OLD, NEW)).not.toThrow();
    expect(() => u.assertAllOnBase({ x: `${P}/stories/${OLD}/k.jpg` }, S, 'x', OLD, NEW)).toThrow(/not rewritten/);
  });

  describe('restore', () => {
    const backup = () => ({
      takenAt: '2026-11-07T10:00:00.000Z', storyId: OLD,
      story: { id: OLD, user_id: 'u1', data: { id: OLD, c: `${P}/stories/${OLD}/f.jpg` }, metadata: { id: OLD }, image_version_meta: {},
        share_token: 't', is_shared: true, created_at: '2026-11-01T00:00:00.000Z' },
      story_images: [{ id: 5, story_id: OLD, image_type: 'scene', page_number: 1, image_url: `${P}/stories/${OLD}/s1.jpg` }],
    });

    it('accepts a production backup', () => {
      expect(() => u.assertRestorable(backup(), OLD)).not.toThrow();
    });

    it('refuses a backup that references the staging bucket (data or image rows)', () => {
      const b1 = backup(); b1.story.data.c = `${S}/stories/${OLD}/f.jpg`;
      expect(() => u.assertRestorable(b1, OLD)).toThrow(/REFUSED/);
      const b2 = backup(); b2.story_images[0].image_url = `${S}/stories/${OLD}/s1.jpg`;
      expect(() => u.assertRestorable(b2, OLD)).toThrow(/REFUSED/);
      const b3 = backup(); b3.story.metadata.note = 'see images-staging.magicalstory.ch';
      expect(() => u.assertRestorable(b3, OLD)).toThrow(/REFUSED/);
    });

    it('a staging backup may hold shared production URLs when restoring to staging', () => {
      const b = backup(); b.story.data.c = `${S}/stories/${OLD}/f.jpg`; b.story.data.shared = `${P}/landmarks/a.jpg`;
      expect(() => u.assertRestorable(b, OLD, S)).not.toThrow();
    });

    it('refuses a backup of another story or with missing parts', () => {
      expect(() => u.assertRestorable(backup(), NEW)).toThrow(/not/);
      const b = backup(); delete b.story_images;
      expect(() => u.assertRestorable(b, OLD)).toThrow(/missing/);
    });

    it('restore columns exclude the owner-side columns and reject columns the table lost', () => {
      const b = backup();
      const live = { ...b.story, extra_live_col: 1 };
      expect(u.restoreStoryColumns(b.story, live).sort()).toEqual(['data', 'image_version_meta', 'metadata']);
      expect(() => u.restoreStoryColumns({ ...b.story, gone: 1 }, live)).toThrow(/gone/);
    });

    it('toDbValue: jsonb arrays become JSON text, timestamps become Dates, null stays null', () => {
      expect(u.toDbValue([1, 2], 'jsonb')).toBe('[1,2]');
      expect(u.toDbValue({ a: 1 }, 'jsonb')).toBe('{"a":1}');
      expect(u.toDbValue('2026-11-01T00:00:00.000Z', 'timestamp without time zone')).toEqual(new Date('2026-11-01T00:00:00.000Z'));
      expect(u.toDbValue(undefined, 'text')).toBeNull();
      expect(u.toDbValue('x', 'character varying')).toBe('x');
    });
  });
});
