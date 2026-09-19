import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const {
  checkIdentityAgreement, reconcileIdentity, minCostAssignment, NAME_AGREEMENT_BONUS,
} = require_('../../server/lib/identityAgreement');

// THE DEFECT (2026-09-18, Lab set 66 / experiment 1324). Ten contested SHIPPED
// pages were pulled, every image downloaded and judged by eye against the
// stored clothing contract. The detector was right on 5, the evaluator on 1 —
// and on the remaining 4 NOBODY DISAGREED. Both witnesses had named the same
// people, in the same spelling, and `checkIdentityAgreement` manufactured the
// conflict: it paired each evaluator match to its nearest detector figure
// INDEPENDENTLY, so two matches could claim one figure and a uniformly shifted
// ladder of boxes mapped every name one slot over. Acting on that artefact is
// how a rename erased a character from the page.
//
// Across all 132 individual conflicts on staging, 36% were decided by a margin
// under 0.05 against the detector figure carrying the evaluator's own name
// (19% under 0.02; shipped examples at 0.002, 0.005, 0.007).
//
// The pairing is now a global one-to-one assignment whose cost carries the name
// agreement, and a pair is compared on the strongest channel BOTH sides have
// (body↔body, else head↔head — never a head against a torso).
//
// Every fixture below is a real stored image version, the evaluator's own
// matches[] with the stored rename undone and the detector's own figures[].
const fx = require_('./fixtures/identity-pairing-assignment.json');

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const byStory = (frag: string) => {
  const v = fx.versions.find((x: any) => x.storyId.includes(frag));
  if (!v) throw new Error(`fixture missing: ${frag}`);
  return v;
};
const run = (v: any) => {
  const evalLike = { matches: clone(v.matches), fixableIssues: clone(v.fixableIssues), fixTargets: [] };
  const report = reconcileIdentity(evalLike, clone(v.detectorFigures));
  return { report, refs: evalLike.matches.map((m: any) => m && m.reference) };
};

describe('the pairing no longer manufactures a conflict (real stored versions)', () => {
  // These five are the Lab pages where BOTH witnesses had the cast right.
  const artefacts = fx.versions.filter((v: any) => v.kind === 'artefact');

  it('all five artefact pages are in the fixture and were judged on the pixels', () => {
    expect(artefacts.map((v: any) => `${v.storyId.split('_').pop()} p${v.pageNumber}`)).toEqual([
      'z9bwoo3yp p3', '1dpnym94p p18', '9oxos7dwv p13', 'y3n0euk3z p6', 'n311ykfmin p5',
    ]);
  });

  for (const v of artefacts) {
    it(`agrees instead of conflicting — ${v.storyId} p${v.pageNumber} (${v.why.slice(0, 70)}…)`, () => {
      const { report, refs } = run(v);
      expect(report.conflicts).toEqual([]);
      expect(report.agreed).toBe(report.compared);
      expect(report.renamed || 0).toBe(0);
      // Nothing was rewritten, so nothing could be duplicated or dropped.
      expect(refs).toEqual(v.matches.map((m: any) => m && m.reference));
    });
  }

  it('z9bwoo3yp p3: every one of the five pirates lands on its own figure', () => {
    // The clearest case. The evaluator's ladder is ~0.08 per step and shifted
    // right, so greedy paired Fiona→Lorena (0.063), Lorena→Sarah (0.074),
    // Sarah→Saira (0.056) — and Saira→Saira at 0.062 agreed, on the figure
    // Sarah had just been given. Both claimed it; nothing stopped them.
    const report = checkIdentityAgreement(clone(byStory('z9bwoo3yp').matches),
      clone(byStory('z9bwoo3yp').detectorFigures));
    expect(report.agreedNames.sort()).toEqual(['Facundo', 'Fiona', 'Lorena', 'Saira', 'Sarah']);
    expect(report.agreementRate).toBe(1);
  });

  it('a detector figure is never given to two evaluator matches', () => {
    // The exclusivity that greedy lacked, asserted on every fixture version:
    // no two evaluator matches may be reported against the same figure. Agreed
    // names and conflict targets together must stay distinct.
    for (const v of fx.versions) {
      const report = checkIdentityAgreement(clone(v.matches), clone(v.detectorFigures));
      if (!report) continue;
      const claimed = [...report.agreedNames, ...report.conflicts.map((c: any) => c.detector)]
        .map((n: string) => n.toLowerCase());
      expect(new Set(claimed).size).toBe(claimed.length);
    }
  });
});

