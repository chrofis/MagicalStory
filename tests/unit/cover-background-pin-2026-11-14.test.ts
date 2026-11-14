/**
 * FULL-STORY COVERS OBEY THE BOOK REVIEW'S BACKGROUND DECISION (owner 2026-11-14,
 * "Make covers obey it"; docs/decisions.md). A cover is a page (2026-09-24), so
 * `resolveIteratePlate` gives it keep / redo exactly as it gives a page: keep =
 * the stored plate, redo = a new plate from the stored plate description plus the
 * change. The cast-0 exemption and a cover with NO pin are unchanged.
 *
 * Behaviour test through resolveIteratePlate with injected loaders; the redo
 * render itself needs a model, so offline it throws PlateRequiredError after
 * proving the redo branch (not the stored plate) was taken.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';
import { readFileSync } from 'fs';

const require_ = createRequire(import.meta.url);
const landmarkScene = require_('../../server/lib/landmarkScene.js');
const images = require_('../../server/lib/images.js');

const STORED = 'data:image/jpeg;base64,STORED';
const CAST = { fullData: { characters: [{ name: 'Mia' }] } };
const CASTLESS = { fullData: { characters: [] } };
const base = { pageNumber: -1, storyData: { id: 's' }, visualBible: null, iterateSceneMetadata: { ...CAST }, pageLandmarkPhotos: [] };

const saved: Array<[any, string, any]> = [];
function patch(obj: any, key: string, value: any) { saved.push([obj, key, obj[key]]); obj[key] = value; }
afterEach(() => { while (saved.length) { const [o, k, v] = saved.pop()!; o[k] = v; } });

describe('a full-story cover obeys the background pin', () => {
  it('keep: the cover is redrawn on its stored plate, even under singlePassScene', async () => {
    const r = await images.resolveIteratePlate({
      ...base, effectiveSinglePass: true, backgroundPin: { keep: true },
      emptySceneCallbacks: { load: async () => STORED },
    });
    expect(r.sceneBackground).toBe(STORED);
    expect(r.freshPlate).toBeNull();
  });
  it('keep: the plate in hand wins and nothing is read or painted', async () => {
    let loads = 0;
    const r = await images.resolveIteratePlate({
      ...base, effectiveSinglePass: true, sceneBackgroundIn: STORED, backgroundPin: { keep: true },
      emptySceneCallbacks: { load: async () => { loads++; return 'x'; } },
    });
    expect(r.sceneBackground).toBe(STORED);
    expect(loads).toBe(0);
  });
  it('keep with no stored plate: one is rendered from the description or the call throws, never a plate-less cover', async () => {
    patch(globalThis as any, 'fetch', async () => { throw new Error('no network'); });
    patch(landmarkScene, 'loadStoredPagePlate', async () => null);
    await expect(images.resolveIteratePlate({
      ...base, effectiveSinglePass: true, backgroundPin: { keep: true }, storedPlatePrompt: 'a harbour at dawn',
    })).rejects.toThrow(landmarkScene.PlateRequiredError);
  });
  it('redo: never reads the stored plate (paints a new one; offline the render fails, so it throws)', async () => {
    let loads = 0;
    patch(globalThis as any, 'fetch', async () => { throw new Error('no network'); });
    await expect(images.resolveIteratePlate({
      ...base, sceneBackgroundIn: STORED, storedPlatePrompt: 'a quiet street', backgroundPin: { keep: false, change: 'a warm evening palette' },
      emptySceneCallbacks: { load: async () => { loads++; return STORED; } },
    })).rejects.toThrow(landmarkScene.PlateRequiredError);
    expect(loads).toBe(0);
  });
  it('redo with no stored plate description is refused, loudly', async () => {
    await expect(images.resolveIteratePlate({ ...base, backgroundPin: { keep: false, change: 'x' } })).rejects.toThrow(/stored plate description/);
  });
});

describe('what did not change for covers', () => {
  it('a cast-0 cover ignores the pin and has no plate', async () => {
    const r = await images.resolveIteratePlate({ ...base, iterateSceneMetadata: CASTLESS, backgroundPin: { keep: false, change: 'x' }, effectiveSinglePass: true });
    expect(r.sceneBackground).toBeNull();
  });
  it('a cover with NO pin and singlePassScene stays plate-less (its own behaviour)', async () => {
    const r = await images.resolveIteratePlate({ ...base, effectiveSinglePass: true, sceneBackgroundIn: STORED });
    expect(r.sceneBackground).toBeNull();
  });
});

describe('iteratePageCore hands a cover its own plate text', () => {
  it('storedPlatePrompt reads the cover record before the brief metadata', () => {
    const src = readFileSync(new URL('../../server/lib/images.js', import.meta.url), 'utf8');
    const i = src.indexOf('const storedPlatePrompt = (coverRecord?.emptyScenePrompt');
    expect(i).toBeGreaterThan(0);
    expect(src.slice(i, i + 300)).toContain('parentSceneMetadata.emptyScenePrompt');
  });
});
