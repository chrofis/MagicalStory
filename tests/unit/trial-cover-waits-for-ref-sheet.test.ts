/**
 * The trial cover renders with the reference cells of the VB elements it shows.
 * job_1791500208126_at0wow7xa: cover drawn at 00:58:50, sheet finished 00:59:29,
 * so the toy owl had no cell and was drawn as a live bird. The trial pages await
 * trialReferenceSheetPromise before building their grid; the cover did not.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require_ = createRequire(import.meta.url);
const coverIterate = require_('../../server/lib/coverIterate.js');
const { TRIAL_COSTUMES } = require_('../../server/config/trialCostumes.js');
const src = fs.readFileSync(path.resolve(__dirname, '../../storyJobPipeline.js'), 'utf8');

describe('trial cover waits for the early VB reference sheet', () => {
  const start = src.indexOf('onCoverScene: (coverData) =>');
  const body = src.slice(start, src.indexOf('onCoverHints:', start));
  it('awaits the sheet promise before the name invariant and the reference build', () => {
    const wait = body.indexOf('await trialReferenceSheetPromise');
    expect(wait).toBeGreaterThan(-1);
    expect(wait).toBeLessThan(body.indexOf('reconcileTrialCoverEntities({'));
    expect(wait).toBeLessThan(body.indexOf('buildTrialCoverReferences({'));
    expect(wait).toBeLessThan(body.indexOf('generateImageOnly('));
  });
  it('the cover element grid carries a cell only once the sheet has filled the entry', async () => {
    const mk = (withCell: boolean) => ({
      artifacts: [{ id: 'ART001', name: 'soft toy owl', description: 'toy owl', ...(withCell ? { referenceImageData: 'data:image/jpeg;base64,OWLCELL' } : {}) }],
      locations: [],
    });
    const args = (vb: any) => ({
      coverKey: 'frontCover', visualBible: vb, artStyle: 'watercolor', sceneDescription: 'Hoot the owl',
      coverHint: { objects: ['ART001'], characters: [] }, sceneMetadata: { objects: ['ART001'], characters: [] },
      sceneBackground: 'data:image/jpeg;base64,PLATE',
    });
    const refSheets = require_('../../server/lib/referenceSheets.js');
    const orig = refSheets.buildVisualBibleGrid;
    const seen: string[][] = [];
    refSheets.buildVisualBibleGrid = async (els: any[]) => { seen.push(els.map(e => e.id)); return 'GRID'; };
    try {
      const before = await coverIterate.buildCoverReferences(args(mk(false)));
      const after = await coverIterate.buildCoverReferences(args(mk(true)));
      expect(before.visualBibleGrid).toBeFalsy();
      expect(after.visualBibleGrid).toBe('GRID');
      expect(seen).toEqual([['ART001']]);
    } finally { refSheets.buildVisualBibleGrid = orig; }
  });
});

describe('trial costume headwear is stated, never left to the model', () => {
  it('wizard names a hat shape and colour; other adventure costumes say hat/helmet or none', () => {
    for (const g of ['male', 'female'] as const) {
      expect(TRIAL_COSTUMES.adventure.wizard[g]).toMatch(/pointed (deep )?(blue|purple) wizard hat/);
    }
    for (const theme of ['pirate', 'knight', 'cowboy', 'ninja', 'viking', 'samurai', 'detective', 'wizard']) {
      for (const g of ['male', 'female'] as const) {
        expect(TRIAL_COSTUMES.adventure[theme][g], theme + '/' + g).toMatch(/\b(hat|helmet|hood)\b/i);
      }
    }
  });
});
