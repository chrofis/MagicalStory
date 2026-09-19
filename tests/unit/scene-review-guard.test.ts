import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { assessSceneReview, assertReviewedArtifactUsable, pickReviewedBrief } = require('../../server/lib/sceneReviewGuard.js');

// Same shape as testlab.js's applyReviewerPages (kept in sync by the
// source-level test below, which pins the function body).
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

const goodText = 'ANALYSIS\n' + 'x'.repeat(3000) + '\n---SCENES---\nPAGE 1\nrewritten';

describe('assessSceneReview — truncation guard', () => {
  it('marks an empty response FAILED (exp 1109/1121: 0 chars at out=16000; #920: 0 chars, no cap hit)', () => {
    expect(assessSceneReview({ text: '', outputTokens: 16000, capInForce: 16000, parsedPageCount: 0 }))
      .toMatchObject({ ok: false, error: expect.stringMatching(/EMPTY/) });
    expect(assessSceneReview({ text: '   \n', outputTokens: 3899, capInForce: 64000, parsedPageCount: 0 }).ok).toBe(false);
  });

  it('marks a cap hit FAILED even when text and pages came back (exp 1122/1124: cut mid-output at the cap)', () => {
    const v = assessSceneReview({ text: goodText, outputTokens: 16000, capInForce: 16000, parsedPageCount: 5 });
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/TRUNCATED/);
    expect(v.error).toMatch(/16000/);
  });

  it('uses the provider finish reason when exposed', () => {
    const v = assessSceneReview({ text: goodText, outputTokens: 9000, stopReason: 'max_tokens', capInForce: 64000, parsedPageCount: 5 });
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/stop_reason=max_tokens/);
  });

  it('passes a completed review under the cap (exp 1110: 9391 tokens; 1123: 13809)', () => {
    expect(assessSceneReview({ text: goodText, outputTokens: 9391, stopReason: 'end_turn', capInForce: 64000, parsedPageCount: 17 }))
      .toEqual({ ok: true, error: null });
    expect(assessSceneReview({ text: goodText, outputTokens: 13809, capInForce: 64000, parsedPageCount: 14 }).ok).toBe(true);
  });

  it('marks a long response with zero parsed pages FAILED (format failure), but not a short "no faults" verdict', () => {
    expect(assessSceneReview({ text: 'A'.repeat(5000), outputTokens: 2000, capInForce: 64000, parsedPageCount: 0 }).ok).toBe(false);
    expect(assessSceneReview({ text: 'All pages pass. No changes.', outputTokens: 20, capInForce: 64000, parsedPageCount: 0 }).ok).toBe(true);
  });
});

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
  it('scene review call is uncapped and runs the guard; hazard count uses the selector', () => {
    expect(src).toMatch(/callStream\(srPrompt, null, null, srModel/);
    expect(src).toMatch(/assessSceneReview\(\{/);
    expect(src).toMatch(/assertReviewedArtifactUsable\(out, expId\)/);
    expect(src).toMatch(/pickReviewedBrief\(x, out, reviewer, expId\)/);
  });
  it('applyReviewerPages in testlab.js matches the copy under test', () => {
    const body = src.match(/function applyReviewerPages\(sceneExpansions, sceneReviews\) \{[\s\S]*?\n\}/)![0];
    expect(body).toContain("if (!r || r.ok === false || !Array.isArray(r._pages)) return;");
    expect(body).toContain("if (i === 0) { x.reviewedBrief = fixed; x.reviewRewrote = true; }");
    expect(body).toContain("else { (x.reviewedBriefs = x.reviewedBriefs || {})[r.modelKey] = fixed; }");
  });
});
