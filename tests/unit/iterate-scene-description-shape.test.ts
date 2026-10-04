/**
 * EVERY IN-GENERATION ITERATE FAILED: "No scene description found for page N".
 *
 * Measured on staging job_1790277448294_5herh01j7: finalChecksReport.repairRounds
 * carries p7 and p14 iterate rounds with that error and no image. The repair
 * pipeline's story data handed iteratePageCore the raw `expandedScenes`, whose
 * brief is `sceneDescription`; iteratePageCore (like every reader of
 * `storyData.sceneDescriptions`) reads `description`. The covers-as-pages
 * change made the missing brief a throw.
 *
 * One shape: sceneMetadata.sceneDescriptionRecord projects a scene into the
 * stored record, and the pipeline uses it for the stored story AND the repair
 * story data.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require_ = createRequire(import.meta.url);
const { sceneDescriptionRecord } = require_('../../server/lib/sceneMetadata');
const { resolveIterateScene } = require_('../../server/lib/images');

// The shape generateStoryViaBeats returns per page (beatsPipeline.js).
const beatsScene = {
  pageNumber: 7,
  text: 'page text',
  sceneHint: 'hint',
  sceneDescription: 'A wide shot of the square. The main character kneels by the fountain.',
  sceneDescriptionModelId: 'model-x',
  characterClothing: { Hero: 'standard' },
  outlineExtract: 'PLAN: p7 — the main character — kneels by the fountain',
};

describe('the stored sceneDescriptions record', () => {
  it('carries the brief under `description`', () => {
    const rec = sceneDescriptionRecord(beatsScene, new Map([[7, 0]]));
    expect(rec.pageNumber).toBe(7);
    expect(rec.description).toBe(beatsScene.sceneDescription);
    expect(rec.outlineExtract).toBe(beatsScene.outlineExtract);
    expect(rec.characterClothing).toEqual({ Hero: 'standard' });
    expect(rec.scenePromptRef).toBe(0);
    expect(rec.textModelId).toBe('model-x');
    expect(rec).not.toHaveProperty('sceneDescription');
  });

  it('has no prompt ref when none is known', () => {
    expect(sceneDescriptionRecord(beatsScene).scenePromptRef).toBeNull();
  });
});

describe('iterate resolves the brief from the pipeline story data', () => {
  it('a page resolves from the projected records', () => {
    const storyData = { sceneDescriptions: [beatsScene].map(s => sceneDescriptionRecord(s)) };
    const scene = resolveIterateScene(storyData, 7);
    expect(scene.description).toBe(beatsScene.sceneDescription);
    expect(scene.outlineExtract).toBe(beatsScene.outlineExtract);
  });

  it('a raw generation scene is not the stored shape and is refused loudly', () => {
    expect(() => resolveIterateScene({ sceneDescriptions: [beatsScene] }, 7))
      .toThrow('No scene description found for page 7');
  });

  it('a full-story cover resolves from its coverImages record', () => {
    const coverRecord = { sceneDescription: 'The cover brief.', outlineExtract: 'PLAN: cover' };
    const scene = resolveIterateScene({ sceneDescriptions: [] }, -1, coverRecord);
    expect(scene).toEqual({ pageNumber: -1, description: 'The cover brief.', outlineExtract: 'PLAN: cover' });
  });
});

describe('storyJobPipeline hands the repair pipeline the stored shape', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'storyJobPipeline.js'), 'utf8');

  it('never passes the raw expandedScenes as sceneDescriptions', () => {
    expect(src).not.toMatch(/sceneDescriptions:\s*expandedScenes\s*,/);
  });

  it('projects both the stored story and the repair story data with sceneDescriptionRecord', () => {
    expect(src).toMatch(/allSceneDescriptions = expandedScenes\.map\(scene => sceneDescriptionRecord\(/);
    expect(src).toMatch(/sceneDescriptions: expandedScenes\.map\(scene => sceneDescriptionRecord\(/);
  });
});
