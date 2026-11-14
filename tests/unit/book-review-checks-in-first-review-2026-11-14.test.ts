/**
 * Owner 2026-11-14 (pipeline review finding 9): "All checks must run in round 1. Remove round 3."
 * (1) The book review is review -> repair -> re-review (one repair round, no third review).
 * (2) The object-size check runs in the FIRST review only; re-reviews no longer pay for it again.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { runBookReviewRounds } = require_('../../server/lib/bookReview.js');
const ROOT = path.resolve(__dirname, '../..');

const version = (faults: any[]) => ({ imageData: 'img', reviewFaults: faults, finalScore: 40 });
const pageFault = { type: 'scale', severity: 'MAJOR', route: { kind: 'TOUCHUP' }, detail: 'the cat is too big' };

describe('the book review: one repair round, checks in the first review', () => {
  it('with the shipped round budget there are exactly two reviews, and only the first asks for the size check', async () => {
    const rounds = require_('../../server/config/runtime.js').runtime('bookReviewRepairRounds');
    expect(rounds).toBe(1);
    const calls: any[] = [];
    await runBookReviewRounds({
      rawImages: [{ pageNumber: 2, imageData: 'p2' }],
      pageVersions: new Map([[2, [version([pageFault])]]]),
      selectBestVersion: (vs: any[]) => vs[vs.length - 1],
      maxRepairRounds: rounds, title: 'T', titleRedraws: 1,
      // every review still finds the fault, so a second repair round would run if the budget allowed it
      reviewBook: async (_s: any, _p: any, opts: any) => {
        calls.push(opts);
        return { byRoute: { IMG: [{ ...pageFault, page: 2 }], TEXT: [] }, pagesRead: [2], raw: '', betterVerdicts: { 2: 'NEW' } };
      },
      runRepairMethod: async ({ img }: any) => ({ pageNumber: img.pageNumber, imageData: `fixed${calls.length}` }),
      verifyTitle: async () => ({ matches: true, problem: '' }),
      buildRoundVersion: (r: any, x: any) => ({ ...r, ...x }), redetect: async () => null,
      inheritSceneContract: () => {}, auditRecord: () => ({}),
    });
    expect(calls.length).toBe(2);
    expect(calls.map(c => c.firstReview)).toEqual([true, false]);
  });

  it('the pipeline turns the size check on only for the first review', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/lib/repairPipeline.js'), 'utf8');
    expect(src).toMatch(/const reviewBook = async \(versionByPage, previousByPage, \{ firstReview \} = \{\}\) =>/);
    expect(src).toMatch(/bookReview: \{ title: bookTitle \}, objectScale: firstReview === true \}/);
  });
});
