import { describe, it, expect } from 'vitest';
// @ts-ignore — CommonJS module
import { checkDeclaredGaze, observedGaze, eyesNotVisible } from '../../server/lib/gazeCheck.js';
// @ts-ignore — CommonJS module
import { pairInventoryFiguresToNames } from '../../server/lib/identityAgreement.js';
import FIXTURE from './fixtures/gaze-declared-vs-observed-job_1789853503332_riqncqg1i.json';

/**
 * Three real pages of job_1789853503332_riqncqg1i, each half captured from the
 * producer that actually made it: the BRIEF's `looksAt`, the SIGHTED evaluator's
 * named `matches[]`, and the PROMPT-BLIND describer's `figures` + `interactions`
 * (Lab experiment 1376, unified arm). Nothing here is hand-written.
 *
 *   p2  two boys, both declared on the egg. Levin IS looking straight out of
 *       the picture — but no field in the blind inventory describes eyes on
 *       their own, so nothing witnesses it. Silence, and the reason is a gap
 *       (see the `facing` note in observedGaze), not a judgement.
 *   p5  the same two, declared looking at each other. The describer reports no
 *       gaze for either. Silence — an absent witness is never a finding.
 *   p6  four boys, all declared on the egg on the ground. The describer sees two
 *       pairs looking at EACH OTHER and says so four times. Four findings.
 *
 * The page the owner reported by eye is p6, and the quality judge scored it 85
 * with zero findings: asked for a `gaze` it answered "down at the large warm
 * egg" for all four, including the two it had itself recorded as seen from
 * behind. It was reading the brief back. That is the whole reason this file
 * compares the BLIND observation instead of asking the sighted judge again.
 */
const PAGES: any = FIXTURE.pages;
const CAST = ['Levin', 'Julian', 'Max', 'Kiaan'];
// ART001 is the Visual Bible's id for the egg. The brief stores the id; the
// finding has to say the noun.
const resolveTarget = (id: string) => (id === 'ART001' ? 'the large warm egg' : id);

const run = (page: string) => checkDeclaredGaze({
  declared: PAGES[page].declared,
  inventory: PAGES[page].inventory,
  matches: PAGES[page].matches,
  castNames: CAST,
  resolveTarget,
});

describe('the figure-to-name pairing these two witnesses share', () => {
  it('pairs every blind figure with the evaluator name standing in that spot', () => {
    // Four same-age boys in a row is the hardest case the page set has.
    const pairs = pairInventoryFiguresToNames(PAGES['6'].matches, PAGES['6'].inventory.figures);
    expect(Object.fromEntries(pairs)).toEqual({
      'the young boy in red': 'Levin',
      'the young boy in yellow': 'Julian',
      'the young boy in orange': 'Max',
      'the young boy in olive green': 'Kiaan',
    });
  });

  it('is one-to-one — no name is handed to two figures', () => {
    const pairs = pairInventoryFiguresToNames(PAGES['6'].matches, PAGES['6'].inventory.figures);
    expect(new Set(pairs.values()).size).toBe(pairs.size);
  });

  it('pairs nobody when a witness is missing, rather than guessing', () => {
    expect(pairInventoryFiguresToNames([], PAGES['6'].inventory.figures).size).toBe(0);
    expect(pairInventoryFiguresToNames(PAGES['6'].matches, []).size).toBe(0);
  });

  it('leaves a figure standing where nobody was matched unpaired', () => {
    const far = [{ reference: 'Levin', body_bbox: [0.9, 0.9, 0.99, 0.99] }];
    expect(pairInventoryFiguresToNames(far, PAGES['6'].inventory.figures).size).toBe(0);
  });
});

describe('what the blind describer is willing to witness', () => {
  it('reads a look out of an interactions entry', () => {
    expect(observedGaze(PAGES['6'].inventory, 'the young boy in red'))
      .toEqual({ kind: 'figure', label: 'the young boy in yellow' });
  });

  it('does NOT read a look out of a body-facing entry', () => {
    // p2's only interaction is "faces him" — that is the torso, not the eyes.
    expect(observedGaze(PAGES['2'].inventory, 'the young boy in yellow')).toBeNull();
  });

  it('does NOT read a look out of a hand-contact entry', () => {
    // p5's only interaction is a hand cupped to an ear.
    expect(observedGaze(PAGES['5'].inventory, 'the young boy in yellow')).toBeNull();
  });

  it('does NOT treat a body squared to camera as a gaze observation', () => {
    // `facing: "toward viewer"` is the torso. The eyes have no field of their own.
    expect(PAGES['2'].inventory.figures[0].facing).toBe('toward viewer');
    expect(observedGaze(PAGES['2'].inventory, 'the young boy in red')).toBeNull();
  });

  it('says nothing about a figure it never mentions', () => {
    expect(observedGaze(PAGES['6'].inventory, 'a boy who is not there')).toBeNull();
    expect(eyesNotVisible(PAGES['6'].inventory, 'a boy who is not there')).toBe(false);
  });
});

