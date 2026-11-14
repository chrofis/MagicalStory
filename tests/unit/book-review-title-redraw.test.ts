import { describe, it, expect, vi } from 'vitest';

// Bug cover-title-typo-shipped-after-failed-redraw (staging job_1793526073039_9nhq3ju59, 2026-11-01): the review read
// "répétaire" on the front cover in all three rounds; the one redraw garbled the title again, the review kept the
// original, round 2 never retried, and the book shipped the typo. Owner: "retry the title until right".
const { redrawTitle, hasTitleFault, runBookReviewRounds } = require('../../server/lib/bookReview.js');
const fs = require('fs');
const path = require('path');

const failed = (error: string, extra = {}) => ({ pageNumber: -1, imageData: null, method: 'title-redraw', error, ...extra });

describe('hasTitleFault', () => {
  it('only a required_text fault on the front cover', () => {
    expect(hasTitleFault(-1, [{ type: 'required_text' }])).toBe(true);
    expect(hasTitleFault(-1, [{ type: 'clothing' }])).toBe(false);
    expect(hasTitleFault(3, [{ type: 'required_text' }])).toBe(false);
  });
});

describe('redrawTitle', () => {
  it('redraws until a redraw spells the title right and keeps that one', async () => {
    const runRepairMethod = vi.fn(async () => ({ pageNumber: -1, imageData: `img${runRepairMethod.mock.calls.length}` }));
    const verifyTitle = vi.fn(async (img: string) => ({ matches: img === 'img3', problem: img === 'img3' ? '' : 'répétaire' }));
    const res = await redrawTitle({ img: { pageNumber: -1 }, latestEval: {}, round: 1, failed, title: 'T', attempts: 4, runRepairMethod, verifyTitle });
    expect(res.imageData).toBe('img3');
    expect(res.titleRedraws).toBe(3);
    expect(runRepairMethod).toHaveBeenCalledTimes(3);
    expect(runRepairMethod.mock.calls[0][0].method).toBe('iterate');
    expect(verifyTitle.mock.calls[0][1]).toBe('T');
  });
  it('no redraw right: a failed result naming every problem, never a wrong picture', async () => {
    const runRepairMethod = vi.fn(async () => ({ pageNumber: -1, imageData: 'x' }));
    const verifyTitle = vi.fn(async () => ({ matches: false, problem: 'garbled' }));
    const res = await redrawTitle({ img: { pageNumber: -1 }, latestEval: {}, round: 1, failed, title: 'T', attempts: 2, runRepairMethod, verifyTitle });
    expect(res.imageData).toBeNull();
    expect(res.error).toMatch(/all 2 redraws/);
    expect(runRepairMethod).toHaveBeenCalledTimes(2);
  });
});

describe('the review loop', () => {
  const version = (faults: any[]) => ({ imageData: 'cover', reviewFaults: faults, finalScore: 40 });
  const titleFault = { type: 'required_text', severity: 'CRITICAL', route: { kind: 'NEW' }, detail: 'reads répétaire' };
  const base = (over: any) => {
    const v0 = version([titleFault]);
    const pageVersions = new Map([[-1, [v0]]]);
    return {
      rawImages: [{ pageNumber: -1, imageData: 'cover' }], pageVersions, selectBestVersion: (vs: any[]) => vs[vs.length - 1],
      maxRepairRounds: 1, title: 'T', titleRedraws: 2,
      reviewBook: async () => ({ byRoute: { IMG: [{ ...titleFault, page: -1 }], TEXT: [] }, pagesRead: [-1], raw: '', betterVerdicts: {} }),
      runRepairMethod: async () => ({ pageNumber: -1, imageData: 'bad' }),
      verifyTitle: async () => ({ matches: false, problem: 'still wrong' }),
      buildRoundVersion: (r: any, x: any) => ({ ...r, ...x }), redetect: async () => null, nameMapFor: () => ({}),
      inheritSceneContract: () => {}, auditRecord: () => ({}),
      ...over,
    };
  };
  it('a front cover whose title is still wrong after the rounds stops the story', async () => {
    await expect(runBookReviewRounds(base({}))).rejects.toThrow(/title is still wrong/);
  });
  it('a failed re-review does not let a cover with a known wrong title ship (finding 13, 2026-11-13)', async () => {
    // Page 2 is repaired fine, so a re-review runs; the cover's title redraws all fail; the re-review then fails.
    // The picked cover is the one the first review read wrong: the story must still stop.
    const pageFault = { type: 'scale', severity: 'MAJOR', route: { kind: 'TOUCHUP' }, detail: 'cat too big' };
    let reviews = 0;
    const over = {
      rawImages: [{ pageNumber: -1, imageData: 'cover' }, { pageNumber: 2, imageData: 'p2' }],
      pageVersions: new Map([[-1, [version([titleFault])]], [2, [version([pageFault])]]]),
      reviewBook: async () => (reviews++ === 0
        ? { byRoute: { IMG: [{ ...titleFault, page: -1 }, { ...pageFault, page: 2 }], TEXT: [] }, pagesRead: [-1, 2], raw: '', betterVerdicts: {} }
        : null),
      runRepairMethod: async ({ img }: any) => ({ pageNumber: img.pageNumber, imageData: img.pageNumber === 2 ? 'p2-fixed' : 'bad' }),
    };
    await expect(runBookReviewRounds(base(over))).rejects.toThrow(/title is still wrong/);
    expect(reviews).toBeGreaterThan(1); // the re-review really ran and failed
  });
  it('the re-review rules say a misspelled title never wins the comparison', () => {
    const s = fs.readFileSync(path.join(__dirname, '../../prompts/book-review-rereview.txt'), 'utf8');
    expect(s).toMatch(/title is spelled wrong is never better than one whose title is right/);
  });
  it('the pipeline hands the title, the redraw count and the verifier in', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../server/lib/repairPipeline.js'), 'utf8');
    expect(src).toMatch(/title: bookTitle,\s+titleRedraws: require\('\.\.\/config\/runtime'\)\.runtime\('bookReviewTitleRedraws'\),\s+verifyTitle: require\('\.\/coverTitlePaint'\)\.verifyTitleRender,/);
  });
});
