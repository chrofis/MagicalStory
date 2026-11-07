/**
 * A RE-RENDER KEEPS THE PAGE'S PLATE (owner decision 2026-11-07; docs/decisions.md).
 *
 * Rubi p6 was redrawn with no plate (it is not a landmark page) and came out in
 * a palette unlike its book. Every page that is not cast-0 is redrawn on its
 * stored plate; none stored -> one is rendered and saved; refused -> throw.
 * The book review pins keep / redo from the reviewer's `background:` tag.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';

const require_ = createRequire(import.meta.url);
const landmarkScene = require_('../../server/lib/landmarkScene.js');
const images = require_('../../server/lib/images.js');
const bookAudit = require_('../../server/lib/bookAudit.js');
const review = require_('../../server/lib/bookReview.js');

const LM = [{ name: 'Old town square', photoData: 'data:image/jpeg;base64,RAW' }];
const CAST = { sceneMetadata: { fullData: { characters: [{ name: 'Mia' }] } } };
const CASTLESS = { sceneMetadata: { fullData: { characters: [] } } };
const STORED = 'data:image/jpeg;base64,STORED';

const saved: Array<[any, string, any]> = [];
function patch(obj: any, key: string, value: any) { saved.push([obj, key, obj[key]]); obj[key] = value; }
afterEach(() => { while (saved.length) { const [o, k, v] = saved.pop()!; o[k] = v; } });

describe('resolveRepairScene is the one resolver for a stored page', () => {
  it('a NON-landmark page is redrawn on its stored plate', async () => {
    patch(landmarkScene, 'loadStoredPagePlate', async () => STORED);
    await expect(landmarkScene.resolveRepairScene({ page: CAST, landmarkPhotos: [], storyId: 's', pageNumber: 6 }))
      .resolves.toEqual({ sceneBackground: STORED, landmarkScene: null });
  });
  it('the plate the caller holds wins over the stored row, for any page', async () => {
    patch(landmarkScene, 'loadStoredPagePlate', async () => STORED);
    const r = await landmarkScene.resolveRepairScene({ page: CAST, landmarkPhotos: [], plate: 'data:image/jpeg;base64,MINE', storyId: 's', pageNumber: 6 });
    expect(r.sceneBackground).toBe('data:image/jpeg;base64,MINE');
  });
  it('none stored: renders one and uses it', async () => {
    patch(landmarkScene, 'loadStoredPagePlate', async () => null);
    let rendered = 0;
    const r = await landmarkScene.resolveRepairScene({
      page: CAST, landmarkPhotos: [], storyId: 's', pageNumber: 6,
      renderPlate: async () => { rendered++; return 'data:image/jpeg;base64,FRESH'; },
    });
    expect(rendered).toBe(1);
    expect(r.sceneBackground).toBe('data:image/jpeg;base64,FRESH');
  });
  it('none stored and the render is refused: throws, no plate-less redraw', async () => {
    patch(landmarkScene, 'loadStoredPagePlate', async () => null);
    await expect(landmarkScene.resolveRepairScene({ page: CAST, landmarkPhotos: [], storyId: 's', pageNumber: 6, renderPlate: async () => null }))
      .rejects.toThrow(landmarkScene.PlateRequiredError);
  });
  it('a stored plate is never re-rendered', async () => {
    patch(landmarkScene, 'loadStoredPagePlate', async () => STORED);
    let rendered = 0;
    await landmarkScene.resolveRepairScene({ page: CAST, landmarkPhotos: [], storyId: 's', pageNumber: 6, renderPlate: async () => { rendered++; return 'x'; } });
    expect(rendered).toBe(0);
  });
  it('the cast-0 exemption: no plate, no read, no render', async () => {
    let loads = 0; let rendered = 0;
    patch(landmarkScene, 'loadStoredPagePlate', async () => { loads++; return STORED; });
    const r = await landmarkScene.resolveRepairScene({ page: CASTLESS, landmarkPhotos: LM, renderPlate: async () => { rendered++; return 'x'; } });
    expect(r).toEqual({ sceneBackground: null, landmarkScene: 'castless' });
    expect(loads + rendered).toBe(0);
  });
  it('an in-run caller with no renderer: a landmark page with no plate throws, any other page goes without', async () => {
    patch(landmarkScene, 'loadStoredPagePlate', async () => null);
    await expect(landmarkScene.resolveRepairScene({ page: CAST, landmarkPhotos: LM })).rejects.toThrow(landmarkScene.PlateRequiredError);
    await expect(landmarkScene.resolveRepairScene({ page: CAST, landmarkPhotos: [] })).resolves.toEqual({ sceneBackground: null, landmarkScene: null });
  });
});

describe('page regenerate (ensureStoryPagePlate) always keeps the stored plate', () => {
  it('a non-landmark page is redrawn on its stored plate with no render', async () => {
    let fetched = 0;
    patch(globalThis as any, 'fetch', async () => { fetched++; throw new Error('no network'); });
    patch(landmarkScene, 'loadStoredPagePlate', async () => STORED);
    const r = await images.ensureStoryPagePlate({ storyId: 's', storyData: {}, visualBible: null, pageNumber: 6, sceneMetadata: CAST.sceneMetadata, landmarkPhotos: [] });
    expect(r).toEqual({ sceneBackground: STORED, landmarkScene: null });
    expect(fetched).toBe(0);
  });
  it('a non-landmark page with no stored plate and nothing to render from throws', async () => {
    patch(landmarkScene, 'loadStoredPagePlate', async () => null);
    await expect(images.ensureStoryPagePlate({ storyId: 's', storyData: {}, visualBible: null, pageNumber: 6, sceneMetadata: CAST.sceneMetadata, landmarkPhotos: [] }))
      .rejects.toThrow(landmarkScene.PlateRequiredError);
  });
});

describe('resolveIteratePlate: keep, redo and the rewriter', () => {
  const base = { pageNumber: 6, storyData: { id: 's' }, visualBible: null, iterateSceneMetadata: { ...CAST.sceneMetadata }, pageLandmarkPhotos: [] };
  it('pin keep: redraws on the plate in hand, whatever the rewriter said', async () => {
    const r = await images.resolveIteratePlate({
      ...base, iterateSceneMetadata: { ...CAST.sceneMetadata, reuseEmptyScene: false, emptyScenePrompt: 'a new place' },
      sceneBackgroundIn: STORED, backgroundPin: { keep: true },
    });
    expect(r.sceneBackground).toBe(STORED);
    expect(r.freshPlate).toBeNull();
  });
  it('pin keep: loads the stored plate for a non-landmark page, even under singlePassScene', async () => {
    const r = await images.resolveIteratePlate({
      ...base, effectiveSinglePass: true, backgroundPin: { keep: true },
      emptySceneCallbacks: { load: async () => STORED },
    });
    expect(r.sceneBackground).toBe(STORED);
  });
  it('pin redo: never reads the stored plate (it paints a new one; offline the render fails, so it throws)', async () => {
    let loads = 0;
    patch(globalThis as any, 'fetch', async () => { throw new Error('no network'); });
    await expect(images.resolveIteratePlate({
      ...base, sceneBackgroundIn: STORED, storedPlatePrompt: 'a quiet street', backgroundPin: { keep: false, change: 'a warm evening palette' },
      iterateSceneMetadata: { ...CAST.sceneMetadata, reuseEmptyScene: true },
      emptySceneCallbacks: { load: async () => { loads++; return STORED; } },
    })).rejects.toThrow(landmarkScene.PlateRequiredError);
    expect(loads).toBe(0);
  });
  it('pin redo with no stored description is refused', async () => {
    await expect(images.resolveIteratePlate({ ...base, backgroundPin: { keep: false, change: 'x' } })).rejects.toThrow(/stored plate description/);
  });
  it('no pin, rewriter silent: a non-landmark page keeps its stored plate (never "no plate")', async () => {
    const r = await images.resolveIteratePlate({ ...base, emptySceneCallbacks: { load: async () => STORED } });
    expect(r.sceneBackground).toBe(STORED);
  });
  it('no pin, rewriter says reuse true: the stored plate', async () => {
    const r = await images.resolveIteratePlate({
      ...base, iterateSceneMetadata: { ...CAST.sceneMetadata, reuseEmptyScene: true }, emptySceneCallbacks: { load: async () => STORED },
    });
    expect(r.sceneBackground).toBe(STORED);
  });
  it('no pin, rewriter says reuse false with its own plate text: the stored plate is not read', async () => {
    let loads = 0;
    patch(globalThis as any, 'fetch', async () => { throw new Error('no network'); });
    await expect(images.resolveIteratePlate({
      ...base, iterateSceneMetadata: { ...CAST.sceneMetadata, reuseEmptyScene: false, emptyScenePrompt: 'a harbour at dawn' },
      emptySceneCallbacks: { load: async () => { loads++; return STORED; } },
    })).rejects.toThrow(landmarkScene.PlateRequiredError);
    expect(loads).toBe(0);
  });
  it('a cast-0 page ignores the pin and keeps its exemption; a cover keeps its own behaviour', async () => {
    const a = await images.resolveIteratePlate({ ...base, iterateSceneMetadata: CASTLESS.sceneMetadata, backgroundPin: { keep: true }, effectiveSinglePass: true });
    expect(a.sceneBackground).toBeNull();
    const b = await images.resolveIteratePlate({ ...base, pageNumber: -1, backgroundPin: { keep: false, change: 'x' }, effectiveSinglePass: true });
    expect(b.sceneBackground).toBeNull();
  });
  it('singlePassScene still frees a non-landmark page when no pin asks for a plate', async () => {
    const r = await images.resolveIteratePlate({ ...base, effectiveSinglePass: true, sceneBackgroundIn: STORED });
    expect(r.sceneBackground).toBeNull();
  });
});

describe("the reviewer's background tag (bookAudit.parseRoutes)", () => {
  const parse = (l: string) => bookAudit.parseRoutes(l).IMG[0];
  it('keep', () => {
    const f = parse('FAULT[IMG][MAJOR][wrong_action][NEW]: p6 — Draw the hero looking at the door. | background: keep');
    expect(f.route).toEqual({ kind: 'NEW', background: { keep: true } });
    expect(f.detail).toBe('Draw the hero looking at the door.');
  });
  it('redo carries what to change; dash variants and a missing pipe are read', () => {
    expect(parse('FAULT[IMG][MAJOR][setting][NEW]: p6 — Draw the market. | background: redo — cooler blue evening light').route)
      .toEqual({ kind: 'NEW', background: { keep: false, change: 'cooler blue evening light' } });
    expect(parse('FAULT[IMG][MAJOR][setting][NEW]: p6 — Draw the market. background: redo - a green meadow').route.background)
      .toEqual({ keep: false, change: 'a green meadow' });
  });
  it('a NEW line with no tag, or a redo with no change, is unroutable and says why', () => {
    for (const l of [
      'FAULT[IMG][MAJOR][setting][NEW]: p6 — Draw the market.',
      'FAULT[IMG][MAJOR][setting][NEW]: p6 — Draw the market. | background: redo',
      'FAULT[IMG][MAJOR][setting][NEW]: p6 — Draw the market. | background: maybe',
    ]) {
      const f = parse(l);
      expect(f.route).toBeNull();
      expect(f.routeError).toMatch(/background/);
    }
  });
  it('TOUCHUP and CHAR lines need no tag; one written there is cut off the instruction', () => {
    expect(parse('FAULT[IMG][MAJOR][clothing][TOUCHUP]: p3 — Remove the hat.').route).toEqual({ kind: 'TOUCHUP' });
    const f = parse('FAULT[IMG][MAJOR][clothing][CHAR:Anna]: p3 — Redraw her coat. | background: keep');
    expect(f.route).toEqual({ kind: 'CHAR', charName: 'Anna' });
    expect(f.detail).toBe('Redraw her coat.');
  });
  it('the review prompt asks for exactly the forms the parser reads', async () => {
    const prompts = require_('../../server/services/prompts.js');
    await prompts.loadPromptTemplates();
    const fill = (t: string, v: any) => t.replace(/\{(\w+)\}/g, (_m, k) => v[k] ?? '');
    const text = bookAudit.reviewRulesText({ title: 'T' }, prompts.PROMPT_TEMPLATES, fill);
    expect(text).toContain(bookAudit.BACKGROUND_TAG_FORMS);
    expect(text).not.toContain('{BACKGROUND_TAG}');
    for (const form of ['| background: keep', '| background: redo — warmer light']) {
      expect(parse(`FAULT[IMG][MAJOR][setting][NEW]: p1 — x ${form}`).route).not.toBeNull();
    }
  });
});

describe('bookReview.chooseMethod pins the background for the redraw', () => {
  const faults = (...lines: string[]) => bookAudit.parseRoutes(lines.join('\n')).IMG;
  it('keep', () => {
    const c = review.chooseMethod(faults('FAULT[IMG][MAJOR][wrong_action][NEW]: p6 — a. | background: keep'));
    expect(c.method).toBe('iterate');
    expect(c.backgroundPin).toEqual({ keep: true });
  });
  it('redo', () => {
    const c = review.chooseMethod(faults('FAULT[IMG][MAJOR][setting][NEW]: p6 — a. | background: redo — a warmer palette'));
    expect(c.backgroundPin).toEqual({ keep: false, change: 'a warmer palette' });
  });
  it('faults that disagree: redo wins and the changes are joined', () => {
    const c = review.chooseMethod(faults(
      'FAULT[IMG][MAJOR][setting][NEW]: p6 — a. | background: keep',
      'FAULT[IMG][MAJOR][setting][NEW]: p6 — b. | background: redo — a warmer palette',
      'FAULT[IMG][MAJOR][setting][NEW]: p6 — c. | background: redo — no fence',
    ));
    expect(c.backgroundPin).toEqual({ keep: false, change: 'a warmer palette; no fence' });
  });
  it('a NEW fault with no decision is unroutable, never repaired', () => {
    const c = review.chooseMethod(faults('FAULT[IMG][MAJOR][setting][NEW]: p6 — a.'));
    expect(c.method).toBeNull();
    expect(c.unroutable).toHaveLength(1);
  });
  it('the pin reaches the iterate call as latestEval.backgroundPin', async () => {
    const calls: any[] = [];
    const imgs = [{ pageNumber: 6, imageData: 'data:image/jpeg;base64,AAAA', text: 't' }];
    const pageVersions = new Map([[6, [{ imageData: imgs[0].imageData, source: 'original', pageNumber: 6 }]]]);
    const runRepairMethod = async (a: any) => { calls.push(a); return { pageNumber: 6, imageData: 'data:image/jpeg;base64,BBBB', source: 'iterate-round-1' }; };
    let n = 0;
    const reviewBook = async () => {
      const raw = n++ === 0 ? 'FAULT[IMG][MAJOR][setting][NEW]: p6 — a. | background: redo — blue dusk' : '';
      return { faults: 1, byRoute: bookAudit.parseRoutes(raw), raw, pagesRead: [6], betterVerdicts: {} };
    };
    await review.runBookReviewRounds({
      rawImages: imgs, pageVersions, selectBestVersion: (vs: any[]) => vs[vs.length - 1], maxRepairRounds: 1, reviewBook, runRepairMethod,
      buildRoundVersion: (r: any, p: any) => ({ imageData: r.imageData, source: r.source, ...p }),
      redetect: async () => ({ figures: [] }), nameMapFor: () => null, inheritSceneContract: () => {},
      auditRecord: (a: any, round: number) => ({ round, faults: a.faults }),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('iterate');
    expect(calls[0].latestEval.backgroundPin).toEqual({ keep: false, change: 'blue dusk' });
  });
});
