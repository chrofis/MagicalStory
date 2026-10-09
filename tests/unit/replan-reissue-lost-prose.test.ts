/**
 * A page that loses accepted PROSE changes because a sibling change was refused is
 * re-asked once, fed back (beats_replan_accepted_lost, 2026-10-09). Stored shape:
 * staging job_1791531449494_o0kaatvmq round 1, p2 -- the accepted `action out` /
 * `action in` lines went back to the standing sentence with the refused
 * `cast out Max` (rule obstacle: Max holds this page's obstacle).
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';

const PB = require('../../server/lib/promptBuilders');
const PC = require('../../server/lib/planCounters');

const CAST = ['Max', 'Julian', 'Kiaan'];
const STANDING = [
  { pageNumber: 1, planLine: 'wide — Max and Julian in the garden — Max finds the egg — the egg is warm' },
  { pageNumber: 2, planLine: 'medium — Max and Julian on the steps — Max runs down the grass and stops the egg before the steps — the egg is safe' },
  { pageNumber: 3, planLine: 'close — Julian alone — Julian waits — the wind drops' },
];
const REPLAN = [
  'Page 2: medium — Julian on the steps — the egg rolls across the grass toward the stone steps — the egg is safe',
  '---CHANGES---',
  'Page 2: cast out Max — PLAN[NO_PEOPLELESS_PAGE] — the page must hold no people.',
  'Page 2: action out: Max runs down the grass and stops the egg before the steps — CHECK[9] — the egg is the danger.',
  'Page 2: action in: the egg rolls across the grass toward the stone steps — CHECK[9] — the egg is the danger.',
  'Changes: 3',
].join('\n');
const OBSTACLES = new Map([[2, ['Max']]]);

function firstRound() {
  const declared = PB.parsePlanChanges(REPLAN);
  const returned = [STANDING[0], { pageNumber: 2, planLine: 'medium — Julian on the steps — the egg rolls across the grass toward the stone steps — the egg is safe' }, STANDING[2]];
  const review = (changes: any[], pages: any[]) => PC.reviewPlanChanges({
    changes, standing: STANDING, returned: pages, castNames: CAST, obstacles: OBSTACLES, rankOf: () => 'also',
  });
  const rev = review(declared.changes, returned);
  const kept = PC.restoreRefusedChanges({ pages: returned, standing: STANDING, refusals: rev.refusals, changes: declared.changes, castNames: CAST });
  return { declared, returned, review, rev, kept };
}

describe('stored p2 shape', () => {
  it('refuses only `cast out Max` and reports the accepted prose with full text and the refusal reason', () => {
    const { rev, kept } = firstRound();
    expect(rev.refusals.map((r: any) => r.clause)).toEqual(['cast out Max']);
    expect(kept.lost).toHaveLength(1);
    const l = kept.lost[0];
    expect(l.pageNumber).toBe(2);
    expect(l.accepted.map((a: any) => a.line).join('\n')).toContain('the egg rolls across the grass');
    expect(l.refused[0].rule).toBe('obstacle');
    expect(l.refused[0].detail).toContain('obstacle');
  });
});

describe('buildReissueSection', () => {
  it('carries the accepted change text and the refusal reason, for the listed page only', () => {
    const { kept } = firstRound();
    const text = PC.buildReissueSection('Page 1: a\nPage 2: b', kept.lost);
    expect(text).toContain('Page 2:');
    expect(text).toContain('ACCEPTED');
    expect(text).toContain('the egg rolls across the grass toward the stone steps');
    expect(text).toContain('REFUSED');
    expect(text).toContain('(obstacle)');
    expect(text).toContain("Max holds this page's obstacle");
    expect(text).not.toMatch(/Page 3:\n {2}ACCEPTED/);
  });
});

describe('reissueLostPages', () => {
  const GOOD = 'medium — Max and Julian on the steps — the egg rolls across the grass toward the stone steps while Max runs after it — the egg is safe';
  const reply = (planLine: string, changeLines: string[]) => ({
    pages: [{ pageNumber: 2, planLine }],
    changes: PB.parsePlanChanges(['---CHANGES---', ...changeLines, `Changes: ${changeLines.length}`].join('\n')).changes,
  });

  it('asks once and takes back a page that passes the same review', async () => {
    const { kept, review } = firstRound();
    const ask = vi.fn(async () => reply(GOOD, ['Page 2: action in: the egg rolls across the grass toward the stone steps — CHECK[9] — the egg is the danger.']));
    const out = await PC.reissueLostPages({ pages: kept.pages, lost: kept.lost, ask, review });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(out.reissued).toEqual([2]);
    expect(out.failed).toEqual([]);
    expect(out.pages.find((p: any) => p.pageNumber === 2).planLine).toBe(GOOD);
    expect(out.pages.find((p: any) => p.pageNumber === 1)).toBe(kept.pages[0]);
  });

  it('keeps the restored line, and says why, when the review refuses the re-issue again', async () => {
    const { kept, review } = firstRound();
    const ask = async () => reply('medium — Julian on the steps — the egg rolls — the egg is safe', ['Page 2: cast out Max — PLAN[NO_PEOPLELESS_PAGE] — again']);
    const out = await PC.reissueLostPages({ pages: kept.pages, lost: kept.lost, ask, review });
    expect(out.reissued).toEqual([]);
    expect(out.failed[0].pageNumber).toBe(2);
    expect(out.failed[0].reason).toContain('refused again');
    expect(out.pages.find((p: any) => p.pageNumber === 2)).toBe(kept.pages.find((p: any) => p.pageNumber === 2));
  });

  it('fails loudly when the page is not returned or comes back unchanged', async () => {
    const { kept, review } = firstRound();
    const missing = await PC.reissueLostPages({ pages: kept.pages, lost: kept.lost, review, ask: async () => ({ pages: [], changes: [] }) });
    expect(missing.failed[0].reason).toContain('did not return');
    const same = kept.pages.find((p: any) => p.pageNumber === 2);
    const unchanged = await PC.reissueLostPages({ pages: kept.pages, lost: kept.lost, review, ask: async () => ({ pages: [same], changes: [] }) });
    expect(unchanged.failed[0].reason).toContain('unchanged');
  });

  it('makes no call when nothing was lost', async () => {
    const ask = vi.fn();
    const out = await PC.reissueLostPages({ pages: STANDING, lost: [], ask, review: () => ({ refusals: [] }) });
    expect(ask).not.toHaveBeenCalled();
    expect(out.pages).toBe(STANDING);
  });
});

describe('beatsPipeline wiring', () => {
  const src = fs.readFileSync('server/lib/beatsPipeline.js', 'utf8');
  it('re-issues from the lost list, counts it, and records the pages on the round', () => {
    expect(src).toContain('reissueLostPages({');
    expect(src).toContain("count('beats_replan_reissue')");
    expect(src).toContain("count('beats_replan_reissue_failed')");
    expect(src).toContain('reissuedPages,');
  });
  it('the re-issue is reviewed with the round\'s own review arguments (one argument set)', () => {
    expect(src.match(/reviewPlanChanges\(\{/g)?.length).toBe(1);
    expect(src).toContain('review: reviewWith');
  });
});
