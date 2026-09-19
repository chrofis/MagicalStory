import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fs = require('node:fs');
const { COVER_EVAL_MIRROR_FIELDS, applyCoverEvalMirror } = require('../../server/lib/coverEvalMirror.js');

// REAL staging records (job_1789348171785_9oxos7dwv, pulled 2026-09-14): one
// sceneImages[0] record and the frontCover record of the SAME story, image
// bytes stripped. The page carries 18 eval fields, the cover root 10 — the
// eight-field gap is the bug this pins.
const fixture = JSON.parse(fs.readFileSync(
  new URL('./fixtures/cover-eval-mirror-job_1789348171785_9oxos7dwv.json', import.meta.url),
  'utf8',
));

// Fields the page mapping stamps that are NOT evaluation records: routing
// flags and the page's own identity. Everything else a page carries must be
// mirrored onto a cover, or the two surfaces store different evidence.
const NOT_EVAL_FIELDS = new Set(['pageNumber', 'wasRegenerated', 'wasCharacterFixed']);

describe('cover eval mirror — a cover stores the same eval record a page does', () => {
  it('the stored fixture still shows the gap this mirror closes', () => {
    // Guards the fixture itself: if someone re-pulls it from a story generated
    // AFTER this fix, the assertions below stop proving anything.
    expect(fixture.page.threeStageResult).toBeTruthy();
    expect(fixture.coverRoot.threeStageResult).toBeUndefined();
  });

  it('carries the compliance verdict a cover root has never stored', () => {
    const cover: any = { imageData: 'data:image/jpeg;base64,x', description: 'front cover' };
    applyCoverEvalMirror(cover, fixture.page);
    // Before the fix the write-back had no threeStageResult line at all, so
    // this was undefined on every cover of every story.
    expect(cover.threeStageResult).toEqual(fixture.page.threeStageResult);
    expect(cover.threeStageResult.score).toBe(fixture.page.threeStageResult.score);
    expect(cover.qualityRawOutput).toBe(fixture.page.qualityRawOutput);
    expect(cover.evalTemplateHash).toBe(fixture.page.evalTemplateHash);
    expect(cover.identityAgreement).toEqual(fixture.page.identityAgreement);
    expect(cover.unrepairedCritical).toEqual(fixture.page.unrepairedCritical ?? null);
  });

  it('keeps every field the old hand-listed block already copied', () => {
    const cover: any = {};
    applyCoverEvalMirror(cover, fixture.page);
    for (const f of ['qualityScore', 'finalScore', 'qualityReasoning', 'fixTargets',
      'fixableIssues', 'semanticResult', 'semanticScore', 'issuesSummary',
      'bboxDetection', 'bboxOverlayImage']) {
      expect(cover[f]).toEqual(fixture.page[f] ?? null);
    }
  });

  it('never touches the cover-specific fields the caller owns', () => {
    const cover: any = { imageData: 'BYTES', imageVersions: [{ v: 1 }], titleBaked: true, prompt: 'p' };
    applyCoverEvalMirror(cover, fixture.page);
    expect(cover.imageData).toBe('BYTES');
    expect(cover.imageVersions).toEqual([{ v: 1 }]);
    expect(cover.titleBaked).toBe(true);
    expect(cover.prompt).toBe('p');
    expect(cover.pageNumber).toBeUndefined();
  });

  it('clears a previous round instead of leaving a stale finding', () => {
    const cover: any = { fixableIssues: [{ type: 'extra_character' }], threeStageResult: { score: 10 } };
    applyCoverEvalMirror(cover, { qualityScore: 88 });
    expect(cover.fixableIssues).toBeNull();
    expect(cover.threeStageResult).toBeNull();
    expect(cover.qualityScore).toBe(88);
  });

  it('DRIFT GUARD: no eval field a real page record carries is missing from the mirror', () => {
    const missing = Object.keys(fixture.page)
      .filter(k => !NOT_EVAL_FIELDS.has(k))
      .filter(k => !COVER_EVAL_MIRROR_FIELDS.includes(k));
    expect(missing).toEqual([]);
  });
});

describe('wiring guard — the cover write-back cannot go hand-listed again', () => {
  const pipeline = fs.readFileSync(new URL('../../storyJobPipeline.js', import.meta.url), 'utf8');

  it('the pipeline mirrors through the shared helper', () => {
    expect(pipeline).toContain('applyCoverEvalMirror(coverImages[coverKey], img)');
  });

  it('no per-field cover eval assignment survives', () => {
    for (const f of ['qualityScore', 'finalScore', 'semanticResult', 'fixableIssues', 'threeStageResult']) {
      expect(pipeline).not.toMatch(new RegExp(`coverImages\\[coverKey\\]\\.${f}\\s*=`));
    }
  });
});
