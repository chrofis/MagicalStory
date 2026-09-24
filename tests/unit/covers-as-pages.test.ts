/**
 * A FULL-STORY COVER IS A PAGE (owner, 2026-09-24 — tasks/covers-as-pages-2026-09-24.md).
 *
 * "Do it the same as a page. The AD makes full briefs of the image. No code
 * telling the AD what is in the code. Basically what is in the code should be
 * the beats for the cover pages, and the AD treats it like any other page."
 *
 * Pinned here, behaviour only (never prompt wording):
 *   - the cover beats code writes (cast, gaze, copy space, element budget);
 *   - the mechanical cover checks a brief is held to (Q2 gaze, Q4 copy space);
 *   - the cover-only render options (aspect, text always in the image);
 *   - which path a stored cover iterates through (Q1 refuse, Q7 trial split),
 *     and that the page path and iterateCover refuse the other's covers;
 *   - covers route through the repair logic like pages (Q7);
 *   - a briefed cover's clothing comes from its own record;
 *   - a portrait gaze is not contradicted by the pose fill line.
 * Archetypal fixtures only.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const CB = require_('../../server/lib/coverBeats');
const { coverRenderOptions } = require_('../../server/lib/coverRender');
const SBC = require_('../../server/lib/sceneBriefCheck');
const { MODEL_DEFAULTS } = require_('../../server/config/models');
const { VB_ELEMENT_BUDGET } = require_('../../server/lib/vbElementBudget');
const { MAX_COVER_CHARACTERS } = require_('../../server/lib/coverCastRoster');

const cast = (n: number, mains: number[]) => ({
  characters: Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `Child${i + 1}` })),
  mainCharacters: mains,
});

describe('cover beats — what code knows about a cover, written as the beat', () => {
  it('one beat per requested cover, on the cover page numbers, after nothing else', () => {
    const beats = CB.buildCoverBeats(cast(2, [1]));
    expect(beats.map((b: any) => [b.coverKey, b.pageNumber])).toEqual([['frontCover', -1], ['initialPage', -2], ['backCover', -3]]);
    expect(CB.buildCoverBeats(cast(2, [1]), { coverTypes: ['frontCover'] })).toHaveLength(1);
  });
  it('front = the main characters; opening and back = mains then the others, capped', () => {
    const c = CB.coverCasts(cast(8, [2, 3]));
    expect(c.frontCover).toEqual(['Child2', 'Child3']);
    expect(c.initialPage).toEqual(['Child2', 'Child3', 'Child1', 'Child4', 'Child5']);
    expect(c.initialPage).toHaveLength(MAX_COVER_CHARACTERS);
    expect(c.backCover).toEqual(c.initialPage);
    // no main character: the whole cast stands in for them
    expect(CB.coverCasts(cast(2, [])).frontCover).toEqual(['Child1', 'Child2']);
  });
  it('each beat is shot — cast — facts — after, and carries gaze, copy space and the element budget', () => {
    for (const b of CB.buildCoverBeats(cast(2, [1]))) {
      const parts = b.planLine.split(' — ');
      expect(parts[0]).toBe('wide');
      expect(b.planLine).toContain('`looksAt: "viewer"`');
      expect(b.planLine).toContain(`textPosition "${CB.COVER_TEXT_POSITION[b.coverKey]}"`);
      expect(b.planLine).toContain(`at most ${VB_ELEMENT_BUDGET}`);
    }
  });
  it('a costumed wardrobe contract reaches the beat; none, no costume line', () => {
    const input = cast(2, [1]);
    const withCostume = CB.buildCoverBeats(input, { clothingRequirements: { Child1: { costumed: { used: true } } } });
    const without = CB.buildCoverBeats(input, { clothingRequirements: { Child1: { standard: { used: true } } } });
    expect(withCostume[0].planLine).toMatch(/costumed outfit/);
    expect(without[0].planLine).not.toMatch(/costumed outfit/);
  });
  it('a story with no characters has no cover cast, and says so loudly', () => {
    expect(() => CB.buildCoverBeats({ characters: [] })).toThrow(/no cast/);
  });
  it('cover page numbers map both ways', () => {
    expect(CB.isCoverPage(-2)).toBe(true);
    expect(CB.isCoverPage(2)).toBe(false);
    expect(CB.coverKeyOfPage(-3)).toBe('backCover');
    expect(CB.coverKeyOfPage(4)).toBeNull();
  });
});

describe('the mechanical cover checks on a brief', () => {
  const meta = (looksAt: string, textPosition: string) => ({
    characters: [{ name: 'Child1', looksAt }], textPosition,
  });
  it('a figure not looking at the viewer and a text zone off the beat are both findings', () => {
    const types = SBC.checkCoverBrief({ pageNumber: -1 }, meta('Child2', 'bottom-full')).map((f: any) => f.type);
    expect(types).toEqual(['cover_gaze_not_viewer', 'cover_text_zone_mismatch']);
  });
  it('a brief that follows its beat is clean', () => {
    expect(SBC.checkCoverBrief({ pageNumber: -1 }, meta('viewer', 'top-full'))).toEqual([]);
    expect(SBC.checkCoverBrief({ pageNumber: -3 }, meta('camera', 'bottom-full'))).toEqual([]);
  });
  it('a story page is never held to a cover rule', () => {
    expect(SBC.checkCoverBrief({ pageNumber: 4 }, meta('Child2', 'bottom-full'))).toEqual([]);
  });
  it('both types reach the scene review', () => {
    expect(SBC.REVIEWABLE.has ? SBC.REVIEWABLE.has('cover_gaze_not_viewer') : SBC.REVIEWABLE.includes('cover_gaze_not_viewer')).toBe(true);
    expect(SBC.REVIEWABLE.has ? SBC.REVIEWABLE.has('cover_text_zone_mismatch') : SBC.REVIEWABLE.includes('cover_text_zone_mismatch')).toBe(true);
  });
});

describe('cover render options', () => {
  it('a story page gets none', () => {
    expect(coverRenderOptions(3, { title: 'T' })).toBeNull();
  });
  it('a cover renders at the cover aspect, text always in the image, in the cover usage bucket', () => {
    for (const n of [-1, -2, -3]) {
      const o = coverRenderOptions(n, { title: 'The Little Lantern', dedication: 'For you' });
      expect(o.aspectRatio).toBe(MODEL_DEFAULTS.coverAspect);
      expect(o.textInImage).toBe(true);
      expect(o.usageLabel).toBe('cover_images');
      expect(o.coverKey).toBe(CB.coverKeyOfPage(n));
    }
  });
  it('only the front cover can bake a title', () => {
    expect(coverRenderOptions(-2, { title: 'X', coverTitleMode: 'baked' }).bakeTitle).toBe('');
    expect(coverRenderOptions(-3, { title: 'X', coverTitleMode: 'baked' }).bakeTitle).toBe('');
  });
});

describe('which path a stored cover takes (Q1 refuse, Q7 trial split)', () => {
  it('trial → iterateCover; briefed full story → the page path; anything else refused', () => {
    expect(CB.coverIteratePath({ trialMode: true, coverImages: { frontCover: {} } }, 'frontCover')).toBe('trial');
    expect(CB.coverIteratePath({ coverImages: { frontCover: { briefedAsPage: true } } }, 'frontCover')).toBe('page');
    expect(() => CB.coverIteratePath({ coverImages: { frontCover: { imageData: 'x' } } }, 'frontCover'))
      .toThrow(/no Art Director brief/);
  });
  it('the page path refuses a pre-change cover before any model call', async () => {
    const { iteratePage } = require_('../../server/lib/images');
    await expect(iteratePage('data:image/png;base64,AA', -1, { coverImages: { frontCover: { imageData: 'x' } } }, {}))
      .rejects.toThrow(/no Art Director brief/);
    await expect(iteratePage('data:image/png;base64,AA', -1, { trialMode: true, coverImages: { frontCover: {} } }, {}))
      .rejects.toThrow(/trial cover iterates through iterateCover/);
  });
  it('iterateCover refuses a full-story cover', async () => {
    const { iterateCover } = require_('../../server/lib/coverIterate');
    await expect(iterateCover('frontCover', { coverImages: { frontCover: { briefedAsPage: true, imageData: 'x' } } }, {}))
      .rejects.toThrow(/full-story cover is a page/);
  });
  it('the trial cover builders throw for a full story (source)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../storyJobPipeline.js'), 'utf8');
    expect(src).toMatch(/const startCoverGeneration = \(coverType, hint\) => \{\s*if \(!inputData\.trialMode\) \{\s*throw new Error/);
    expect(src).toMatch(/onCoverScene: \(coverData\) => \{[\s\S]{0,300}?if \(!inputData\.trialMode\) \{\s*throw new Error/);
    // the stored full-story cover record carries the page mark
    expect(src).toMatch(/briefedAsPage: true,/);
  });
});

describe('covers route through the repair logic like pages', () => {
  it('an entity CRITICAL on a cover character takes a char-fix, as on a page', () => {
    const { decideRepairMethod } = require_('../../server/lib/repairLogic');
    const report = (p: number) => ({ characters: { Child1: { issues: [{ id: 'e1', severity: 'critical', pagesToFix: [p], type: 'face' }] } } });
    const scores = { qualityScore: 40, semanticScore: 40, fixableIssues: [] };
    const page = decideRepairMethod(5, scores, report(5), {});
    const cover = decideRepairMethod(-1, scores, report(-1), {});
    expect(cover.method).toBe(page.method);
    expect(cover.charName ?? null).toBe(page.charName ?? null);
  });
});

describe('a briefed cover reads its clothing from its own record', () => {
  it('resolvePageClothingCategory: briefed cover → perCharClothing; a hint cover → its hint', () => {
    const { resolvePageClothingCategory } = require_('../../server/lib/clothingCategories');
    const story = (rec: any) => ({
      characters: [{ id: 1, name: 'Child1' }],
      coverImages: { frontCover: rec },
      coverHints: { frontCover: { characterClothing: { Child1: 'winter' } } },
      pageClothing: { primaryClothing: 'standard' },
    });
    expect(resolvePageClothingCategory(story({ briefedAsPage: true, perCharClothing: { Child1: 'summer' } }), -1, 'Child1')).toBe('summer');
    expect(resolvePageClothingCategory(story({}), -1, 'Child1')).toBe('winter');
  });
});

describe('a briefed cover is judged against the cast its brief declares, like a page', () => {
  it('names in the prose join a hint cover roster, never a briefed one', () => {
    const { buildExpectedCastBlock } = require_('../../server/lib/evalPipeline');
    const characters = [{ id: 1, name: 'Child1', isMainCharacter: true }, { id: 2, name: 'Child2' }];
    const vb = { mainCharacters: [{ id: 1, name: 'Child1' }], secondaryCharacters: [{ id: 'CHR001', name: 'Child2' }], animals: [] };
    const prose = 'Child1 stands under the arch; Child2 waves from the hill.';
    const roster = (sceneMetadata: any) => buildExpectedCastBlock({
      sceneCharacters: [{ name: 'Child1' }], sceneHint: prose, originalPrompt: prose, visualBible: vb,
      evaluationType: 'cover', storyData: { characters }, sceneMetadata,
    }).names;
    expect(roster(null)).toContain('Child2');
    expect(roster({ characters: [{ name: 'Child1', looksAt: 'viewer' }] })).not.toContain('Child2');
  });
});

describe('a portrait gaze is not contradicted by the pose fill line', () => {
  beforeAll(async () => { await require_('../../server/services/prompts').loadPromptTemplates(); });
  it('a figure sent to the viewer gets no "not at the viewer" line; one without a gaze keeps it', () => {
    const { buildExactPosesBlock } = require_('../../server/lib/promptBuilders');
    const block = String(buildExactPosesBlock([], [{ name: 'Child1', looksAt: 'viewer' }, { name: 'Child2' }], null));
    expect(block).not.toMatch(/Child1: looking off into the scene/);
    expect(block).toMatch(/Child2: looking off into the scene, not at the viewer/);
    expect(block).toMatch(/Child1: eyes on the viewer/);
  });
});
