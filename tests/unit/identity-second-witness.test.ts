import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const {
  reconcileIdentity, reconcileIdentityWithSecondWitness, checkIdentityAgreement,
} = require_('../../server/lib/identityAgreement');

// PART 2 OF THE PAIRING FIX (2026-09-18). Part 1 (d1c9a9d1f) made the
// evaluator↔detector pairing a one-to-one name-aware assignment, which removed
// the conflicts that were pairing ARTEFACTS: staging versions carrying a
// conflict went 76 → 32 and characters erased 2 → 0. What it could not touch is
// the genuine who-is-who disagreement that survives on roughly one page in six,
// where `reconcileIdentity` lets the detector overwrite the evaluator
// unconditionally. Lab set 66 / experiment 1324 judged ten such pages on the
// pixels: detector right 5, evaluator right 1 — a good prior, not a certainty,
// and job_1789584708605_rts4wqupm p18 shipped at q=45 because of the exception.
//
// So a third witness is asked, and its only power is a VETO. These tests pin
// three things: WHEN it is asked (only where its answer can change what
// happens), that it can only ever REDUCE the renames, and that every guarantee
// the earlier fixes bought — no duplicate, no erased character — survives every
// vote outcome including a partial veto.
//
// The fixture is the whole measured trigger population: every staging version
// the vote fires on (19) plus every contested version it must NOT fire on (13)
// plus clean controls (4), with `kind` carrying the Part-1 replay's own verdict
// so the trigger is asserted against measurement, not against a hand-picked
// example.
const fx = require_('./fixtures/identity-second-witness.json');

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const evalLikeOf = (v: any) => ({
  matches: clone(v.matches),
  fixableIssues: clone(v.fixableIssues),
  fixTargets: [],
});
const refs = (e: any) => (e.matches || []).map((m: any) => m && m.reference);
const byKey = (k: string) => fx.versions.find((v: any) => v.key === k);

/** A witness that answers with whatever the DETECTOR called each figure. */
const witnessBackingDetector = (figures: any[]) => async () => ({
  model: 'stub-detector', nameByFigure: new Map(figures.map((f, i) => [i, f.name])),
});
/**
 * A witness that answers with whatever the EVALUATOR called each contested
 * figure — built from the report, which is the only place the two claims sit
 * side by side.
 */
const witnessBackingEvaluator = (report: any) => async () => ({
  model: 'stub-evaluator',
  nameByFigure: new Map(report.conflicts.map((c: any) => [c.detIndex, c.evaluator])),
});

const duplicates = (names: any[]) => {
  const seen = new Map<string, number>();
  for (const n of names.filter(Boolean)) seen.set(String(n).toLowerCase(), (seen.get(String(n).toLowerCase()) || 0) + 1);
  return [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k).sort();
};

describe('the trigger — a witness is only asked where its answer can change the outcome', () => {
  it('the fixture is the measured trigger population, not a chosen example', () => {
    const kinds: Record<string, number> = {};
    for (const v of fx.versions) kinds[v.kind] = (kinds[v.kind] || 0) + 1;
    expect(kinds).toEqual({
      'vote-fires': 19,
      'no-vote-uncorrectable-face-paired': 8,
      'no-vote-uncorrectable-not-a-permutation': 5,
      'no-vote-clean': 4,
    });
  });

  it('fires on exactly the 19 versions Part 1 leaves a correctable conflict on — and on no other', async () => {
    const asked: string[] = [];
    for (const v of fx.versions) {
      const evalLike = evalLikeOf(v);
      await reconcileIdentityWithSecondWitness(evalLike, clone(v.detectorFigures), {
        secondOpinion: async () => { asked.push(v.key); return null; },
      });
    }
    expect(asked.length).toBe(19);
    expect(asked).toEqual(fx.versions.filter((v: any) => v.kind === 'vote-fires').map((v: any) => v.key));
  });

  it('never asks on a clean page, a face-paired page, or a page that is not a permutation', async () => {
    for (const v of fx.versions.filter((x: any) => x.kind !== 'vote-fires')) {
      let asked = 0;
      await reconcileIdentityWithSecondWitness(evalLikeOf(v), clone(v.detectorFigures), {
        secondOpinion: async () => { asked++; return null; },
      });
      expect(asked, v.key).toBe(0);
    }
  });

  it('never asks when no witness is wired at all, and then behaves exactly as the synchronous path', async () => {
    for (const v of fx.versions) {
      const a = evalLikeOf(v);
      const b = evalLikeOf(v);
      const ra = reconcileIdentity(a, clone(v.detectorFigures));
      const rb = await reconcileIdentityWithSecondWitness(b, clone(v.detectorFigures));
      expect(refs(b), v.key).toEqual(refs(a));
      expect(rb?.renamed, v.key).toBe(ra?.renamed);
      expect(rb?.uncorrectableReason, v.key).toBe(ra?.uncorrectableReason);
      expect(rb?.secondWitness, v.key).toBeUndefined();
    }
  });
});

