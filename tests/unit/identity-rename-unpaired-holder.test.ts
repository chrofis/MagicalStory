import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { reconcileIdentity, checkIdentityAgreement } = require_('../../server/lib/identityAgreement');
const { canonicalName } = require_('../../server/lib/castResolver');

// THE DEFECT (2026-09-18). The 2026-09-14 fix stopped a rename from targeting a
// name an AGREED match held. It left every OTHER holder unprotected — and an
// unprotected holder is the common case, not the rare one.
//
// `checkIdentityAgreement` pairs greedily by nearest centre with no mutual
// exclusion, and it only pairs an evaluator name the detector used SOMEWHERE
// and found within maxCentreDistance. Everything else lands in `unpaired`:
// a name the detector never assigned, a figure whose nearest counterpart was
// too far away, an animal the detector does not name at all. A match carrying
// no box is filtered out before the pairing even starts, so it appears in
// neither list. All of them still hold their name in `matches[]`, and
// `reconcileIdentity` rewrites `matches[]`.
//
// So a conflict pointing at an unpaired holder's name passed the agreed-only
// check and was applied: one name onto two matches, the other name gone, and
// every finding about the erased character relabelled onto somebody the spec
// never cast in that role.
//
// Replayed over every stored version carrying both an evaluator `matches[]` and
// a detector `bboxDetection.figures[]` — 1,194 on staging, 317 on production —
// the agreed-only guard still let 11 (staging) and 12 (prod) renames fabricate a
// duplicate. Two of the three versions below are those duplicates as PRODUCTION
// STORED THEM; the third is one the current code would newly introduce on a
// record written before the reconciler existed.
const fx = require_('./fixtures/identity-rename-unpaired-holder.json');

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const canon = (n: any) => canonicalName(n);
const dupes = (refs: any[]) => {
  const seen = new Map<string, number>();
  for (const r of refs.filter(Boolean)) seen.set(canon(r), (seen.get(canon(r)) || 0) + 1);
  return [...seen.entries()].filter(([, n]) => n > 1).map(([c]) => c).sort();
};

const byStory = (frag: string) =>
  fx.versions.find((v: any) => v.storyId.includes(frag));