describe('a genuine disagreement still conflicts, and still renames', () => {
  for (const v of fx.versions.filter((x: any) => x.kind === 'genuine-detector-right')) {
    it(`${v.storyId} p${v.pageNumber} — the detector was right on the pixels`, () => {
      const { report } = run(v);
      expect(report.conflicts.length).toBeGreaterThan(0);
      expect(report.uncorrectable).toBeFalsy();
      expect(report.renamed).toBeGreaterThan(0);
    });
  }

  it('vxnu60yjg p16 is the tightest one, and the name bonus must not rescue it', () => {
    // Max's own figure is 0.143 away — inside the 0.15 gate, and the bonus
    // would make it cheaper still. It loses anyway, because the rival pairing
    // costs 0.055 and Julian's own name is 0.217 away, out of reach. This is
    // the fixture that pins NAME_AGREEMENT_BONUS from above: raise it past
    // ~0.13 and this page silently stops being corrected.
    const { report } = run(byStory('vxnu60yjg'));
    expect(report.conflicts.map((c: any) => `${c.evaluator}->${c.detector}`).sort())
      .toEqual(['Julian->Max', 'Max->Julian']);
    expect(NAME_AGREEMENT_BONUS).toBeLessThan(0.13);
  });

  it('wkt20ckod p12 is unchanged — this fix does not claim the evaluator-right case', () => {
    // Judged on the pixels the EVALUATOR is right here and the detector
    // followed a garment the illustration had duplicated. The pairing is not
    // what is wrong: both sides mean the same two figures, they disagree about
    // WHO. So the conflicts stand exactly as they did, the rename still applies,
    // and the page is still wrong. Only a third witness can settle it.
    const { report, refs } = run(byStory('wkt20ckod'));
    expect(report.conflicts.map((c: any) => `${c.evaluator}->${c.detector}`).sort())
      .toEqual(['Julian->Kiaan', 'Kiaan->Julian']);
    expect(report.agreementRate).toBe(0.5);
    expect(refs).toEqual(['Max', 'Julian', 'Levin', 'Kiaan']);
  });

  it('a near-tie is not a disagreement — 0.001 no longer renames a pirate into a crowd label', () => {
    // ll5dyf4k8g p12: Saira's own figure is 0.092 away, "Rossa's Crew" 0.091.
    // Greedy took the 0.001 and rewrote her name; the bonus settles it.
    const { report, refs } = run(byStory('ll5dyf4k8g'));
    expect(report.conflicts).toEqual([]);
    expect(refs).toContain('Saira');
    expect(refs).not.toContain("Rossa's Crew");
  });
});

describe('the weak signal measures, but does not rewrite the page', () => {
  it('a face-only record is comparable at all now — it was not before', () => {
    // hpv76p0rokg p2: an evaluator face centre against a detector body centre
    // is a head against a torso. Every distance on this page was over the 0.15
    // gate, so checkIdentityAgreement returned null and the page was dark.
    const v = byStory('hpv76p0rokg');
    const report = checkIdentityAgreement(clone(v.matches), clone(v.detectorFigures));
    expect(report).not.toBeNull();
    expect(report.pairedOn).toBe('face');
    expect(report.compared).toBe(4);
    expect(report.conflicts.every((c: any) => c.on === 'face')).toBe(true);
  });

  it('…and it is flagged, never renamed', () => {
    // Judged on the pixels against the stored clothing contract, the evaluator
    // has all four boys right on this page and the detector does not. Same on
    // p12 and p18 of the same story. These records predate `body_bbox` — and
    // the identity chain that would have got them right.
    const { report, refs } = run(byStory('hpv76p0rokg'));
    expect(report.conflicts.length).toBe(2);
    expect(report.uncorrectable).toBe(true);
    expect(report.uncorrectableReason).toBe('face-paired');
    expect(report.renamed).toBe(0);
    expect(refs).toEqual(['Levin', 'Julian', 'Max', 'Kiaan']);
  });

  it('comparing head to head withdraws a rename the channel mismatch caused', () => {
    // r9llf5yi9 p14: Lorena's own figure was 0.203 away against Saira's 0.129,
    // so her name was rewritten. Head to head her own figure is 0.026 and
    // Saira's 0.151.
    const { report, refs } = run(byStory('r9llf5yi9'));
    expect(report.conflicts).toEqual([]);
    expect(refs).toContain('Lorena');
    expect(refs).not.toContain('Saira');
  });
});

