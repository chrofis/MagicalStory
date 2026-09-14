/**
 * The all-pages scene expansion must not count a CUT brief as a delivered page.
 *
 * Measured failure: staging `job_1789207854566_l43qgl34w` page 7. The
 * all-pages reply (`prompts/scene-expansion-all.txt`, the template every real
 * beats story goes through) produced 1884 characters of prose that stop
 * mid-word inside a character description and carry no metadata block at all,
 * then carried on with page 8 normally. `parseRefinedText` counts any non-empty
 * run of text under a `## Page N` heading as a page, so p7 merged exactly like
 * its whole neighbours: no retry, no per-page fallback, no warning. The
 * generator rendered that page from half a spec and the eval then scored the
 * render against the same half — invisible to every judge.
 *
 * Scale, measured over the stored rows rather than assumed: 1035 briefs across
 * 85 staging stories, 1 cut page (p7 below) and 3 August pages predating
 * `sceneIntent`. There is no truncation cliff and no decay by page index — mean
 * brief length by quartile runs 3541 / 3501 / 3485 / 3920.
 *
 * The briefs in the fixture are the REAL stored rows for p6, p7 and p8 of that
 * reply, not hand-written shapes.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { partitionSceneBriefs, assessSceneBrief } = require('../../server/lib/iterateBriefGuard');

const fixture = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'scene-brief-cut-job_1789207854566-p7.json'), 'utf8')
) as { pages: Record<string, string> };

const P6 = fixture.pages.p6;
const P7 = fixture.pages.p7;
const P8 = fixture.pages.p8;

describe('the stored evidence is what we think it is', () => {
  it('p7 is prose that stops mid-word with no metadata; p6 and p8 are whole', () => {
    expect(P7.length).toBeGreaterThan(1000);
    expect(P7).not.toContain('---METADATA---');
    expect(P6).toContain('---METADATA---');
    expect(P8).toContain('---METADATA---');
  });
});

describe('partitionSceneBriefs — a cut page is not a delivered page', () => {
  it('holds back the cut page and keeps its whole neighbours', () => {
    const { whole, cut, formatWide } = partitionSceneBriefs([
      { pageNumber: 6, text: P6 },
      { pageNumber: 7, text: P7 },
      { pageNumber: 8, text: P8 },
    ]);
    expect(cut.map((p: { pageNumber: number }) => p.pageNumber)).toEqual([7]);
    expect(whole.map((p: { pageNumber: number }) => p.pageNumber)).toEqual([6, 8]);
    expect(formatWide).toBe(false);
  });

  it('says WHY the page was held back, so the log names the fault', () => {
    const { cut } = partitionSceneBriefs([{ pageNumber: 7, text: P7 }]);
    expect(cut[0].verdict.usable).toBe(false);
    expect(cut[0].verdict.reason).toBe('no_metadata_block');
    expect(cut[0].verdict.detail).toContain('1884 characters');
  });

  it('passes a complete reply through untouched', () => {
    const { whole, cut, formatWide } = partitionSceneBriefs([
      { pageNumber: 6, text: P6 },
      { pageNumber: 8, text: P8 },
    ]);
    expect(cut).toEqual([]);
    expect(formatWide).toBe(false);
    expect(whole.map((p: { text: string }) => p.text)).toEqual([P6, P8]);
  });

  it('ignores empty entries rather than reporting them as cut', () => {
    const { whole, cut } = partitionSceneBriefs([
      { pageNumber: 6, text: P6 },
      { pageNumber: 7, text: '   ' },
    ]);
    expect(cut).toEqual([]);
    expect(whole).toHaveLength(1);
  });

  it('sorts the held-back pages, so the warning reads in page order', () => {
    const cutText = P7;
    const { cut } = partitionSceneBriefs([
      { pageNumber: 9, text: cutText },
      { pageNumber: 3, text: cutText },
      { pageNumber: 6, text: P6 },
    ]);
    expect(cut.map((p: { pageNumber: number }) => p.pageNumber)).toEqual([3, 9]);
  });
});

describe('formatWide — a reply the parser does not recognise is not 18 truncations', () => {
  it('flags a reply where NOT ONE page meets the contract, so the caller can take it as written', () => {
    const { whole, cut, formatWide } = partitionSceneBriefs([
      { pageNumber: 1, text: P7 },
      { pageNumber: 2, text: P7 },
    ]);
    expect(whole).toEqual([]);
    expect(cut).toHaveLength(2);
    expect(formatWide).toBe(true);
  });

  it('is false as soon as one page is whole — that reply is truncated, not reshaped', () => {
    const { formatWide } = partitionSceneBriefs([
      { pageNumber: 1, text: P7 },
      { pageNumber: 2, text: P6 },
    ]);
    expect(formatWide).toBe(false);
  });
});

describe('assessSceneBrief is the same verdict under a generic name', () => {
  it('rejects the stored cut brief and accepts the stored whole one', () => {
    expect(assessSceneBrief(P7).usable).toBe(false);
    expect(assessSceneBrief(P6).usable).toBe(true);
  });
});
