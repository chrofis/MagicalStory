import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { detectionForRetryEntry } = require_('../../server/lib/repairLogic.js');

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

// ONE DETECTION PER VERSION (2026-09-21, finding D3).
//
// Measured on job_1789853503332_riqncqg1i (8.59 MB stored): the same detection
// object sat on the scene (152 KB), on imageVersions[] (147 KB) and on
// retryHistory[] (147 KB). A retry entry IS a version of the page, so the third
// copy is replaced by a link — `versionIndex` — and the detection is read off
// the version. Stories written before this keep their own copy, and the
// resolver still accepts it, so no stored row has to be rewritten.
describe('retryHistory carries a link to its version, not a third detection copy', () => {
  it('the writer stamps versionIndex and no bboxDetection', () => {
    const rp = read('../../server/lib/repairPipeline.js');
    const block = rp.slice(rp.indexOf('const retryHistory = versions.map('),
                           rp.indexOf('const retryHistory = versions.map(') + 900);
    expect(block).toContain('versionIndex: idx,');
    expect(block).not.toContain('bboxDetection: images().detectionForVersion(v)');
  });

  it('resolves the detection off the linked version', () => {
    const scene = {
      imageVersions: [{ bboxDetection: { figures: ['v0'] } }, { bboxDetection: { figures: ['v1'] } }],
    };
    expect(detectionForRetryEntry(scene, { attempt: 2, versionIndex: 1 })).toEqual({ figures: ['v1'] });
    expect(detectionForRetryEntry(scene, { attempt: 1, versionIndex: 0 })).toEqual({ figures: ['v0'] });
  });

  it('still reads a pre-2026-09-21 entry that carries its own copy', () => {
    const scene = { imageVersions: [{ bboxDetection: { figures: ['fromVersion'] } }] };
    const legacy = { attempt: 1, bboxDetection: { figures: ['legacy'] } };
    expect(detectionForRetryEntry(scene, legacy)).toEqual({ figures: ['legacy'] });
  });

  it('falls back to attempt-1 when an old entry has neither', () => {
    const scene = { imageVersions: [{ bboxDetection: { figures: ['v0'] } }] };
    expect(detectionForRetryEntry(scene, { attempt: 1 })).toEqual({ figures: ['v0'] });
  });

  it('returns null rather than guessing when nothing links', () => {
    expect(detectionForRetryEntry({}, { source: 'x' })).toBeNull();
    expect(detectionForRetryEntry({ imageVersions: [] }, null)).toBeNull();
  });

  it('the merge path never nulls a version detection from a legacy-less entry', () => {
    const stories = read('../../server/routes/stories.js');
    expect(stories).toContain('if (retryEntry?.bboxDetection && !scene.imageVersions[i].fixTargets?.length) {');
    expect(stories).not.toContain('= retryEntry.bboxDetection || null;');
  });
});
