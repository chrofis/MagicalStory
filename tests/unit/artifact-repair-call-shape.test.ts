/**
 * The production artifact-repair route and the Lab's artifact_repair stage
 * call grid repair through ONE helper, testlab.gridRepairStoredPage, which
 * hands gridBasedRepair its real contract:
 *   (imageData, pageNumber, {quality, incremental, final}, {outputDir, storyId, ...})
 *
 * Before 2026-10-07 the route called gridBasedRepair(scene, {retryHistory}) —
 * gridBasedRepair.js throws "outputDir is required" for that, so the route
 * failed on every page it was asked to repair (found by code read, backlog).
 * Sibling set lab-vs-prod-artifact-repair.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';

const req = createRequire(import.meta.url);
const ROOT = path.join(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const gridModule = req('../../server/lib/gridBasedRepair');
const { gridRepairStoredPage, storedEvalFromScene } = req('../../server/lib/testlab');

const PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// A stored scene as the route sees it after rehydrateStoryImages: the score on
// the imageVersions entries (new pipeline), fixTargets / bboxDetection / the
// reasoning at the scene root — the fields storedEvalFromScene reads.
const FIX_TARGETS = [{ type: 'extra_limb', bbox: [0.2, 0.3, 0.3, 0.4] }];
const scene: any = {
  pageNumber: 4,
  imageData: PX,
  retryHistory: [{ attempt: 1 }],
  bboxDetection: { figures: [{ name: 'Mia', bbox: [0.1, 0.1, 0.4, 0.9] }] },
  imageVersions: [{ type: 'original', evalScore: 71 }],
  fixTargets: FIX_TARGETS,
  qualityReasoning: 'one extra limb',
};

let calls: any[] = [];
const realGrid = gridModule.gridBasedRepair;
const RESULT = { imageData: Buffer.from('repaired'), repaired: true, fixedCount: 1, failedCount: 0, totalIssues: 1, history: { totalAttempts: 1 }, annotatedOriginal: null, grids: [] };

beforeEach(() => {
  calls = [];
  // gridRepairStoredPage destructures the export at call time, so the live
  // module field is the seam — no network, no sharp, no tmp grids.
  gridModule.gridBasedRepair = async (...args: any[]) => { calls.push(args); return RESULT; };
});
afterEach(() => { gridModule.gridBasedRepair = realGrid; });

describe('gridRepairStoredPage hands gridBasedRepair its real contract', () => {
  it('(imageData, pageNumber, evalResults, {outputDir, storyId, bboxDetection, ...})', async () => {
    const out = await gridRepairStoredPage(PX, 4, scene, 'job_test_1');
    expect(out).toBe(RESULT);
    expect(calls).toHaveLength(1);
    const [imageData, pageNum, evalResults, options] = calls[0];

    expect(imageData).toBe(PX);
    expect(pageNum).toBe(4);

    expect(evalResults).toEqual({
      quality: { score: 71, fixTargets: FIX_TARGETS, reasoning: 'one extra limb', matches: [] },
      incremental: null,
      final: null,
    });
    expect(evalResults.quality.score).toBe(storedEvalFromScene(scene).finalScore);

    expect(typeof options.outputDir).toBe('string');
    expect(options.outputDir).toContain('job_test_1');
    expect(fs.existsSync(options.outputDir)).toBe(true);
    expect(options.storyId).toBe('job_test_1');
    expect(options.bboxDetection).toBe(scene.bboxDetection);
    expect(options.skipVerification).toBe(false);
    expect(options.saveIntermediates).toBe(false);
    // The old route's shape is gone: no scene object, no retryHistory option.
    expect(options).not.toHaveProperty('retryHistory');
  });

  it('a page without an image stops loudly instead of handing gridBasedRepair nothing', async () => {
    await expect(gridRepairStoredPage(null, 4, scene, 'job_test_1')).rejects.toThrow(/No image to repair/);
    expect(calls).toHaveLength(0);
  });
});

describe('both callers go through the helper (source scan)', () => {
  const ROUTE = read('server/routes/regeneration.js');
  const LAB = read('server/lib/testlab.js');

  it('the production route repairs the rehydrated scene image through gridRepairStoredPage', () => {
    const at = ROUTE.indexOf("'/:id/repair-workflow/artifact-repair'");
    expect(at).toBeGreaterThan(-1);
    const body = ROUTE.slice(at, at + 6000);
    expect(body).toMatch(/gridRepairStoredPage\(scene\.imageData, pageNumber, scene, id\)/);
    expect(body).not.toMatch(/gridBasedRepair\(scene/);
  });

  it('the Lab artifact_repair stage calls the same helper', () => {
    const at = LAB.indexOf('async function runArtifactRepairStage');
    expect(at).toBeGreaterThan(-1);
    expect(LAB.slice(at, at + 800)).toMatch(/gridRepairStoredPage\(imageData, ctx\.pageNumber, ctx\.scene, ctx\.storyId\)/);
    // gridBasedRepair is called from the helper only.
    const code = LAB.split('\n').filter((l) => !/^\s*(\*|\/\/)/.test(l)).join('\n');
    expect(code.match(/\bgridBasedRepair\(/g)).toHaveLength(1);
  });
});