describe('a rename never targets a name another match still holds (real stored versions)', () => {
  it('the stored shapes carry no genuine ambiguity — both sides named the same people', () => {
    // This is what makes the erasure indefensible: on every one of these pages
    // the detector's roster is a SUBSET of the evaluator's names, spelled the
    // same way. Nothing was in dispute; the conflict is a pairing artefact.
    for (const v of fx.versions) {
      const evNames = new Set(v.matches.map((m: any) => canon(m.reference)));
      for (const f of v.detectorFigures) {
        expect(evNames.has(canon(f.name))).toBe(true);
      }
    }
  });

  it('production really did ship the duplicate where it applied the rename', () => {
    const applied = fx.versions.filter((v: any) => v.storedRenamed > 0);
    expect(applied.length).toBe(2);
    for (const v of applied) {
      // What is in the database today: one name twice, and one name gone.
      expect(dupes(v.storedReferences).length).toBeGreaterThan(0);
      const lost = v.matches
        .map((m: any) => canon(m.reference))
        .filter((n: string) => !v.storedReferences.map(canon).includes(n));
      expect(lost.length).toBeGreaterThan(0);
    }
    // job_1787469664089_9e27p42el7l p6 lost Saira to a second Facundo...
    expect(byStory('9e27p42el7l').storedReferences).toEqual(
      ['Sarah', 'Facundo', 'Fiona', 'Facundo', 'Lorena']);
    // ...and job_1788727233899_1dpnym94p p18 lost Julian to a second Levin.
    expect(byStory('1dpnym94p').storedReferences).toEqual(
      ['Kiaan', 'Max', 'Levin', 'Levin', 'Nia']);
  });

  for (const v of fx.versions) {
    it(`leaves every name on exactly one figure — ${v.storyId} p${v.pageNumber} (${v.why})`, () => {
      const evalLike = {
        matches: clone(v.matches),
        fixableIssues: clone(v.fixableIssues),
        fixTargets: clone(v.fixTargets),
      };
      const before = evalLike.matches.map((m: any) => m.reference);
      const report = reconcileIdentity(evalLike, clone(v.detectorFigures));
      const after = evalLike.matches.map((m: any) => m.reference);

      // The disagreement is still MEASURED — the guard is not "pretend they agree".
      expect(report.conflicts.length).toBeGreaterThan(0);
      expect(report.uncorrectable).toBe(true);
      expect(report.renamed).toBe(0);

      // No duplicate fabricated, and nobody dropped off the page.
      expect(dupes(after)).toEqual(dupes(before));
      expect(after.map(canon)).toEqual(before.map(canon));
    });
  }

  it('the target was held by an UNPAIRED match, which is why agreedNames could not see it', () => {
    // p4: the detector named all four people, so NOTHING agreed — agreedNames is
    // empty and the 09-14 guard has nothing to test against. Levin is unpaired
    // (its nearest detector centre is another figure's) and still holds "Levin".
    const v = byStory('mfedxinwqd');
    const report = checkIdentityAgreement(clone(v.matches), clone(v.detectorFigures));
    expect(report.agreed).toBe(0);
    expect(report.agreedNames).toEqual([]);
    expect(report.conflicts.map((c: any) => `${c.evaluator}->${c.detector}`)).toEqual(['Julian->Levin']);
    expect(report.unpaired).toContain('Levin');
    // heldNames is the set the guard actually needs: every name on a figure.
    expect(report.heldNames).toContain('Levin');
    expect(report.heldNames).toContain('Julian');
  });

  it('heldNames counts a match the pairing never looked at — one with no box', () => {
    // A box-less match is filtered out before pairing, so it is in neither
    // `agreedNames` nor `unpaired`. It still holds its name in matches[].
    const v = byStory('9e27p42el7l');
    const matches = clone(v.matches);
    const boxless = matches.find((m: any) => m.reference === 'Facundo');
    delete boxless.body_bbox;
    delete boxless.face_bbox;

    const report = checkIdentityAgreement(matches, clone(v.detectorFigures));
    expect(report.agreedNames).not.toContain('Facundo');
    expect(report.unpaired || []).not.toContain('Facundo');
    expect(report.heldNames).toContain('Facundo');

    const evalLike = { matches: clone(matches), fixableIssues: [], fixTargets: [] };
    reconcileIdentity(evalLike, clone(v.detectorFigures));
    const refs = evalLike.matches.map((m: any) => m.reference);
    expect(dupes(refs)).toEqual([]);
    expect(refs).toContain('Facundo');
    expect(refs).toContain('Saira');
  });

  it('a refused rename relabels no finding and no fix target', () => {
    const v = byStory('1dpnym94p');
    const evalLike = {
      matches: clone(v.matches),
      fixableIssues: clone(v.fixableIssues),
      fixTargets: clone(v.fixTargets),
    };
    const charsBefore = evalLike.fixableIssues.map((f: any) => f.character);
    const targetsBefore = evalLike.fixTargets.map((f: any) => f.affectedCharacter);
    reconcileIdentity(evalLike, clone(v.detectorFigures));

    expect(evalLike.fixableIssues.map((f: any) => f.character)).toEqual(charsBefore);
    expect(evalLike.fixTargets.map((f: any) => f.affectedCharacter)).toEqual(targetsBefore);
    for (const f of [...evalLike.fixableIssues, ...evalLike.fixTargets]) {
      expect(f.identityCorrected).toBeFalsy();
    }
    // The erased character really did carry findings of their own.
    expect(charsBefore.filter((c: string) => canon(c) === 'julian').length).toBeGreaterThan(0);
  });
});

// Detector boxes are [ymin, xmin, ymax, xmax]; evaluator boxes are
// [x1, y1, x2, y2]. Converting real stored detector boxes is how a constructed
// permutation pairs on the same centres the real records do.
function evalBoxOf(f: any) {
  const b = f.bodyBox || f.faceBox;
  return [b[1], b[0], b[3], b[2]];
}
const figuresOf = (frag: string, names: string[]) =>
  names.map(n => clone(byStory(frag).detectorFigures.find((f: any) => f.name === n)));