describe('the vote — how each answer resolves', () => {
  it('2-1 for the detector: the rename applies, exactly as it does today', async () => {
    for (const v of fx.versions.filter((x: any) => x.kind === 'vote-fires')) {
      const sync = evalLikeOf(v);
      const voted = evalLikeOf(v);
      reconcileIdentity(sync, clone(v.detectorFigures));
      const r = await reconcileIdentityWithSecondWitness(voted, clone(v.detectorFigures), {
        secondOpinion: witnessBackingDetector(v.detectorFigures),
      });
      expect(refs(voted), v.key).toEqual(refs(sync));
      expect(r.renamed, v.key).toBe(v.renamedByPart1);
      expect(r.secondWitness.vetoed, v.key).toBe(0);
      expect(r.secondWitness.votes.every((x: any) => x.verdict === 'detector'), v.key).toBe(true);
    }
  });

  it('2-1 for the evaluator: the rename is withheld and the evaluator’s labels stay', async () => {
    for (const v of fx.versions.filter((x: any) => x.kind === 'vote-fires')) {
      const evalLike = evalLikeOf(v);
      const before = refs(evalLike);
      const report = checkIdentityAgreement(clone(v.matches), clone(v.detectorFigures));
      const r = await reconcileIdentityWithSecondWitness(evalLike, clone(v.detectorFigures), {
        secondOpinion: witnessBackingEvaluator(report),
      });
      expect(refs(evalLike), v.key).toEqual(before);
      expect(r.renamed, v.key).toBe(0);
      expect(r.uncorrectable, v.key).toBe(true);
      expect(r.uncorrectableReason, v.key).toBe('second-witness-veto');
      expect(r.secondWitness.vetoed, v.key).toBe(r.conflicts.length);
    }
  });

  it('a three-way split is not a veto — a witness naming a THIRD person leaves the detector’s prior standing', async () => {
    for (const v of fx.versions.filter((x: any) => x.kind === 'vote-fires')) {
      const sync = evalLikeOf(v);
      const voted = evalLikeOf(v);
      reconcileIdentity(sync, clone(v.detectorFigures));
      const r = await reconcileIdentityWithSecondWitness(voted, clone(v.detectorFigures), {
        secondOpinion: async () => ({
          model: 'stub-third',
          nameByFigure: new Map(v.detectorFigures.map((_: any, i: number) => [i, 'Somebody Else Entirely'])),
        }),
      });
      expect(r.secondWitness.votes.every((x: any) => x.verdict === 'third-name'), v.key).toBe(true);
      expect(refs(voted), v.key).toEqual(refs(sync));
    }
  });

  it('silence is not a veto — a witness with no name for the contested figure leaves the prior standing', async () => {
    for (const v of fx.versions.filter((x: any) => x.kind === 'vote-fires')) {
      const sync = evalLikeOf(v);
      const voted = evalLikeOf(v);
      reconcileIdentity(sync, clone(v.detectorFigures));
      const r = await reconcileIdentityWithSecondWitness(voted, clone(v.detectorFigures), {
        secondOpinion: async () => ({ model: 'stub-silent', nameByFigure: new Map() }),
      });
      expect(r.secondWitness.votes.every((x: any) => x.verdict === 'silent'), v.key).toBe(true);
      expect(refs(voted), v.key).toEqual(refs(sync));
    }
  });

  it('a witness that fails, throws or returns nothing is recorded and changes nothing', async () => {
    const failures = [
      async () => { throw new Error('Qwen-VL HTTP 502'); },
      async () => null,
      async () => ({ model: 'x', nameByFigure: null }),
      async () => undefined,
    ];
    for (const v of fx.versions.filter((x: any) => x.kind === 'vote-fires')) {
      const sync = evalLikeOf(v);
      reconcileIdentity(sync, clone(v.detectorFigures));
      for (const secondOpinion of failures) {
        const voted = evalLikeOf(v);
        const r = await reconcileIdentityWithSecondWitness(voted, clone(v.detectorFigures), { secondOpinion });
        expect(refs(voted), v.key).toEqual(refs(sync));
        expect(r.secondWitness.asked, v.key).toBe(true);
        expect(r.secondWitness.answered, v.key).toBe(false);
        expect(r.secondWitness.reason, v.key).toBeTruthy();
      }
    }
  });

  it('a plain Map is accepted as an answer, so the contract is the map and not a wrapper shape', async () => {
    const v = byKey('job_1789147573901_m3uam0nxi|p2|v0');
    const sync = evalLikeOf(v);
    reconcileIdentity(sync, clone(v.detectorFigures));
    const voted = evalLikeOf(v);
    await reconcileIdentityWithSecondWitness(voted, clone(v.detectorFigures), {
      secondOpinion: async () => new Map(v.detectorFigures.map((f: any, i: number) => [i, f.name])),
    });
    expect(refs(voted)).toEqual(refs(sync));
  });
});

