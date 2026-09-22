import { describe, it, expect } from 'vitest';
// @ts-ignore — CommonJS module
import { checkDeclaredGaze, observedGaze } from '../../server/lib/gazeCheck.js';
// @ts-ignore — CommonJS module
import { pairInventoryFiguresToNames } from '../../server/lib/identityAgreement.js';
import FIXTURE from './fixtures/gaze-declared-vs-observed-job_1789853503332_riqncqg1i.json';

/**
 * Six real pages of job_1789853503332_riqncqg1i, each half from the producer
 * that made it: the BRIEF's `looksAt`, the SIGHTED evaluator's named
 * `matches[]`, and the PROMPT-BLIND describer's `figures[].gaze` (Lab 1379, on
 * qwen3-vl — the model production runs). Nothing here is hand-written.
 *
 * WHAT MAY FIRE AND WHAT MAY NOT was decided by measurement. All 18 pages were
 * described blind; twelve were then described a SECOND time by an independent
 * reader working from the image alone, and the two were compared per figure:
 *
 *   `at <another figure>`  agreed every time              -> fires
 *   `at the viewer`        wrong on p6, p7, p8, p10, p18  -> never fires
 *
 * The describer writes `at the viewer` for any gaze leaving the frame on the
 * camera's side and cannot separate eyes ON the reader from eyes PAST them. On
 * p7 it called three children `at the viewer` who are looking straight at the
 * character the brief named — three MAJOR findings, each of which would have
 * bought a repair on a correct figure.
 */
const PAGES: any = FIXTURE.pages;
// The brief stores Visual Bible ids; a finding has to say the noun.
const NOUNS: Record<string, string> = { ART001: 'large egg', ANI001: 'Zippi', LOC002: 'Schipfe Steps' };
const resolveTarget = (id: string) => NOUNS[id] ?? null;

const run = (page: string) => checkDeclaredGaze({
  declared: PAGES[page].declared,
  inventory: PAGES[page].inventory,
  matches: PAGES[page].matches,
  resolveTarget,
});

describe('reading the blind describer\'s per-figure gaze', () => {
  it('reads eyes resting on another figure in the same picture', () => {
    expect(observedGaze(PAGES['6'].inventory, 'the young boy in green jacket'))
      .toEqual({ kind: 'figure', label: 'the young boy in orange hoodie' });
  });

  it('reads eyes meeting the camera as its own kind, separate from a figure', () => {
    expect(observedGaze(PAGES['2'].inventory, 'the young boy in red')).toEqual({ kind: 'viewer' });
  });

  it('reads eyes on an object as a THING, which nothing can be compared against', () => {
    // The describer names objects in its own words and the brief names them in
    // the Bible's. Comparing the two would be prose matching.
    expect(observedGaze(PAGES['17'].inventory, 'the child in yellow vest'))
      .toEqual({ kind: 'thing', label: 'the small green creature' });
  });

  it('says nothing when the eyes could not be read, and nothing about an absent figure', () => {
    expect(observedGaze(PAGES['6'].inventory, 'the young boy in orange hoodie')).toBeNull();
    expect(observedGaze(PAGES['6'].inventory, 'a boy who is not there')).toBeNull();
  });
});

describe('what fires, on the pages it was measured against', () => {
  it('p6: the boy whose eyes are on another child, not on the declared egg', () => {
    const f = run('6');
    expect(f).toHaveLength(1);
    expect(f[0].character).toBe('Kiaan');
    expect(f[0].type).toBe('action_interaction');
    expect(f[0].severity).toBe('MAJOR');
    expect(f[0].source).toBe('gaze-check');
    expect(f[0].description).toContain('large egg');            // the noun, never ART001
    expect(f[0].description).toContain('the eyes are on the young boy in orange hoodie');
  });

  it('p15: two boys declared on the egg with their eyes on each other', () => {
    expect(run('15').map((x: any) => x.character).sort()).toEqual(['Kiaan', 'Max']);
  });

  it('p5: silent — declared mutual, observed mutual, the witnesses agree', () => {
    expect(run('5')).toEqual([]);
  });
});

describe('the answer that is measured but never fired', () => {
  it('p2: the egg-holder IS looking out of the picture, and it is not reported', () => {
    // Confirmed by eye and by the independent reader: he meets the reader
    // instead of looking at the egg in his own arms. The describer is right
    // here — and wrong often enough elsewhere that this branch cannot fire.
    expect(observedGaze(PAGES['2'].inventory, 'the young boy in red')).toEqual({ kind: 'viewer' });
    expect(run('2')).toEqual([]);
  });

  it('p7: the three children the describer wrongly called `at the viewer` are silent', () => {
    // The independent reader puts them on the boy in blue — exactly the
    // character the brief named. Firing here would have been false MAJORs.
    const viewerCalls = PAGES['7'].inventory.figures.filter((f: any) => /viewer/i.test(String(f.gaze)));
    expect(viewerCalls.length).toBeGreaterThanOrEqual(3);
    expect(run('7')).toEqual([]);
  });
});

