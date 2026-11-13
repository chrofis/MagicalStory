import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * The repair figure guard and the duplicate-name check (docs/decisions.md "Repair figure guard and duplicate-name
 * check", owner 2026-11-13). Both read only the detector's typed figure -> name matches.
 */
const guard = require('../../server/lib/figureGuard.js');
const review = require('../../server/lib/bookReview.js');
const bookAudit = require('../../server/lib/bookAudit.js');
const absence = require('../../server/lib/absenceCheck.js');

const box = (x1: number, y1: number, x2: number, y2: number) => [x1, y1, x2, y2];
const fig = (name: string, b: number[]) => ({ name, bodyBox: b, confidence: 'high' });
const det = (figures: any[], names = ['Lio', 'Noam', 'Mia'], extra: any = {}) => ({
  figures, expectedCharacters: names.map(name => ({ name })), ...extra,
});

describe('repairFigureVerdict', () => {
  const parent = det([fig('Lio', box(0, 0, 0.3, 1)), fig('Noam', box(0.35, 0, 0.65, 1)), fig('UNKNOWN', box(0.7, 0, 1, 1))]);

  it('refuses a repair that lost a cast-labelled figure', () => {
    const child = det([fig('Lio', box(0, 0, 0.3, 1)), fig('UNKNOWN', box(0.7, 0, 1, 1))]);
    const v = guard.repairFigureVerdict(parent, child);
    expect(v).toMatchObject({ decided: true, refuse: true, parent: { cast: 2, raw: 3 }, child: { cast: 1, raw: 2 } });
  });

  it('keeps a repair that only lost an UNKNOWN figure (raw count down, cast count equal)', () => {
    const child = det([fig('Lio', box(0, 0, 0.3, 1)), fig('Noam', box(0.35, 0, 0.65, 1))]);
    expect(guard.repairFigureVerdict(parent, child)).toMatchObject({ decided: true, refuse: false });
  });

  it('keeps a repair with more cast figures', () => {
    const child = det([fig('Lio', box(0, 0, 0.3, 1)), fig('Noam', box(0.35, 0, 0.65, 1)), fig('Mia', box(0.7, 0, 1, 1))]);
    expect(guard.repairFigureVerdict(parent, child).refuse).toBe(false);
  });

  it('cannot judge without a readable detection on both sides, and says so', () => {
    expect(guard.repairFigureVerdict(null, parent)).toMatchObject({ decided: false, refuse: false });
    expect(guard.repairFigureVerdict(parent, { figures: [] })).toMatchObject({ decided: false, refuse: false });
    expect(guard.repairFigureVerdict(parent, null).reason).toMatch(/repaired picture/);
  });

  it('a name that is not on the detection expected list is not cast-labelled', () => {
    const child = det([fig('Stranger', box(0, 0, 0.3, 1))]);
    expect(guard.figureCounts(child)).toEqual({ cast: 0, raw: 1 });
  });
});

describe('duplicateNames', () => {
  it('flags one name on two non-overlapping figures', () => {
    const d = det([fig('Lio', box(0, 0, 0.3, 1)), fig('Lio', box(0.6, 0, 0.9, 1)), fig('Noam', box(0.35, 0, 0.55, 1))]);
    expect(guard.duplicateNames(d)).toEqual([{ name: 'Lio', figures: 2, allowed: 1 }]);
  });

  it('does not flag two boxes on the same figure (overlapping)', () => {
    const d = det([fig('Lio', box(0, 0, 0.5, 1)), fig('Lio', box(0.05, 0.1, 0.45, 0.95))]);
    expect(guard.duplicateNames(d)).toEqual([]);
  });

  it('respects a counted group: N figures of one entry are by design, N+1 is not', () => {
    const three = det([fig('Lio', box(0, 0, 0.2, 1)), fig('Lio', box(0.3, 0, 0.5, 1)), fig('Lio', box(0.6, 0, 0.8, 1))]);
    expect(guard.duplicateNames(three, new Map([['Lio', 3]]))).toEqual([]);
    expect(guard.duplicateNames(three, new Map([['Lio', 2]]))).toEqual([{ name: 'Lio', figures: 3, allowed: 2 }]);
  });

  it('reads the identity pass raw claims: the detector resolver turns the loser into UNKNOWN, the claim stays', () => {
    const d = det([fig('Lio', box(0, 0, 0.3, 1)), fig('UNKNOWN', box(0.6, 0, 0.9, 1))], ['Lio', 'Noam'], {
      gdinoDiag: {
        identity: { answers: { A: 'Lio', B: 'Lio' }, badges: [{ letter: 'A', detIdx: 0 }, { letter: 'B', detIdx: 1 }] },
        persons: [{ box: [0, 0, 300, 1000] }, { box: [600, 0, 900, 1000] }],
      },
    });
    expect(guard.duplicateNames(d)).toEqual([{ name: 'Lio', figures: 2, allowed: 1 }]);
  });

  it('clean pages: one figure per name, UNKNOWN repeats, no expected list, no detection', () => {
    expect(guard.duplicateNames(det([fig('Lio', box(0, 0, 0.3, 1)), fig('Noam', box(0.4, 0, 0.7, 1)), fig('UNKNOWN', box(0.8, 0, 0.9, 1)), fig('UNKNOWN', box(0.1, 0, 0.2, 0.5))]))).toEqual([]);
    expect(guard.duplicateNames({ figures: [fig('Lio', box(0, 0, 0.3, 1)), fig('Lio', box(0.6, 0, 0.9, 1))] })).toEqual([]);
    expect(guard.duplicateNames(null)).toEqual([]);
  });
});

describe('absenceCheck cap leaves a duplicate made by the name check at its severity', () => {
  it('two copies + one child missing (detector count <= cast) is NOT downgraded; the judge own finding still is', () => {
    const issues = [
      { type: 'duplicate_character', severity: 'MAJOR', derivedBy: guard.DUPLICATE_NAME_MARKER },
      { type: 'duplicate_character', severity: 'CRITICAL' },
    ];
    expect(absence.capDuplicatesByDetector(issues, { detectedPeopleCount: 3, castPeopleCount: 3 })).toBe(1);
    expect(issues[0].severity).toBe('MAJOR');
    expect(issues[1].severity).toBe('MINOR');
  });
});

describe('book review rounds', () => {
  const imgs = [
    { pageNumber: 1, imageData: 'data:image/jpeg;base64,AAAA', text: 't1' },
    { pageNumber: 2, imageData: 'data:image/jpeg;base64,BBBB', text: 't2' },
  ];
  const parentDet = det([fig('Lio', box(0, 0, 0.3, 1)), fig('Noam', box(0.4, 0, 0.7, 1))]);
  const mk = (reviewBook: any, redetectResult: any, extra: any = {}) => {
    const pageVersions = new Map(imgs.map(i => [i.pageNumber, [{ imageData: i.imageData, source: 'original', pageNumber: i.pageNumber, bboxDetection: i.pageNumber === 1 ? parentDet : null }]]));
    const runRepairMethod = vi.fn(async ({ img }: any) => ({ pageNumber: img.pageNumber, imageData: 'data:image/jpeg;base64,CCCC', source: 'inpaint-round-1', method: 'inpaint' }));
    return {
      pageVersions, runRepairMethod,
      deps: {
        rawImages: imgs.map(i => ({ ...i })), pageVersions,
        selectBestVersion: (vs: any[]) => vs[vs.length - 1],
        maxRepairRounds: 1, reviewBook, runRepairMethod,
        buildRoundVersion: (r: any, p: any) => ({ imageData: r.imageData, source: r.source, method: r.method, bboxDetection: r.bboxDetection, ...p }),
        redetect: vi.fn(async () => redetectResult),
        nameMapFor: () => null, inheritSceneContract: () => {},
        auditRecord: (a: any, round: number) => ({ round, faults: a.faults }),
        ...extra,
      },
    };
  };
  const audit = (lines: string) => ({ faults: 1, byRoute: bookAudit.parseRoutes(lines), raw: lines, pagesRead: [1, 2], betterVerdicts: {} });

  it('REFUSES a repair that lost a cast figure: no version is added, the page keeps its parent, the refusal is recorded', async () => {
    const lost = det([fig('Lio', box(0, 0, 0.3, 1))]);
    const reviewBook = vi.fn().mockResolvedValueOnce(audit('FAULT[IMG][MAJOR][wrong_action][TOUCHUP]: p1 - Remove the hat.'));
    const { deps, pageVersions } = mk(reviewBook, lost);
    const out = await review.runBookReviewRounds(deps);
    expect(pageVersions.get(1)).toHaveLength(1);
    expect(reviewBook).toHaveBeenCalledTimes(1);
    expect(deps.rawImages[0].retryHistory[0]).toMatchObject({ type: 'repair_refused_figures', parentFigures: { cast: 2, raw: 2 }, repairFigures: { cast: 1, raw: 1 } });
    expect((pageVersions.get(1)![0] as any).failedRepairs[0].error).toMatch(/refused/);
    expect(out.reviewFailed).toBe(false);
  });

  it('keeps a repair that lost no cast figure (negative control)', async () => {
    const reviewBook = vi.fn()
      .mockResolvedValueOnce(audit('FAULT[IMG][MAJOR][wrong_action][TOUCHUP]: p1 - Remove the hat.'))
      .mockResolvedValue(audit(''));
    const { deps, pageVersions } = mk(reviewBook, parentDet);
    await review.runBookReviewRounds(deps);
    expect(pageVersions.get(1)).toHaveLength(2);
  });

  it('adds a duplicate_character fault routed NEW from two same-name figures and sends the page to a redraw', async () => {
    const twice = det([fig('Lio', box(0, 0, 0.3, 1)), fig('Lio', box(0.6, 0, 0.9, 1))]);
    const reviewBook = vi.fn().mockResolvedValue(audit(''));
    const { deps, pageVersions, runRepairMethod } = mk(reviewBook, parentDet);
    (pageVersions.get(1)![0] as any).bboxDetection = twice;
    await review.runBookReviewRounds(deps);
    expect(runRepairMethod).toHaveBeenCalledTimes(1);
    expect(runRepairMethod.mock.calls[0][0]).toMatchObject({ method: 'iterate', img: { pageNumber: 1 } });
    const fault = (pageVersions.get(1)![0] as any).reviewFaults[0];
    expect(fault).toMatchObject({ type: 'duplicate_character', severity: 'MAJOR', derivedBy: guard.DUPLICATE_NAME_MARKER });
  });

  it('adds nothing for a counted group (groupSizesFor says N)', async () => {
    const twice = det([fig('Lio', box(0, 0, 0.3, 1)), fig('Lio', box(0.6, 0, 0.9, 1))]);
    const reviewBook = vi.fn().mockResolvedValue(audit(''));
    const { deps, pageVersions, runRepairMethod } = mk(reviewBook, parentDet, { groupSizesFor: () => new Map([['Lio', 2]]) });
    (pageVersions.get(1)![0] as any).bboxDetection = twice;
    await review.runBookReviewRounds(deps);
    expect(runRepairMethod).not.toHaveBeenCalled();
  });
});