describe('the veto can only ever REDUCE what is applied', () => {
  it('no witness answer produces a rename the synchronous path would not have produced', async () => {
    const answers: Array<(v: any, report: any) => any> = [
      (v) => witnessBackingDetector(v.detectorFigures),
      (_v, report) => witnessBackingEvaluator(report),
      (v) => async () => ({ model: 's', nameByFigure: new Map(v.detectorFigures.map((_: any, i: number) => [i, 'Nobody'])) }),
      () => async () => ({ model: 's', nameByFigure: new Map() }),
      () => async () => null,
      // Adversarial: the witness names each figure after a DIFFERENT figure on
      // the page, which is the shape most likely to turn a clean permutation
      // into a chain.
      (v) => async () => ({
        model: 's',
        nameByFigure: new Map(v.detectorFigures.map((_: any, i: number) => [i, v.detectorFigures[(i + 1) % v.detectorFigures.length].name])),
      }),
    ];
    for (const v of fx.versions) {
      const sync = evalLikeOf(v);
      const syncReport = reconcileIdentity(sync, clone(v.detectorFigures));
      const syncRenamed = syncReport?.renamed || 0;
      const report = checkIdentityAgreement(clone(v.matches), clone(v.detectorFigures));
      for (const mk of answers) {
        const voted = evalLikeOf(v);
        const r = await reconcileIdentityWithSecondWitness(voted, clone(v.detectorFigures), {
          secondOpinion: mk(v, report),
        });
        expect(r?.renamed || 0, v.key).toBeLessThanOrEqual(syncRenamed);
        // And a name that was NOT renamed by the synchronous path is never
        // renamed by the voted one.
        const syncRefs = refs(sync);
        refs(voted).forEach((name: any, i: number) => {
          if (name !== v.matches[i].reference) expect(name, v.key).toBe(syncRefs[i]);
        });
      }
    }
  });

  it('a PARTIAL veto withholds the whole permutation rather than half of a swap', async () => {
    // Veto one leg of a two-name swap and the other leg would write a name a
    // match still holds. buildRenameMap refuses exactly that — bc3cbe062's
    // guarantee — so the page is left as the evaluator wrote it.
    for (const v of fx.versions.filter((x: any) => x.kind === 'vote-fires')) {
      const report = checkIdentityAgreement(clone(v.matches), clone(v.detectorFigures));
      if (report.conflicts.length < 2) continue;
      const evalLike = evalLikeOf(v);
      const before = refs(evalLike);
      const first = report.conflicts[0];
      const r = await reconcileIdentityWithSecondWitness(evalLike, clone(v.detectorFigures), {
        secondOpinion: async () => ({ model: 'stub-partial', nameByFigure: new Map([[first.detIndex, first.evaluator]]) }),
      });
      expect(r.secondWitness.vetoed, v.key).toBe(1);
      expect(r.renamed, v.key).toBe(0);
      expect(r.uncorrectableReason, v.key).toBe('second-witness-veto');
      expect(refs(evalLike), v.key).toEqual(before);
    }
  });

  it('no vote outcome ever fabricates a duplicate name or erases a character', async () => {
    const answers: Array<(v: any, report: any) => any> = [
      (v) => witnessBackingDetector(v.detectorFigures),
      (_v, report) => witnessBackingEvaluator(report),
      (_v, report) => async () => ({
        model: 's',
        nameByFigure: new Map(report.conflicts.slice(0, 1).map((c: any) => [c.detIndex, c.evaluator])),
      }),
      (v) => async () => ({
        model: 's',
        nameByFigure: new Map(v.detectorFigures.map((_: any, i: number) => [i, v.detectorFigures[(i + 1) % v.detectorFigures.length].name])),
      }),
    ];
    for (const v of fx.versions) {
      const report = checkIdentityAgreement(clone(v.matches), clone(v.detectorFigures));
      for (const mk of answers) {
        const evalLike = evalLikeOf(v);
        const before = refs(evalLike);
        await reconcileIdentityWithSecondWitness(evalLike, clone(v.detectorFigures), { secondOpinion: mk(v, report) });
        const after = refs(evalLike);
        expect(duplicates(after).filter(d => !duplicates(before).includes(d)), v.key).toEqual([]);
        const lost = before.filter((n: any) => n && !after.includes(n));
        expect(lost, v.key).toEqual([]);
      }
    }
  });
});

