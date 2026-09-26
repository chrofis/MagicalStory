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
const { plateStoryEra } = require_('../../server/lib/plateQc');

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

describe('plateStoryEra (one derivation for every plate QC)', () => {
  it('a costume is the period, qualified by the story', () => {
    expect(plateStoryEra({ A: { costumed: { used: true, costume: 'knight' } } }, { storyTheme: 'castle', storyType: 'adventure' }))
      .toBe('knight (castle / adventure)');
  });
  it('no costume is no era — the brief era is not used', () => {
    expect(plateStoryEra({ A: { standard: { used: true } } }, { storyTheme: 'dragon' })).toBeNull();
    expect(plateStoryEra(null, {})).toBeNull();
  });
});

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
    expect(o.sceneDescription).toBe('**SHOT:** wide\n\nA cobbled courtyard with a stone gate at the back.');
    expect(o.characterPlacements).toEqual([{ name: 'Hero', position: 'left', depth: 'midground' }]);
    expect(o.mainScenePrompt).toBe('The hero crosses the courtyard toward the gate.');
    expect(o.storyEra).toBe('knight (castle / adventure)');
    expect(o.artStyle).toMatch(/watercolor/i);
    expect(o.shot).toBe('wide');
    expect(o.pageNumber).toBe(3);
    expect(o.landmarkPhoto).toBeNull();
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
    expect(o.sceneDescription).toBe('A cobbled courtyard with a stone gate at the back.');
    expect(o.shot).toBe('aerial');
    expect(o.characterPlacements).toBeNull();
    expect(o.mainScenePrompt).toBeNull();
    expect(r.qc.pass).toBe(false);
  });

  it('an edit of the page image is not a plate and gets no plate QC', async () => {
    const r = await runEditImageStage(ctx(), { experimentId: 3, params: { instruction: 'x' } });
    expect(r.imageType).toBe('scene');
    expect(qcCalls).toHaveLength(0);
    expect(r.qc).toBeUndefined();
  });
});
