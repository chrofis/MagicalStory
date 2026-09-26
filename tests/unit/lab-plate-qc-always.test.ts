/**
 * The Test Lab judges every plate the way the story run does (2026-09-26).
 *
 * runEmptySceneStage skipped the whole plate QC when the story had no text
 * zone and reported `{ pass: true, skipped: 'no text zone (text-below layout)' }`.
 * Every level has been text-below since 2026-09-05, so every Lab empty_scene
 * run since then showed a fake pass. The story run judges its vantage plates
 * with textPosition null (storyJobPipeline.js validateEmptyScene(plate, null, …)).
 * edit_image on a plate replays the plate derive and never ran the QC the run
 * gives a derived plate either.
 *
 * Only the network and DB boundaries are stubbed. No paid call is made.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const images = require_('../../server/lib/images');
const database = require_('../../server/services/database');
const referenceSheets = require_('../../server/lib/referenceSheets');

let qcCalls: any[] = [];
images.generateImageOnly = async () => ({ imageData: PX, modelId: 'stub-plate-model' });
images.editImageWithPrompt = async () => ({ imageData: PX, usage: { model: 'stub-edit-model' } });
images.validateEmptyScene = async (img: string, textPosition: any, label: string, opts: any) => {
  qcCalls.push({ textPosition, label, opts });
  return { pass: false, issues: ['stub issue'], findings: [{ check: 'x', issue: 'stub issue' }], visionFeedback: 'stub' };
};
database.getNextVersionIndex = async () => 7;
database.saveStoryImage = async () => {};
database.dbQuery = async () => [{ image_data: PX, image_url: null }];
database.getActiveVersion = async () => 0;
database.getStoryImage = async () => ({ image_data: PX, image_url: null, version_index: 0 });
referenceSheets.buildEmptySceneVbGrid = async () => null;

const { runEmptySceneStage, runEditImageStage } = require_('../../server/lib/testlab');

const ctx = (over: any = {}) => ({
  storyId: 'job_test', pageNumber: 3,
  scene: {
    sceneDescription: 'The hero crosses the courtyard toward the gate.',
    sceneMetadata: {
      emptyScenePrompt: 'A cobbled courtyard with a stone gate at the back.',
      era: 'present day',
      fullData: { shot: 'wide', characters: [{ name: 'Hero', position: 'left', depth: 'midground' }] },
    },
  },
  layout: { mode: 'square-below', textInImage: false },
  textPosition: 'top-left',
  visualBible: null, landmarkPhotos: [], artStyle: 'watercolor', languageLevel: 'standard',
  clothingRequirements: { Hero: { costumed: { used: true, costume: 'knight' } } },
  storyTheme: 'castle', storyTopic: '', storyType: 'adventure',
  ...over,
});

beforeEach(() => { qcCalls = []; });

describe('empty_scene stage runs the plate QC on a text-below story', () => {
  it('judges the plate with a null text position and reports the real verdict', async () => {
    const r = await runEmptySceneStage(ctx(), { experimentId: 1, params: {} });
    expect(qcCalls).toHaveLength(1);
    expect(qcCalls[0].textPosition).toBeNull();
    expect(r.qc.pass).toBe(false);
    expect(r.qc.issues).toEqual(['stub issue']);
    expect(r.qc.skipped).toBeUndefined();
  });

  it('sends the per-page plate QC option set', async () => {
    await runEmptySceneStage(ctx(), { experimentId: 1, params: {} });
    const o = qcCalls[0].opts;
    // EXPECTED SCENE is what the author got besides the plate text, which
    // rides whole as FRAMING (decisions.md 2026-09-26): nothing said twice.
    expect(o.sceneDescription).toBe('**SHOT:** wide');
    expect(o.characterPlacements).toEqual([{ name: 'Hero', position: 'left', depth: 'midground' }]);
    expect(o.mainScenePrompt).toBe('The hero crosses the courtyard toward the gate.');
    // The brief's era, as its plate author's era guard reads it — never the
    // costume (a knight costume on a present-day page is not a period).
    expect(o.era).toBe('present day');
    expect(o.storyEra).toBeUndefined();
    // The plate text rides whole as the FRAMING.
    expect(o.framing).toBe('A cobbled courtyard with a stone gate at the back.');
    expect(o.artStyle).toMatch(/watercolor/i);
    expect(o.shot).toBe('wide');
    expect(o.pageNumber).toBe(3);
    expect(o.landmarkPhoto).toBeNull();
    // No bible, no staged structure, no grid.
    expect(o.structures).toBe('');
    expect(o.structureGrid).toBeNull();
  });

  it('hands the QC the STRUCTURES text and the grid the plate call carried', async () => {
    const grid = Buffer.from('grid-bytes');
    const saved = referenceSheets.buildEmptySceneVbGrid;
    referenceSheets.buildEmptySceneVbGrid = async () => grid;
    try {
      const visualBible = { vehicles: [{ id: 'VEH001', name: 'Red cart', description: 'A red wooden hand cart with two iron-rimmed wheels.', referenceImageData: PX }] };
      const c = ctx({ visualBible });
      c.scene.sceneMetadata = { ...c.scene.sceneMetadata, objects: ['VEH001'] };
      await runEmptySceneStage(c, { experimentId: 1, params: {} });
      const o = qcCalls[0].opts;
      expect(o.structures).toContain('A red wooden hand cart with two iron-rimmed wheels.');
      // The same builder the plate prompt's STRUCTURES block comes from.
      const { buildPlateStructuresText } = require_('../../server/services/prompts');
      expect(o.structures).toBe(buildPlateStructuresText({ visualBible, pageNumber: 3, aboardId: null, sceneObjects: ['VEH001'] }));
      expect(o.structureGrid).toBe(grid);
    } finally {
      referenceSheets.buildEmptySceneVbGrid = saved;
    }
  });

  it('an overlay story is judged on its text zone', async () => {
    await runEmptySceneStage(ctx({ layout: { mode: 'a4-overlay', textInImage: true } }), { experimentId: 1, params: {} });
    expect(qcCalls[0].textPosition).toBe('top-left');
  });
});

describe('edit_image on a plate runs the derived-plate QC', () => {
  it('judges the edited plate: no text zone, its camera class, no page geometry', async () => {
    const r = await runEditImageStage(ctx({ scene: { ...ctx().scene, sceneMetadata: { ...ctx().scene.sceneMetadata, fullData: { shot: 'aerial', characters: [] } } } }),
      { experimentId: 2, params: { source: 'empty_scene', instruction: 'Raise the camera.' } });
    expect(qcCalls).toHaveLength(1);
    expect(qcCalls[0].textPosition).toBeNull();
    const o = qcCalls[0].opts;
    // No vantage: a per-page plate's author gets no setting text besides its
    // plate text, which is not a derive's FRAMING either.
    expect(o.sceneDescription).toBe('');
    expect(o.shot).toBe('aerial');
    expect(o.characterPlacements).toBeNull();
    expect(o.mainScenePrompt).toBeNull();
    // A derive moves the camera: no FRAMING, as the story run's derived plate.
    expect(o.framing).toBeNull();
    expect(r.qc.pass).toBe(false);
  });

  it('an edit of the page image is not a plate and gets no plate QC', async () => {
    const r = await runEditImageStage(ctx(), { experimentId: 3, params: { instruction: 'x' } });
    expect(r.imageType).toBe('scene');
    expect(qcCalls).toHaveLength(0);
    expect(r.qc).toBeUndefined();
  });
});