describe('every uncertainty is a skip, never a finding', () => {
  const p6 = PAGES['6'];

  it('no declared gaze — nothing to contradict', () => {
    expect(checkDeclaredGaze({
      declared: p6.declared.map((c: any) => ({ name: c.name })),
      inventory: p6.inventory, matches: p6.matches, resolveTarget,
    })).toEqual([]);
  });

  it('no pairing — the finding could not name anyone truthfully', () => {
    expect(checkDeclaredGaze({
      declared: p6.declared, inventory: p6.inventory, matches: [], resolveTarget,
    })).toEqual([]);
  });

  it('declared at a person and observed at that same person is agreement', () => {
    expect(checkDeclaredGaze({
      declared: [{ name: 'Kiaan', looksAt: 'Max' }],
      inventory: p6.inventory, matches: p6.matches, resolveTarget,
    })).toEqual([]);
  });

  it('an unnamed figure is never the target of a finding', () => {
    // p17's creature: the brief says ANI001 and the describer says "the small
    // green creature" — the same animal twice, which used to read as a defect.
    expect(run('17')).toEqual([]);
  });

  it('eyes on a person who is HOLDING something are not evidence of a wrong gaze', () => {
    const inv = {
      ...p6.inventory,
      figures: p6.inventory.figures.map((f: any) =>
        f.label === 'the young boy in orange hoodie'
          ? { ...f, items_held: { left: 'a large egg', right: 'a large egg' } } : f),
    };
    expect(checkDeclaredGaze({
      declared: p6.declared, inventory: inv, matches: p6.matches, resolveTarget,
    })).toEqual([]);
  });

  it('a Visual Bible id the bible cannot name is a skip, not a finding with an id in it', () => {
    expect(checkDeclaredGaze({
      declared: p6.declared, inventory: p6.inventory, matches: p6.matches,
      resolveTarget: () => null,
    })).toEqual([]);
    expect(checkDeclaredGaze({
      declared: p6.declared, inventory: p6.inventory, matches: p6.matches,
      resolveTarget: (t: string) => t,      // hands back the raw id
    })).toEqual([]);
  });

  it('returns nothing at all without an inventory or a brief', () => {
    expect(checkDeclaredGaze({ declared: p6.declared, inventory: null, matches: p6.matches })).toEqual([]);
    expect(checkDeclaredGaze({})).toEqual([]);
  });
});

/**
 * THE REPAIRED RENDERS (Lab 1383/1384 inpaint, described by Lab 1385/1386).
 *
 * A detector that cannot tell a fixed page from a broken one is worse than no
 * detector, so the repaired images are pinned here beside the broken ones.
 */
describe('after the page was actually repaired', () => {
  const runAfter = (page: string) => checkDeclaredGaze({
    declared: PAGES[page].declared, inventory: PAGES[page].inventory,
    matches: PAGES[page].matches, resolveTarget,
  });

  it('p6: three of the four eyes moved onto the egg, and only the fourth is still reported', () => {
    const before = PAGES['6'].inventory.figures.filter((f: any) => /egg/i.test(String(f.gaze))).length;
    const after = PAGES['6_after_repair'].inventory.figures.filter((f: any) => /egg/i.test(String(f.gaze))).length;
    expect(before).toBe(0);
    expect(after).toBe(3);
    const f = runAfter('6_after_repair');
    expect(f).toHaveLength(1);
    expect(f[0].character).toBe('Levin');            // genuinely still on another child
  });

  it('p18: eyes that landed on the child CARRYING the target are not a defect', () => {
    // The repair moved all three from "at the viewer" onto the boy in yellow —
    // who is holding the dragon they were sent to look at. Eyes on a carrier and
    // eyes on what they carry are one ray.
    const carrier = PAGES['18_after_repair'].inventory.figures
      .find((x: any) => /yellow/.test(x.label));
    expect(JSON.stringify(carrier.items_held)).toMatch(/dragon/i);
    expect(runAfter('18_after_repair')).toEqual([]);
  });

  it('the carrier guard holds even though the target is a NAMED cast member', () => {
    // `looksAt: ANI001` resolves to "Zippi", a name, which used to route past
    // the guard down the person-to-person branch and fire three false MAJORs.
    expect(PAGES['18_after_repair'].declared.some((d: any) => d.looksAt === 'ANI001')).toBe(true);
    expect(NOUNS.ANI001).toBe('Zippi');
    expect(runAfter('18_after_repair')).toEqual([]);
  });
});

describe('the figure-to-name pairing the two witnesses share', () => {
  it('pairs blind figures to evaluator names by where they stand', () => {
    const pairs = pairInventoryFiguresToNames(PAGES['6'].matches, PAGES['6'].inventory.figures);
    expect(pairs.size).toBeGreaterThanOrEqual(3);
    expect(new Set(pairs.values()).size).toBe(pairs.size);     // one-to-one
  });

  it('never pairs a figure to the evaluator\'s literal `unmatched`', () => {
    // `unmatched` is the evaluator's word for "a person I could not name". It
    // paired as though it were a character on p10 of this story.
    const figs = [{ label: 'the boy in blue', body_bbox: [0.1, 0.1, 0.3, 0.9] }];
    expect(pairInventoryFiguresToNames(
      [{ reference: 'unmatched', confidence: 0, body_bbox: [0.1, 0.1, 0.3, 0.9] }], figs).size).toBe(0);
    expect(pairInventoryFiguresToNames(
      [{ reference: 'Levin', confidence: 0.9, body_bbox: [0.1, 0.1, 0.3, 0.9] }], figs).size).toBe(1);
  });

  it('pairs nobody when a witness is missing, rather than guessing', () => {
    expect(pairInventoryFiguresToNames([], PAGES['6'].inventory.figures).size).toBe(0);
    expect(pairInventoryFiguresToNames(PAGES['6'].matches, []).size).toBe(0);
  });
});
