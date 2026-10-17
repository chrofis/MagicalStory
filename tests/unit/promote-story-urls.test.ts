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
    expect(u.keyForStagingUrl(`${S}/stories/${OLD}/x/v0.jpg`, OLD, NEW)).toBe(`stories/${NEW}/x/v0.jpg`);
    expect(u.keyForStagingUrl(`${S}/stories/${OLD}/x/v0.jpg`, OLD, OLD)).toBe(`stories/${OLD}/x/v0.jpg`);
    expect(u.keyForStagingUrl(`${S}/characters/680c/a.jpg`, OLD, NEW)).toBe('characters/680c/a.jpg');
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
});