describe('the permutations a rename must still apply', () => {
  // The feature this guard exists to protect: where the names really are a
  // permutation among themselves, every name still lands on exactly one figure,
  // so the rename is lossless and must go through.
  const dets = figuresOf('1dpnym94p', ['Kiaan', 'Levin', 'Max']);

  it('a two-name swap still applies', () => {
    const evalLike = {
      matches: [
        { figure: 1, body_bbox: evalBoxOf(dets[0]), reference: 'Levin', confidence: 0.9 },
        { figure: 2, body_bbox: evalBoxOf(dets[1]), reference: 'Kiaan', confidence: 0.9 },
      ],
      fixableIssues: [{ character: 'Levin', severity: 'MAJOR', description: 'Levin is too tall', fix: 'x' }],
    };
    const report = reconcileIdentity(evalLike, [clone(dets[0]), clone(dets[1])]);
    expect(report.uncorrectable).toBeFalsy();
    expect(evalLike.matches.map((m: any) => m.reference)).toEqual(['Kiaan', 'Levin']);
    expect(evalLike.fixableIssues[0].character).toBe('Kiaan');
    expect(evalLike.fixableIssues[0].description).toBe('Kiaan is too tall');
  });

  it('a three-name cycle still applies', () => {
    const evalLike = {
      matches: [
        { figure: 1, body_bbox: evalBoxOf(dets[0]), reference: 'Levin', confidence: 0.9 },
        { figure: 2, body_bbox: evalBoxOf(dets[1]), reference: 'Max', confidence: 0.9 },
        { figure: 3, body_bbox: evalBoxOf(dets[2]), reference: 'Kiaan', confidence: 0.9 },
      ],
      fixableIssues: [],
    };
    const report = reconcileIdentity(evalLike, dets.map(clone));
    expect(report.uncorrectable).toBeFalsy();
    expect(evalLike.matches.map((m: any) => m.reference)).toEqual(['Kiaan', 'Levin', 'Max']);
  });

  it('a chain into a free name still applies — a vacated name IS available', () => {
    // Levin -> Kiaan, Max -> Levin. "Levin" is only a legal target because the
    // match holding it is renamed away in the same pass, and "Kiaan" is held by
    // nobody. Every name still lands on exactly one figure, so it must go
    // through: the guard refuses duplicates, not renames.
    const evalLike = {
      matches: [
        { figure: 1, body_bbox: evalBoxOf(dets[0]), reference: 'Levin', confidence: 0.9 },
        { figure: 2, body_bbox: evalBoxOf(dets[1]), reference: 'Max', confidence: 0.9 },
      ],
      fixableIssues: [],
    };
    const report = reconcileIdentity(evalLike, dets.map(clone));
    expect(report.uncorrectable).toBeFalsy();
    expect(evalLike.matches.map((m: any) => m.reference)).toEqual(['Kiaan', 'Levin']);
    expect(dupes(evalLike.matches.map((m: any) => m.reference))).toEqual([]);
  });

  it('but that chain is refused when another match still holds its far end', () => {
    // Identical conflict to the first leg above — Levin -> Kiaan — except a
    // second match, too far away to pair with anything, already holds "Kiaan"
    // and is not renamed away. This is the stored shape of mfedxinwqd p4.
    const evalLike = {
      matches: [
        { figure: 1, body_bbox: evalBoxOf(dets[0]), reference: 'Levin', confidence: 0.9 },
        { figure: 2, body_bbox: [0.90, 0.90, 0.99, 0.99], reference: 'Kiaan', confidence: 0.9 },
      ],
      fixableIssues: [],
    };
    const report = reconcileIdentity(evalLike, [clone(dets[0]), clone(dets[1])]);
    expect(report.conflicts.map((c: any) => `${c.evaluator}->${c.detector}`)).toEqual(['Levin->Kiaan']);
    expect(report.agreedNames).toEqual([]);          // agreed-only could not see it
    expect(report.heldNames).toContain('Kiaan');     // but somebody holds the target
    expect(report.renamed).toBe(0);
    expect(evalLike.matches.map((m: any) => m.reference)).toEqual(['Levin', 'Kiaan']);
  });

  it('a name held under a different spelling of the same person still blocks', () => {
    // canonicalName is the space checkIdentityAgreement decides agreement in, so
    // a trailing parenthetical must not hide a duplicate from the rename guard
    // either. Raw lower-case comparison would let this one through.
    const evalLike = {
      matches: [
        { figure: 1, body_bbox: evalBoxOf(dets[0]), reference: 'Levin', confidence: 0.9 },
        { figure: 2, body_bbox: [0.90, 0.90, 0.99, 0.99], reference: 'Kiaan (the older boy)', confidence: 0.9 },
      ],
      fixableIssues: [],
    };
    const report = reconcileIdentity(evalLike, [clone(dets[0]), clone(dets[1])]);
    expect(report.renamed).toBe(0);
    expect(evalLike.matches.map((m: any) => m.reference))
      .toEqual(['Levin', 'Kiaan (the older boy)']);
  });

  it('carries a duplicate the EVALUATOR itself produced, and does not add one', () => {
    // 123 of 1,194 stored staging versions already hold one name on two matches
    // before any rename — the evaluator's own output, not this module's doing.
    // A swap moves such a pair across intact; what it must never do is turn one
    // duplicate into two.
    const evalLike = {
      matches: [
        { figure: 1, body_bbox: evalBoxOf(dets[0]), reference: 'Levin', confidence: 0.9 },
        { figure: 2, body_bbox: evalBoxOf(dets[1]), reference: 'Kiaan', confidence: 0.9 },
        { figure: 3, body_bbox: [0.90, 0.90, 0.99, 0.99], reference: 'Kiaan', confidence: 0.9 },
      ],
      fixableIssues: [],
    };
    const before = evalLike.matches.map((m: any) => m.reference);
    reconcileIdentity(evalLike, [clone(dets[0]), clone(dets[1])]);
    const after = evalLike.matches.map((m: any) => m.reference);
    expect(dupes(before)).toEqual(['kiaan']);
    expect(dupes(after).length).toBe(dupes(before).length);
  });
});
