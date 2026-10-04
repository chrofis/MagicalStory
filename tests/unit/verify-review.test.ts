/**
 * The review page for the registry's HUMAN checks (scripts/admin/verify-review.js)
 * and the write-back of its verdicts (verify-run.js --apply) — owner, 2026-09-27.
 *
 * Pinned: the page lists only pending entries whose verdict on this run is
 * HUMAN, shows the images the check names plus its check.images kinds, carries
 * a verdict control pre-filled from Claude's verdicts, and escapes everything
 * it prints. --apply records confirmed / failed with who decided, refuses a
 * file for another story or a verdict without a note, and leaves undecided
 * items pending.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const core = require('../../scripts/admin/verify-core.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { reviewItems, renderReviewPage } = require('../../scripts/admin/verify-review.js');

const U = (p: string) => `https://images-staging.magicalstory.ch/stories/s/${p}.jpg`;
const ctx = {
  build: 'f'.repeat(40),
  versionMeta: { 1: { activeVersion: 1 }, 2: { activeVersion: 0 } },
  data: { styledAvatarGeneration: [{ characterName: 'A', clothingCategory: 'standard', output: { imageUrl: U('sheetA') } }] },
  images: [
    { image_type: 'scene', page_number: 1, version_index: 0, image_url: U('p1v0') },
    { image_type: 'scene', page_number: 1, version_index: 1, image_url: U('p1v1') },
    { image_type: 'scene', page_number: 2, version_index: 0, image_url: U('p2v0') },
    { image_type: 'empty_scene', page_number: 1, version_index: 0, image_url: U('plate1') },
    { image_type: 'frontCover', page_number: null, version_index: 0, image_url: U('fc0') },
    { image_type: 'frontCover', page_number: null, version_index: 1, image_url: U('fc1') },
  ],
};
const human = (id: string, extra: any = {}) => ({ id, title: `t ${id}`, claim: `claim <${id}>`, commits: [], runShape: ['any'], status: 'pending', evidence: [], check: { kind: 'human', what: `look at ${U('named')}`, ...extra } });

describe('imagesFor / urlsIn', () => {
  it('each kind resolves from the stored rows', () => {
    const lab = (k: string) => core.imagesFor([k], ctx).map((x: any) => x.label);
    expect(lab('pages')).toEqual(['p1 v1', 'p2 v0']);
    expect(lab('versions')).toEqual(['p1 v0', 'p1 v1']);
    expect(lab('plates')).toEqual(['p1 plate']);
    expect(lab('covers')).toEqual(['frontCover']);
    expect(core.imagesFor(['covers'], ctx)[0].url).toBe(U('fc1'));
    expect(lab('sheets')).toEqual(['A sheet (standard)']);
  });
  it('an unknown kind throws', () => {
    expect(() => core.imagesFor(['pagez'], ctx)).toThrow(/unknown image kind/);
  });
  it('urlsIn finds image urls in a check instruction, once each', () => {
    expect(core.urlsIn(`p5 ${U('a')} | p6 ${U('a')}, ${U('b')}`)).toEqual([U('a'), U('b')]);
  });
});

describe('reviewItems + renderReviewPage', () => {
  const entries = [human('h1', { images: ['plates'] }), human('h2'), { ...human('done'), status: 'confirmed' },
    { ...human('auto'), check: { kind: 'auto', fn: 'noSuchFn' } }];
  const items = reviewItems(entries, ctx, () => true, { h1: { id: 'h1', verdict: 'failed', note: 'plate shows a person', by: 'claude' } });

  it('lists only pending entries whose verdict is HUMAN', () => {
    expect(items.map((i: any) => i.id)).toEqual(['h1', 'h2', 'auto']);
  });
  it('shows the urls the check names plus its image kinds', () => {
    expect(items[0].images.map((x: any) => x.url)).toEqual([U('named'), U('plate1')]);
  });
  it('renders a pre-filled verdict control, escapes text, and exports verdicts', () => {
    const html = renderReviewPage({ storyId: 's', env: 'staging', build: 'f'.repeat(40), runDate: 'd' }, items);
    expect(html).toContain('claim &lt;h1&gt;');
    expect(html).not.toContain('claim <h1>');
    expect(html).toMatch(/name="v0" value="failed" checked/);
    expect(html).toContain('plate shows a person');
    expect(html).toContain('verdict by claude');
    expect(html).toContain('verify-verdicts-');
    expect(html).toContain('--apply=');
  });
});

describe('applyVerdictsFile (--apply)', () => {
  const run = { storyId: 's', env: 'staging', build: 'b', runDate: 'd' };
  const reg = () => ({ entries: [human('h1'), human('h2'), human('h3')] });

  it('records confirmed / failed with who decided, leaves undecided pending', () => {
    const r: any = reg();
    const out = core.applyVerdictsFile(r, run, { storyId: 's', env: 'staging', verdicts: [
      { id: 'h1', verdict: 'confirmed', note: 'feet shod in all cells', by: 'claude' },
      { id: 'h2', verdict: 'failed', note: 'head row bare arms', by: 'owner' },
      { id: 'h3', verdict: 'undecided', note: '' },
    ] }, { checkedAt: 'n' });
    expect(out).toEqual({ marked: ['h1:confirmed', 'h2:failed'], skipped: ['h3'] });
    expect(r.entries.map((e: any) => e.status)).toEqual(['confirmed', 'failed', 'pending']);
    expect(r.entries[1].evidence[0]).toMatchObject({ result: 'HUMAN-FAILED', by: 'owner', storyId: 's' });
  });

  it('refuses another story, and a decided verdict without a note, before writing anything', () => {
    const r: any = reg();
    expect(() => core.applyVerdictsFile(r, run, { storyId: 'other', verdicts: [] }, { checkedAt: 'n' })).toThrow(/not s/);
    expect(() => core.applyVerdictsFile(r, run, { storyId: 's', verdicts: [
      { id: 'h1', verdict: 'confirmed', note: 'ok' }, { id: 'h2', verdict: 'failed', note: ' ' },
    ] }, { checkedAt: 'n' })).toThrow(/needs a note/);
    expect(r.entries[0].status).toBe('pending');
  });
});

describe('tasks/verify.json image kinds', () => {
  it('every check.images kind is one verify-core knows', () => {
    const reg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'tasks', 'verify.json'), 'utf8'));
    for (const e of reg.entries) for (const k of e.check?.images || []) expect(core.IMAGE_KINDS).toContain(k);
  });
});