describe('the assignment itself', () => {
  // Exhaustive brute force over every permutation, against the O(n³) solver.
  const brute = (cost: number[][]) => {
    const n = cost.length;
    let best = Infinity;
    const used = new Array(n).fill(false);
    const rec = (i: number, acc: number) => {
      if (i === n) { best = Math.min(best, acc); return; }
      for (let j = 0; j < n; j++) {
        if (used[j]) continue;
        used[j] = true; rec(i + 1, acc + cost[i][j]); used[j] = false;
      }
    };
    rec(0, 0);
    return best;
  };

  it('finds the true minimum on random matrices, negatives and forbidden cells included', () => {
    let seed = 20260918;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let t = 0; t < 400; t++) {
      const n = 1 + Math.floor(rnd() * 6);
      const cost = Array.from({ length: n }, () =>
        Array.from({ length: n }, () => (rnd() < 0.15 ? 1e6 : rnd() * 2 - 0.5)));
      const a = minCostAssignment(cost);
      expect(new Set(a).size).toBe(n);              // a permutation, always
      const got = a.reduce((s: number, j: number, i: number) => s + cost[i][j], 0);
      expect(got).toBeCloseTo(brute(cost), 9);
    }
  });

  it('is empty on an empty matrix', () => {
    expect(minCostAssignment([])).toEqual([]);
  });
});

describe('what the pairing must keep doing', () => {
  const det = (name: string, box: number[]) => ({ name, bodyBox: box, faceBox: null });
  const ev = (reference: string, box: number[]) => ({ reference, body_bbox: box, confidence: 0.9 });
  // Detector boxes are [ymin, xmin, ymax, xmax]; evaluator boxes [x1,y1,x2,y2].
  const A = [0.2, 0.05, 0.9, 0.25];   // centre x 0.15
  const B = [0.2, 0.75, 0.9, 0.95];   // centre x 0.85
  const evOf = (b: number[]) => [b[1], b[0], b[3], b[2]];

  it('still gates: a figure on the far side of the frame is not the same person', () => {
    const r = checkIdentityAgreement([ev('Mara', evOf(A))], [det('Mara', B)]);
    expect(r).toBeNull();                 // nothing within reach, nothing compared
  });

  it('the name bonus cannot reach across the frame either', () => {
    // Same name, but 0.7 apart — far beyond maxCentreDistance + the bonus.
    const r = checkIdentityAgreement(
      [ev('Mara', evOf(A)), ev('Tom', evOf(B))],
      [det('Tom', A), det('Mara', B)]);
    expect(r.conflicts.map((c: any) => `${c.evaluator}->${c.detector}`))
      .toEqual(['Mara->Tom', 'Tom->Mara']);
  });

  it('a name the detector never used stays unpaired, and occupies no figure', () => {
    // The dragon must not be pushed onto the nearest child — and must not take
    // the figure that child needs.
    const r = checkIdentityAgreement(
      [ev('Dragon', evOf([0.2, 0.06, 0.9, 0.26])), ev('Mara', evOf(A))],
      [det('Mara', A)]);
    expect(r.agreedNames).toEqual(['Mara']);
    expect(r.unpaired).toEqual(['Dragon']);
    expect(r.conflicts).toEqual([]);
  });

  it('a two-name swap of adjacent figures still renames', () => {
    // 0.2 apart: past the gate for the same-name pairing (0.2 > 0.15 + 0.08),
    // so the swap is the only reading.
    const L = [0.2, 0.30, 0.9, 0.50];
    const R = [0.2, 0.50, 0.9, 0.70];
    const evalLike = {
      matches: [ev('Tom', evOf(L)), ev('Mara', evOf(R))],
      fixableIssues: [{ character: 'Tom', severity: 'MAJOR', description: 'Tom is too tall', fix: 'x' }],
    };
    const r = reconcileIdentity(evalLike, [det('Mara', L), det('Tom', R)]);
    expect(r.uncorrectable).toBeFalsy();
    expect(evalLike.matches.map((m: any) => m.reference)).toEqual(['Mara', 'Tom']);
    expect(evalLike.fixableIssues[0].character).toBe('Mara');
    expect(evalLike.fixableIssues[0].description).toBe('Mara is too tall');
  });

  it('a rename that would duplicate a name is still refused', () => {
    // The bc3cbe062 guarantee, on a shape that still conflicts: "Mara" is held
    // by a third match nobody renames away, so handing it to Tom's figure would
    // put it on two matches and erase Tom.
    const L = [0.2, 0.30, 0.9, 0.50];
    const R = [0.2, 0.50, 0.9, 0.70];
    const evalLike = {
      matches: [ev('Tom', evOf(L)), ev('Mara', [0.92, 0.92, 0.99, 0.99])],
      fixableIssues: [],
    };
    const r = reconcileIdentity(evalLike, [det('Mara', L), det('Tom', R)]);
    expect(r.conflicts.map((c: any) => `${c.evaluator}->${c.detector}`)).toEqual(['Tom->Mara']);
    expect(r.uncorrectable).toBe(true);
    expect(r.uncorrectableReason).toBe('not-a-permutation');
    expect(evalLike.matches.map((m: any) => m.reference)).toEqual(['Tom', 'Mara']);
  });
});