describe('declared gaze vs observed gaze, on the pages it was measured against', () => {
  it('p2: silent — a body square to camera is not a witness to where the eyes went', () => {
    // Levin really is looking at the reader instead of at the egg in his hands,
    // and this check does not catch it. It used to, by reading `facing:
    // "toward viewer"` as gaze — but `facing` is a BODY field, and on this very
    // page it read "toward viewer" for BOTH boys while only one of them meets
    // the reader's eye (Julian's are cast down and to his left). One true
    // finding and one false one from one signal; the false one would have
    // bought a paid repair on a correct figure.
    expect(run('2')).toEqual([]);
  });

  it('p5: stays silent — the witness reported no gaze at all', () => {
    expect(run('5')).toEqual([]);
  });

  it('p6: all four are declared on the egg and all four are looking at each other', () => {
    const f = run('6');
    expect(f.map((x: any) => x.character).sort()).toEqual(['Julian', 'Kiaan', 'Levin', 'Max']);
    expect(f.every((x: any) => x.severity === 'MAJOR')).toBe(true);
    expect(f.find((x: any) => x.character === 'Levin').description)
      .toContain('the eyes are on the young boy in yellow');
  });
});

/**
 * THE SAME THREE PAGES, THE OTHER DESCRIBER.
 *
 * The fixture above came from gemini-2.5-flash; PRODUCTION runs qwen3-vl
 * (runtime.js `inventoryModel`, every environment since 2026-09-19). A check
 * validated only against the model production does not run is not validated —
 * so Lab experiment 1377 put the same three pages through the real one.
 *
 * It answers in its own words ("the child in red", not "the young boy in red")
 * and on its own box scale (mixed 0-1 / 0-1000, normalised here exactly as
 * evalPipeline.js does before the inventory leaves the call). Two independent
 * describers, no shared vocabulary, no shared numbers — and the same three
 * verdicts. That is what makes the join geometric rather than lexical: nothing
 * in this check reads a label except to print it.
 */
describe('the describer production actually runs (qwen3-vl, Lab 1377)', () => {
  const runQwen = (page: string) => checkDeclaredGaze({
    declared: PAGES[page].declared,
    inventory: PAGES[page].inventoryQwen,
    matches: PAGES[page].matches,
    castNames: CAST,
    resolveTarget,
  });

  it('p2: the same silence, and for the same reason', () => {
    // qwen reports one look — yellow -> red, a LOOK relation — but the brief
    // sends the boy in yellow to the egg and the boy he is looking at is
    // holding it, so the hands-full guard declines. Nothing else is a witness.
    expect(runQwen('2')).toEqual([]);
  });

  it('p5: the same silence — here because the two witnesses AGREE', () => {
    // qwen does report a look ("the child in red jacket ... looks at the child
    // in yellow vest") and the brief declares exactly that. Agreement, not
    // absence of evidence.
    expect(runQwen('5')).toEqual([]);
  });

  it('p6: the same four findings, naming the same four children', () => {
    const f = runQwen('6');
    expect(f.map((x: any) => x.character).sort()).toEqual(['Julian', 'Kiaan', 'Levin', 'Max']);
  });

  it('the two describers share no figure label, and still pair to the same names', () => {
    const g = pairInventoryFiguresToNames(PAGES['6'].matches, PAGES['6'].inventory.figures);
    const q = pairInventoryFiguresToNames(PAGES['6'].matches, PAGES['6'].inventoryQwen.figures);
    expect([...q.values()].sort()).toEqual([...g.values()].sort());
    // no label is spelled the same way by both models
    for (const label of q.keys()) expect(g.has(label)).toBe(false);
  });
});