describe('the conflict names the FIGURE, not only the two claims about it', () => {
  it('detIndex indexes the caller’s figures[] — including past figures the pairing drops', () => {
    for (const v of fx.versions.filter((x: any) => x.kind === 'vote-fires')) {
      const report = checkIdentityAgreement(clone(v.matches), clone(v.detectorFigures));
      for (const c of report.conflicts) {
        expect(typeof c.detIndex, v.key).toBe('number');
        expect(v.detectorFigures[c.detIndex].name, v.key).toBe(c.detector);
      }
    }
  });

  it('an UNKNOWN figure in front of the contested one does not shift the index', () => {
    const v = byKey('job_1789147573901_m3uam0nxi|p2|v0');
    // UNKNOWN figures are filtered out of the pairing — the detector routinely
    // sees background people nobody matched — so an index taken after that
    // filter would point at the wrong figure.
    const padded = [{ name: 'UNKNOWN', bodyBox: [0.0, 0.0, 0.1, 0.1] }, ...clone(v.detectorFigures)];
    const report = checkIdentityAgreement(clone(v.matches), padded);
    expect(report.conflicts.length).toBeGreaterThan(0);
    for (const c of report.conflicts) expect(padded[c.detIndex].name).toBe(c.detector);
  });
});

describe('the two named pages', () => {
  it('rts4wqupm p18 — the regression Part 1 exposed — is a page the vote is asked about', async () => {
    const v = byKey('job_1789584708605_rts4wqupm|p18|v0');
    expect(v.kind).toBe('vote-fires');
    // Judged on the pixels against the stored clothing contract, the EVALUATOR
    // had all four boys right here. A witness that agrees with the evaluator is
    // what withdraws the rename; a witness that agrees with the detector leaves
    // it exactly as it shipped. Both are asserted, because which one the real
    // witness produces is NOT measured.
    const report = checkIdentityAgreement(clone(v.matches), clone(v.detectorFigures));
    const withheld = evalLikeOf(v);
    const rW = await reconcileIdentityWithSecondWitness(withheld, clone(v.detectorFigures), {
      secondOpinion: witnessBackingEvaluator(report),
    });
    expect(rW.renamed).toBe(0);
    expect(refs(withheld)).toEqual(v.matches.map((m: any) => m.reference));

    const applied = evalLikeOf(v);
    const rA = await reconcileIdentityWithSecondWitness(applied, clone(v.detectorFigures), {
      secondOpinion: witnessBackingDetector(v.detectorFigures),
    });
    expect(rA.renamed).toBe(v.renamedByPart1);
  });

  it('wkt20ckod p12 — the motivating page — is a page the vote is asked about', async () => {
    const v = byKey('job_1789681157795_wkt20ckod|p12|v1');
    expect(v.kind).toBe('vote-fires');
    expect(v.conflictPairs).toEqual(['Kiaan->Julian', 'Julian->Kiaan']);
    const report = checkIdentityAgreement(clone(v.matches), clone(v.detectorFigures));
    const withheld = evalLikeOf(v);
    const r = await reconcileIdentityWithSecondWitness(withheld, clone(v.detectorFigures), {
      secondOpinion: witnessBackingEvaluator(report),
    });
    expect(r.renamed).toBe(0);
    expect(refs(withheld)).toEqual(v.matches.map((m: any) => m.reference));
  });
});
