import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { assertReviewedArtifactUsable, pickReviewedBrief } = require('../../server/lib/sceneReviewGuard.js');

// Builds a stored beats_scenes result in the shape the stage writes (the first
// reviewer on `reviewedBrief`, further ones under `reviewedBriefs[model]`) — the
// shape pickReviewedBrief reads. Since 2026-09-27 the stage fills it from the
// run's own review (beatsPipeline.runSceneReview, deleted 2026-09-28; stored
// experiments keep this shape).
function applyReviewerPages(sceneExpansions: any[], sceneReviews: any[]) {
  sceneReviews.forEach((r, i) => {
    if (!r || r.ok === false || !Array.isArray(r._pages)) return;
    const byPage = new Map(r._pages.map((x: any) => [x.pageNumber, x.text]));
    for (const x of sceneExpansions) {
      const fixed = byPage.get(x.pageNumber);
      if (!fixed) continue;
      if (i === 0) { x.reviewedBrief = fixed; x.reviewRewrote = true; }
      else { (x.reviewedBriefs = x.reviewedBriefs || {})[r.modelKey] = fixed; }
    }
  });
  for (const r of sceneReviews) if (r) delete r._pages;
}

describe('assertReviewedArtifactUsable — hazard count refuses a failed review', () => {
  it('throws with the stored reason when sceneReview.ok === false', () => {
    const out = { sceneReview: { ok: false, error: 'scene review returned an EMPTY response (16000 output tokens)' } };
    expect(() => assertReviewedArtifactUsable(out, 1109)).toThrow(/fromExperiment 1109: artifact 'reviewed' refused .*EMPTY response \(16000 output tokens\)/);
  });
  it('passes a healthy or legacy (pre-guard) result', () => {
    expect(() => assertReviewedArtifactUsable({ sceneReview: { ok: true } }, 1)).not.toThrow();
    expect(() => assertReviewedArtifactUsable({ sceneReview: { modelKey: 'x' } }, 1)).not.toThrow();
    expect(() => assertReviewedArtifactUsable({}, 1)).not.toThrow();
  });
});

describe('multi-reviewer fan-out retention + judge selector', () => {
  function fanOut() {
    const pages = [
      { pageNumber: 1, fromBeats: 'raw1' },
      { pageNumber: 2, fromBeats: 'raw2' },
      { pageNumber: 3, fromBeats: 'raw3' },
    ];
    const reviews = [
      { modelKey: 'deepseek-v4-pro', ok: true, _pages: [{ pageNumber: 1, text: 'ds1' }, { pageNumber: 2, text: 'ds2' }] },
      { modelKey: 'grok-4.6', ok: true, _pages: [{ pageNumber: 2, text: 'gk2' }, { pageNumber: 3, text: 'gk3' }] },
      { modelKey: 'gemini-3.1-pro', ok: true, _pages: [{ pageNumber: 1, text: 'gm1' }] },
      { modelKey: 'gpt-5.6-sol', ok: false, error: 'scene review returned an EMPTY response (3899 output tokens)', _pages: [] },
    ];
    applyReviewerPages(pages, reviews);
    return { pages, out: { sceneExpansions: pages, sceneReviews: reviews, sceneReview: reviews[0] } };
  }

  it('retains 3 successful reviewers: primary in reviewedBrief, others in reviewedBriefs, failed one absent', () => {
    const { pages, out } = fanOut();
    expect(pages[0]).toMatchObject({ reviewedBrief: 'ds1', reviewRewrote: true, reviewedBriefs: { 'gemini-3.1-pro': 'gm1' } });
    expect(pages[1]).toMatchObject({ reviewedBrief: 'ds2', reviewedBriefs: { 'grok-4.6': 'gk2' } });
    expect(pages[2].reviewedBrief).toBeUndefined();
    expect(pages[2].reviewedBriefs).toEqual({ 'grok-4.6': 'gk3' });
    // primary is never duplicated into reviewedBriefs; failed reviewer stores nothing
    for (const p of pages) {
      expect(p.reviewedBriefs?.['deepseek-v4-pro']).toBeUndefined();
      expect(p.reviewedBriefs?.['gpt-5.6-sol']).toBeUndefined();
    }
    for (const r of out.sceneReviews) expect((r as any)._pages).toBeUndefined();
  });

  it('judge with params.reviewer picks that reviewer set (falls to fromBeats only on pages it did not rewrite)', () => {
    const { pages, out } = fanOut();
    expect(pages.map(p => pickReviewedBrief(p, out, 'grok-4.6', 7))).toEqual(['raw1', 'gk2', 'gk3']);
    expect(pages.map(p => pickReviewedBrief(p, out, 'gemini-3.1-pro', 7))).toEqual(['gm1', 'raw2', 'raw3']);
    expect(pages.map(p => pickReviewedBrief(p, out, 'deepseek-v4-pro', 7))).toEqual(['ds1', 'ds2', 'raw3']);
  });

  it('judge refuses a FAILED reviewer and an ABSENT reviewer with a clear error — never the primary silently', () => {
    const { pages, out } = fanOut();
    expect(() => pickReviewedBrief(pages[0], out, 'gpt-5.6-sol', 7)).toThrow(/reviewer "gpt-5.6-sol" FAILED .*EMPTY response/);
    expect(() => pickReviewedBrief(pages[0], out, 'qwen3.8-max', 7)).toThrow(/reviewer "qwen3.8-max" did not run .*deepseek-v4-pro, grok-4.6/);
  });

  it('no-reviewer path is unchanged: primary reviewedBrief || fromBeats', () => {
    const { pages, out } = fanOut();
    expect(pages.map(p => pickReviewedBrief(p, out, null, 7))).toEqual(['ds1', 'ds2', 'raw3']);
  });

  it('a failed PRIMARY leaves every reviewedBrief null and rewrote nothing', () => {
    const pages = [{ pageNumber: 1, fromBeats: 'raw1' }];
    const reviews = [{ modelKey: 'deepseek-v4-pro', ok: false, error: 'TRUNCATED', rewrotePages: [], _pages: [] }];
    applyReviewerPages(pages, reviews);
    expect(pages[0]).toEqual({ pageNumber: 1, fromBeats: 'raw1' });
    expect(() => assertReviewedArtifactUsable({ sceneReview: reviews[0] }, 9)).toThrow(/TRUNCATED/);
  });
});

describe('testlab.js source — no hard numeric output caps, guard wired', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../server/lib/testlab.js'), 'utf8');
  it('every callStream/callTextModelStreaming passes null (model max) as maxTokens', () => {
    const calls = src.match(/call(?:Stream|TextModelStreaming)\([^;]*?,\s*(\d+)\s*,\s*(?:null|\(\)|\w)/g) || [];
    expect(calls).toEqual([]);
  });
  it('the hazard count reads a stored review artifact through the guards', () => {
    expect(src).toMatch(/assertReviewedArtifactUsable\(out, expId\)/);
    expect(src).toMatch(/pickReviewedBrief\(x, out, reviewer, expId\)/);
  });
  it('beats_scenes stores a re-asked page\'s taken brief in the shape the page view reads', () => {
    // The run's brief re-ask replaced the review arms in beats_scenes (2026-09-28).
    expect(src).toContain("if (taken) { x.reviewedBrief = taken.after; x.reviewRewrote = true; x.rewrittenBy = 'brief re-ask'; }");
  });
});