describe('every uncertainty is a skip, never a finding', () => {
  const p6 = PAGES['6'];

  it('no declared gaze — nothing to contradict', () => {
    expect(checkDeclaredGaze({
      declared: p6.declared.map((c: any) => ({ name: c.name })),
      inventory: p6.inventory, matches: p6.matches, castNames: CAST, resolveTarget,
    })).toEqual([]);
  });

  it('no pairing — the finding could not name anyone truthfully', () => {
    expect(checkDeclaredGaze({
      declared: p6.declared, inventory: p6.inventory, matches: [], castNames: CAST, resolveTarget,
    })).toEqual([]);
  });

  it('eyes turned from the camera cannot be judged', () => {
    const inv = {
      ...p6.inventory,
      figures: p6.inventory.figures.map((f: any) => ({ ...f, facing: 'away from viewer' })),
    };
    expect(checkDeclaredGaze({
      declared: p6.declared, inventory: inv, matches: p6.matches, castNames: CAST, resolveTarget,
    })).toEqual([]);
  });

  it('declared at a person and observed at that same person is agreement', () => {
    // Levin's brief sends his eyes to Julian; the describer puts them on the
    // figure paired to Julian. The two agree, so nothing is reported.
    const declared = [{ name: 'Levin', looksAt: 'Julian' }];
    expect(checkDeclaredGaze({
      declared, inventory: p6.inventory, matches: p6.matches, castNames: CAST, resolveTarget,
    })).toEqual([]);
  });

  it('declared at a person and observed at a DIFFERENT person is the finding', () => {
    const declared = [{ name: 'Levin', looksAt: 'Kiaan' }];
    const f = checkDeclaredGaze({
      declared, inventory: p6.inventory, matches: p6.matches, castNames: CAST, resolveTarget,
    });
    expect(f).toHaveLength(1);
    expect(f[0].description).toContain('the eyes are on the young boy in yellow');
  });

  it('eyes on a person who is HOLDING something are not evidence of a wrong gaze', () => {
    // The confound: a gaze declared at an object and observed on the person
    // carrying it is two true descriptions of one picture, not a defect.
    const inv = {
      ...p6.inventory,
      figures: p6.inventory.figures.map((f: any) =>
        f.label === 'the young boy in yellow'
          ? { ...f, items_held: { left: 'a large egg', right: 'a large egg' } } : f),
    };
    expect(checkDeclaredGaze({
      declared: [{ name: 'Levin', looksAt: 'ART001' }],
      inventory: inv, matches: p6.matches, castNames: CAST, resolveTarget,
    })).toEqual([]);
  });

  it('a target the pairing never named still carries the contradiction', () => {
    // The brief says "the egg"; the eyes are on a person. That the person has
    // no name only changes how the sentence reads, not whether it is true.
    const matches = p6.matches.filter((m: any) => m.reference === 'Levin');
    const f = checkDeclaredGaze({
      declared: [{ name: 'Levin', looksAt: 'ART001' }],
      inventory: p6.inventory, matches, castNames: CAST, resolveTarget,
    });
    expect(f).toHaveLength(1);
    expect(f[0].description).toContain('the eyes are on the young boy in yellow');
  });

  it('a Visual Bible id the bible cannot name is a skip, not a finding with an id in it', () => {
    // `looksAt` holds an id as often as a name. A finding saying "declared
    // looking at ART001" is unreadable and unrepairable, and it leaks a VB id
    // into text — so the page goes unreported instead.
    const unresolvable = () => null;
    expect(checkDeclaredGaze({
      declared: p6.declared, inventory: p6.inventory, matches: p6.matches,
      castNames: CAST, resolveTarget: unresolvable,
    })).toEqual([]);
    // and the same page, once the id resolves, is four findings
    expect(run('6')).toHaveLength(4);
  });

  it('never prints a raw Visual Bible id even if a resolver hands one back', () => {
    const f = checkDeclaredGaze({
      declared: p6.declared, inventory: p6.inventory, matches: p6.matches,
      castNames: CAST, resolveTarget: (t: string) => t,      // resolves to the id itself
    });
    expect(f).toEqual([]);
  });

  it('returns nothing at all without an inventory', () => {
    expect(checkDeclaredGaze({ declared: p6.declared, inventory: null, matches: p6.matches })).toEqual([]);
    expect(checkDeclaredGaze({})).toEqual([]);
  });
});
