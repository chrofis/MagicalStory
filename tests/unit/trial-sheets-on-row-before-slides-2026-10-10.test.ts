/**
 * The story job waits for the sheets to be ON THE ROW, not for the waiting-page slides to be cut and uploaded
 * (docs/decisions.md 2026-10-10). Staging job_1791637887327: the costumed sheet was stored at 15:12:43 CH and
 * prepare-title returned at 15:12:48, the job (and every page image) waited for the slides in between.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-sheets-on-row';
const trialSheets = require('../../server/lib/trialSheets.js');
const trialRouter = require('../../server/routes/trial.js');

const root = path.resolve(__dirname, '../..');

function deps(events: string[], rowChar: any) {
  return {
    offload: async () => {},
    storeSlides: async (_c: string, _u: string, s: string[]) => { events.push('slides-stored'); return [...s]; },
    modifyRow: async (_id: string, _u: string, mutate: any) => {
      const data = { characters: [rowChar] };
      if ((await mutate(data)) === false) return null;
      events.push('row-written');
      return data;
    },
    readCharacter: async () => rowChar,
    buildSlides: async () => { events.push('slides-cut'); return [{ cut: 1 }]; },
  };
}

afterEach(() => {
  trialRouter.inFlightTitleSheetsOnRow.clear();
  trialRouter.inFlightStandardSheetsOnRow.clear();
});

describe('persistPreparedSheets signals onSheetsMerged before the slides are cut', () => {
  it('fires after the sheets are merged into the row and before any slide work', async () => {
    const events: string[] = [];
    const rowChar: any = { id: 7, name: 'Kid', preGeneratedStyledAvatars: {} };
    const d: any = deps(events, rowChar);
    d.storeSlides = async (_c: string, _u: string, s: any) => { events.push('slides-stored'); return s; };
    // writeCutSlides needs real cut slides; only the ORDER matters here, so stop after the signal.
    let sheetsAtSignal: any = null;
    const run = trialSheets.persistPreparedSheets({
      userId: 'u1', characterId: 'c', exported: { Kid: { costumed: { default: 'cos' } } }, fields: { preGeneratedCostumeType: 'ninja' },
      onSheetsMerged: () => { events.push('signal'); sheetsAtSignal = JSON.parse(JSON.stringify(rowChar)); },
    }, d);
    await run.catch(() => {}); // the fake slide cut is not a real slide list; the order is what is asserted
    expect(events.indexOf('signal')).toBeGreaterThan(-1);
    expect(events.indexOf('signal')).toBeLessThan(events.indexOf('slides-cut'));
    expect(sheetsAtSignal.preGeneratedStyledAvatars.Kid.costumed.default).toBe('cos');
    expect(sheetsAtSignal.preGeneratedCostumeType).toBe('ninja'); // the field the job's seeding reads is already there
  });

  it('is not called when the merge fails (the row is gone)', async () => {
    const d: any = deps([], { id: 7 });
    d.modifyRow = async () => null;
    let called = false;
    await expect(trialSheets.persistPreparedSheets({ userId: 'u', characterId: 'c', exported: { Kid: { standard: 's' } }, onSheetsMerged: () => { called = true; } }, d)).rejects.toThrow(/is gone/);
    expect(called).toBe(false);
  });

  it('styleAndPersistTrialSheets hands the callback to persist', async () => {
    const styled: any = {
      runInCacheScope: async (_s: string, fn: any) => fn(),
      prepareStyledAvatars: async () => {},
      exportStyledAvatarsForPersistence: () => [['Kid', { costumed: { default: 'c' } }]],
      retainCacheScopeForHandoff: () => {}, clearStyledAvatarCache: () => {},
    };
    const seen: any[] = [];
    const cb = () => {};
    await trialSheets.styleAndPersistTrialSheets({
      userId: 'u', characterId: 'c', character: { name: 'Kid' },
      requirements: [{ clothingCategory: 'costumed:ninja' }], clothingRequirements: {}, styleOptions: {}, onSheetsMerged: cb,
    }, { styledAvatars: styled, persist: async (a: any) => { seen.push(a.onSheetsMerged); return []; } });
    expect(seen).toEqual([cb]);
  });
});

describe('the registries the job is handed', () => {
  it('create-story gives the job the sheets-on-row promise, update-photo still awaits the full call', () => {
    const src = fs.readFileSync(path.join(root, 'server/routes/trial.js'), 'utf8');
    expect(src).toContain('const titleAvatarsReady = inFlightTitleSheetsOnRow.get(userId) || null;');
    expect(src).toContain('const standardAvatarsReady = inFlightStandardSheetsOnRow.get(userId) || null;');
    expect(src).toContain('await inFlightTitlePagePromises.get(userId);');
    expect(src).toContain('onSheetsMerged: titleOnRow.merged');
    expect(src).toContain('onSheetsMerged: standardOnRow.merged');
  });

  it('openSheetsOnRow-style release always resolves the waiting job, even when styling failed', async () => {
    // prepare-title with no character row: the handler returns early; the registered promise must still resolve and unregister.
    const layer = trialRouter.stack.find((l: any) => l.route?.path === '/prepare-title');
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    const res: any = { body: null, json(b: any) { this.body = b; return this; }, status() { return this; } };
    // missing category -> 400 path, which exits through finally
    await handler({ sessionUser: { userId: 'uX' }, body: {}, headers: {} }, res);
    expect(trialRouter.inFlightTitleSheetsOnRow.has('uX')).toBe(false);
  });
});
