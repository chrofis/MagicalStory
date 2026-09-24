import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createRequire } from 'node:module';

// CJS registry, not vitest's ESM graph — the prompt store and scoring both
// reach each other with plain require() (see duplicate-object-type.test.ts).
const require_ = createRequire(import.meta.url);
const { buildExpectedCastBlock, parseFixableIssues, derivePresenceFinding, PRESENCE_DERIVED_MARKER } = require_('../../server/lib/evalPipeline');
const { deductionPoints, composeDeductions, SEVERITY_POINTS } = require_('../../server/lib/scoring');
const { bucketForType } = require_('../../server/lib/evalBuckets');
const { hasCriticalSeverityFinding, NOT_INPAINTABLE_TYPES } = require_('../../server/lib/repairLogic');
const { findBorrowedLabel } = require_('../../server/lib/charRepairTarget');
const { loadPromptTemplates, PROMPT_TEMPLATES, buildEvaluationPrompt } = require_('../../server/services/prompts');
const { log } = require_('../../server/utils/logger');

// `extra_character` (image-evaluation D-04b, owner decision 2026-09-10): a
// person or animal figure matching no EXPECTED CAST entry. Evidence: the front
// cover of job_1788903616404_iqvhj4l8m — four commissioned boys, five children
// painted, evaluator matched the fifth to a prose name at 0.9, PASS, 100/100.

const boys = [{ name: 'Aaron' }, { name: 'Ben' }, { name: 'Carl' }, { name: 'Dan' }];
const visualBible = {
  secondaryCharacters: [{ id: 'CHR001', name: 'Frau Meier', age: 'adult', hair: 'grey bun' }],
  animals: [{ id: 'ANI001', name: 'Nia', species: 'dog', coloring: 'black and white' }],
  artifacts: [{ id: 'ART001', name: 'kite' }],
};

// Every roster block now states how populated the page's setting is, so the
// judge reads the Art Director's own decision instead of re-deriving it from
// the prompt (2026-09-19). Absent, the page is cast-only.
const CAST_ONLY_LINE = '\nSETTING POPULATION: cast-only — this page holds the EXPECTED CAST and no other people.';

describe('buildExpectedCastBlock — page roster', () => {
  it('is blank when the caller knows NO cast (null), so the evaluator does not judge the count', () => {
    expect(buildExpectedCastBlock({ sceneCharacters: null })).toEqual({ block: '', names: [], count: 0, declared: false, population: 'cast_only', crowdExpected: false, nonHumanNames: [] });
    expect(buildExpectedCastBlock({}).block).toBe('');
  });

  // CROWD FLAG (owner, 2026-09-13). The derivation has no equivalent of the
  // evaluator's N-09 crowd exemption, so the brief declares it and the roster
  // carries it. Absent must read as "no crowd" — every story stored before the
  // field existed depends on that.
  it('carries the brief\'s crowd flag, and absent/false/garbage all read as no crowd', () => {
    const hint = (meta: object) => 'A busy square.\n\n---METADATA---\n' + JSON.stringify({ characters: [{ name: 'Aaron' }], ...meta });
    expect(buildExpectedCastBlock({ sceneCharacters: boys, sceneHint: hint({ crowdExpected: true }) }).crowdExpected).toBe(true);
    expect(buildExpectedCastBlock({ sceneCharacters: boys, sceneHint: hint({ crowdExpected: false }) }).crowdExpected).toBe(false);
    expect(buildExpectedCastBlock({ sceneCharacters: boys, sceneHint: hint({}) }).crowdExpected).toBe(false);
    // A row that predates the field, and a truthy non-boolean, are both "no crowd".
    expect(buildExpectedCastBlock({ sceneCharacters: boys, sceneMetadata: {} }).crowdExpected).toBe(false);
    expect(buildExpectedCastBlock({ sceneCharacters: boys, sceneMetadata: { crowdExpected: 'yes' } }).crowdExpected).toBe(false);
    // Also readable off fullData, which is where the prose-format parser keeps it.
    expect(buildExpectedCastBlock({ sceneCharacters: boys, sceneMetadata: { fullData: { crowdExpected: true } } }).crowdExpected).toBe(true);
  });

  it('a DECLARED cast of zero is a roster of zero, not a blank (D6, 2026-09-11)', () => {
    // `sceneCharacters: []` is the brief saying this frame holds nobody — a
    // creature-only page, a landscape. It used to return a blank block, and a
    // blank EXPECTED CAST tells the evaluator not to judge the figure count at
    // all, so the one page shape where every human figure is a defect was the
    // one shape with no cast check (job_1789147573901_m3uam0nxi p4: three
    // phantom children, no extra_character finding).
    const r = buildExpectedCastBlock({ sceneCharacters: [] });
    expect(r.declared).toBe(true);
    expect(r.count).toBe(0);
    expect(r.names).toEqual([]);
    expect(r.block).toBe('EXPECTED CAST (0): none — this frame was written with no people and no animals in it' + CAST_ONLY_LINE);
  });

  it('a declared-empty page still picks up the VB creature its metadata names', () => {
    // The early return used to sit ABOVE the secondary/animal expansion, so a
    // creature-only page got nothing at all instead of its creature.
    const sceneHint = 'A dog alone in the meadow.\n\n---METADATA---\n'
      + JSON.stringify({ characters: [{ name: 'ANI001' }] });
    const r = buildExpectedCastBlock({ sceneCharacters: [], sceneHint, visualBible, evaluationType: 'scene' });
    expect(r.declared).toBe(true);
    expect(r.names).toEqual(['ANI001']);
    expect(r.block).toBe('EXPECTED CAST (1): ANI001 (animal, dog)' + CAST_ONLY_LINE);
  });

  it('lists sceneCharacters plus the VB secondary AND animal the page metadata names, with the count', () => {
    const sceneHint = 'Four boys fly a kite while a dog barks.\n\n' +
      '---METADATA---\n' + JSON.stringify({ characters: [{ name: 'Aaron' }, { name: 'Ben' }, { name: 'Carl' }, { name: 'Dan' }, { name: 'CHR001' }, { name: 'ANI001' }] });
    const r = buildExpectedCastBlock({ sceneCharacters: boys, sceneHint, visualBible, evaluationType: 'scene' });
    expect(r.names).toEqual(['Aaron', 'Ben', 'Carl', 'Dan', 'CHR001', 'ANI001']);
    expect(r.count).toBe(6);
    expect(r.block).toBe('EXPECTED CAST (6): Aaron, Ben, Carl, Dan, CHR001 (secondary character), ANI001 (animal, dog)' + CAST_ONLY_LINE);
  });

  it('appends the detector figure count when one is supplied, and not otherwise', () => {
    const withDet = buildExpectedCastBlock({ sceneCharacters: boys, detectedFigureCount: 5 });
    expect(withDet.block).toBe('EXPECTED CAST (4): Aaron, Ben, Carl, Dan' + CAST_ONLY_LINE + '\nDetector figure count (GroundingDINO): 5');
    expect(buildExpectedCastBlock({ sceneCharacters: boys, detectedFigureCount: null }).block)
      .toBe('EXPECTED CAST (4): Aaron, Ben, Carl, Dan' + CAST_ONLY_LINE);
  });

  // COUNT PEOPLE AGAINST PEOPLE (owner, 2026-08-18). The roster the EVALUATOR
  // reads keeps the animals — they are on the page. The roster the presence
  // ARITHMETIC reads must not, because the detector's prompt is "person".
  it('flags the VB animals/creatures on the roster, by name AND by id', () => {
    const sceneHint = 'Four boys fly a kite while a dog barks.\n\n---METADATA---\n'
      + JSON.stringify({ characters: [{ name: 'Aaron' }, { name: 'Ben' }, { name: 'Carl' }, { name: 'Dan' }, { name: 'CHR001' }, { name: 'ANI001' }] });
    const r = buildExpectedCastBlock({ sceneCharacters: boys, sceneHint, visualBible, evaluationType: 'scene' });
    // The dog is filed by id here; the block still lists everyone.
    expect(r.nonHumanNames).toEqual(['ANI001']);
    expect(r.count).toBe(6);
    // The human secondary is NOT non-human.
    expect(r.nonHumanNames).not.toContain('CHR001');
  });

  it('flags an animal the cover description names by its NAME', () => {
    const r = buildExpectedCastBlock({
      sceneCharacters: boys, visualBible, evaluationType: 'cover',
      sceneHint: 'Aaron, Ben, Carl and Dan run down the hill with Nia the dog and a red kite.',
    });
    expect(r.nonHumanNames).toEqual(['Nia']);
  });

  it('a cast with no animals flags nothing', () => {
    expect(buildExpectedCastBlock({ sceneCharacters: boys, visualBible }).nonHumanNames).toEqual([]);
  });

  it('accepts bare name strings and dedupes case-insensitively', () => {
    const r = buildExpectedCastBlock({ sceneCharacters: ['Aaron', { name: 'aaron' }, 'Ben'] });
    expect(r.names).toEqual(['Aaron', 'Ben']);
  });
});

describe('buildExpectedCastBlock — cover roster', () => {
  it('is the commissioned cover cast plus every VB person/animal the cover description names, never an artifact', () => {
    const desc = 'Aaron, Ben, Carl and Dan run down the hill with Nia the dog and a red kite.';
    const r = buildExpectedCastBlock({ sceneCharacters: boys, sceneHint: desc, visualBible, evaluationType: 'cover' });
    expect(r.names).toEqual(['Aaron', 'Ben', 'Carl', 'Dan', 'Nia']);
    expect(r.count).toBe(5);
    expect(r.block).toBe('EXPECTED CAST (5): Aaron, Ben, Carl, Dan, Nia (animal, dog)' + CAST_ONLY_LINE);
  });

  it('does not add a VB entity the cover description never names', () => {
    const r = buildExpectedCastBlock({ sceneCharacters: boys, sceneHint: 'Four boys on a hill.', visualBible, evaluationType: 'cover' });
    expect(r.names).toEqual(['Aaron', 'Ben', 'Carl', 'Dan']);
  });

  it('a scene-type eval does not scan prose for VB names (metadata only)', () => {
    const r = buildExpectedCastBlock({ sceneCharacters: boys, sceneHint: 'Nia the dog barks.', visualBible, evaluationType: 'scene' });
    expect(r.names).toEqual(['Aaron', 'Ben', 'Carl', 'Dan']);
  });
});

describe('extra_character — scoring and taxonomy', () => {
  it('costs a full CRITICAL (25): no ceiling, never zero-point', () => {
    // No ceiling (a CATASTROPHIC claim is billed as claimed) and never zero-point.
    expect(deductionPoints({ type: 'extra_character', severity: 'CRITICAL' })).toBe(SEVERITY_POINTS.critical);
    expect(deductionPoints({ type: 'extra_character', severity: 'CATASTROPHIC' })).toBe(SEVERITY_POINTS.catastrophic);
    expect(deductionPoints({ type: 'extra_character', severity: 'MINOR' })).toBe(SEVERITY_POINTS.minor);
  });

  it('shares the character_presence bucket with missing_character', () => {
    expect(bucketForType('extra_character')).toBe('character_presence');
    expect(bucketForType('missing_character')).toBe('character_presence');
  });

  // Owner reversal 2026-09-24 (supersedes 2026-09-13): an `extra_character`
  // now means every cast member is matched and the figure is surplus, so the
  // removal cannot erase a commissioned character — inpaint may take it out.
  // The figure that might BE a missing member is `character_identity`, which
  // stays barred from inpaint and goes to a figure-targeted char-fix.
  it('is inpaintable (a confirmed surplus is removed); character_identity is not', () => {
    expect(NOT_INPAINTABLE_TYPES.has('extra_character')).toBe(false);
    expect(NOT_INPAINTABLE_TYPES.has('character_identity')).toBe(true);
  });
});

describe('derivePresenceFinding — the three-case presence model (owner, 2026-09-24)', () => {
  // The evaluator observes (`figures[]` + `matches[]`, one match per figure,
  // same ids and order); code derives from the match data alone:
  //   MISSING  a cast name no figure claims, no unmatched figure -> add it
  //   EXTRA    every cast name claimed, an unmatched figure      -> remove it
  //   MIXED    both -> redraw the unmatched figure as the missing name
  const roster = (names: string[], extra: object = {}) =>
    ({ names, count: names.length, declared: true, crowdExpected: false, block: '', ...extra });
  const figs = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i + 1 }));
  const matched = (refs: (string | null)[]) =>
    refs.map((r, i) => ({ figure: i + 1, reference: r ?? 'unmatched', confidence: r ? 0.9 : 0 }));
  const run = (o: object) => derivePresenceFinding(o);
  const types = (r: any) => r.findings.map((f: any) => f.type);
  const REMOVAL = /remove|delete|erase|paint out|take out/i;

  it('MISSING: a cast name no figure claims and no unmatched figure -> add, never a removal', () => {
    const r = run({
      figures: figs(3), matches: matched(['Aaron', 'Ben', 'Carl']),
      cast: roster(['Aaron', 'Ben', 'Carl', 'Dan']), detectedFigureCount: 3,
    });
    expect(r.outcome).toBe('missing_character');
    expect(r.findings).toHaveLength(1);
    const [f] = r.findings;
    expect(f).toMatchObject({ type: 'missing_character', severity: 'CRITICAL', character: 'Dan', item: 'Dan' });
    expect(f.fix).toMatch(/^Add Dan/);
    expect(f.fix).not.toMatch(REMOVAL);
  });

  it('EXTRA: every cast name claimed and an unmatched figure -> remove that figure', () => {
    const r = run({
      figures: figs(5), matches: matched(['Aaron', 'Ben', 'Carl', 'Dan', null]),
      cast: roster(['Aaron', 'Ben', 'Carl', 'Dan']), detectedFigureCount: 5,
    });
    expect(r.outcome).toBe('extra_character');
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ type: 'extra_character', character: 'figure 5', figure: 5 });
    expect(r.findings[0].fix).toBe('Remove this figure: it is not one of the characters this page holds.');
  });

  it('EXTRA includes a declared-empty roster (production job_1790107559778_fcmlfa8kn p7)', () => {
    const r = run({ figures: figs(2), matches: matched([null, null]), cast: roster([]), detectedFigureCount: 2 });
    expect(r.outcome).toBe('extra_character');
    expect(types(r)).toEqual(['extra_character', 'extra_character']);
    expect(r.findings.map((f: any) => f.figure)).toEqual([1, 2]);
    expect(run({ figures: [], matches: [], cast: roster([]), detectedFigureCount: 0 }))
      .toEqual({ outcome: 'reconciled', reason: null, findings: [] });
  });

  it('MIXED: a missing name and an unmatched figure -> redraw that figure as the name, never delete', () => {
    const r = run({
      figures: figs(4), matches: matched(['Aaron', 'Ben', 'Carl', null]),
      cast: roster(['Aaron', 'Ben', 'Carl', 'Dan']), detectedFigureCount: 4,
    });
    expect(r.outcome).toBe('character_identity');
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ type: 'character_identity', character: 'Dan', figure: 4 });
    expect(r.findings[0].fix).toMatch(/^Redraw figure 4 as Dan/);
    expect(r.findings[0].fix).not.toMatch(REMOVAL);
  });

  it('unequal counts: 1 missing + 2 unmatched -> the lower figure id is redrawn, the other removed', () => {
    const r = run({
      figures: figs(4), matches: matched(['Aaron', null, 'Ben', null]),
      cast: roster(['Aaron', 'Ben', 'Carl']), detectedFigureCount: 4,
    });
    expect(r.outcome).toBe('character_identity');
    expect(r.findings.map((f: any) => [f.type, f.character, f.figure])).toEqual([
      ['character_identity', 'Carl', 2],
      ['extra_character', 'figure 4', 4],
    ]);
  });

  it('unequal counts: 2 missing + 1 unmatched -> the first missing (roster order) is redrawn, the other added', () => {
    const r = run({
      figures: figs(2), matches: matched(['Aaron', null]),
      cast: roster(['Aaron', 'Ben', 'Carl']), detectedFigureCount: 2,
    });
    expect(r.findings.map((f: any) => [f.type, f.character])).toEqual([
      ['character_identity', 'Ben'],
      ['missing_character', 'Carl'],
    ]);
  });

  it('all matched -> nothing', () => {
    expect(run({
      figures: figs(4), matches: matched(['Aaron', 'Ben', 'Carl', 'Dan']),
      cast: roster(['Aaron', 'Ben', 'Carl', 'Dan']), detectedFigureCount: 4,
    })).toEqual({ outcome: 'reconciled', reason: null, findings: [] });
  });

  it('a crowd page with unmatched figures declines; a shortfall on a crowd page is still a shortfall', () => {
    const crowd = roster(['Aaron', 'Ben', 'Carl', 'Dan'], { crowdExpected: true });
    expect(run({ figures: figs(9), matches: matched(['Aaron', 'Ben', 'Carl', 'Dan', null, null, null, null, null]), cast: crowd, detectedFigureCount: 9 }))
      .toMatchObject({ outcome: 'declined', reason: 'crowd_expected', findings: [] });
    expect(run({ figures: figs(3), matches: matched(['Aaron', 'Ben', 'Carl']), cast: crowd, detectedFigureCount: 3 }).outcome)
      .toBe('missing_character');
  });

  describe('a photo-less cast entry explains an unmatched figure without a finding', () => {
    // UNMATCHED IS ONLY EVIDENCE WHEN THERE WAS SOMETHING TO MATCH AGAINST
    // (2026-09-13, kept). A Visual Bible secondary with no reference image can
    // only ever come back `unmatched`, so it pairs with an unmatched figure
    // FIRST and no finding is made. Measured on job_1789207854566_l43qgl34w.
    it('a photo-less secondary alone on the page emits NOTHING (p3)', () => {
      expect(run({
        figures: figs(1), matches: matched([null]),
        cast: roster(['Frau Amrein']), detectedFigureCount: 1, referenceNames: [],
      })).toEqual({ outcome: 'reconciled', reason: 'unclaimed_cast_has_no_reference', findings: [] });
    });

    it('a photo-less secondary beside a matched lead emits NOTHING (p4/p13), and is reconciled, not declined', () => {
      const r = run({
        figures: figs(2), matches: matched(['Fiona', null]),
        cast: roster(['Fiona', 'Frau Amrein']), detectedFigureCount: 2, referenceNames: ['Fiona'],
      });
      expect(r).toEqual({ outcome: 'reconciled', reason: 'unclaimed_cast_has_no_reference', findings: [] });
    });

    it('photo-less names pair first; the reference-backed missing name takes the next figure', () => {
      const r = run({
        figures: figs(3), matches: matched(['Aaron', null, null]),
        cast: roster(['Aaron', 'Frau Amrein', 'Dan']), detectedFigureCount: 3,
        referenceNames: ['Aaron', 'Dan'],
      });
      expect(r.findings.map((f: any) => [f.type, f.character, f.figure])).toEqual([['character_identity', 'Dan', 3]]);
    });

    it('matching is case-insensitive on both sides', () => {
      const r = run({
        figures: figs(2), matches: matched(['aaron', null]),
        cast: roster(['Aaron', 'Dan']), detectedFigureCount: 2, referenceNames: ['AARON', ' dan '],
      });
      expect(r.findings[0]).toMatchObject({ type: 'character_identity', character: 'Dan' });
    });

    it('no referenceNames supplied at all -> every name counts as reference-backed', () => {
      const r = run({
        figures: figs(2), matches: matched(['Fiona', null]),
        cast: roster(['Fiona', 'Frau Amrein']), detectedFigureCount: 2,
      });
      expect(r.findings[0]).toMatchObject({ type: 'character_identity', character: 'Frau Amrein' });
    });
  });

  describe('declines — four reasons to say nothing rather than guess', () => {
    const base = {
      figures: figs(5), matches: matched(['Aaron', 'Ben', 'Carl', 'Dan', null]),
      cast: roster(['Aaron', 'Ben', 'Carl', 'Dan']), detectedFigureCount: 5,
    };

    it('roster not declared', () => {
      for (const cast of [{ names: [], count: 0, declared: false, crowdExpected: false }, null, undefined]) {
        expect(run({ ...base, cast })).toMatchObject({ outcome: 'declined', reason: 'roster_not_declared' });
      }
    });

    it('no detector count — permanent for the call sites that genuinely have none', () => {
      for (const n of [null, undefined, NaN, 'four']) {
        expect(run({ ...base, detectedFigureCount: n })).toMatchObject({ outcome: 'declined', reason: 'no_detector_count' });
      }
    });

    it('matches[] is not the per-figure list its contract promises', () => {
      expect(run({ ...base, matches: undefined })).toMatchObject({ reason: 'matches_contract_broken' });
      expect(run({ ...base, matches: matched(['Aaron']) })).toMatchObject({ reason: 'matches_contract_broken' });
      expect(run({ ...base, figures: null })).toMatchObject({ reason: 'matches_contract_broken' });
    });

    it('THE WITNESSES DISAGREE — the folded two-witness rule', () => {
      expect(run({ ...base, detectedFigureCount: 4 })).toMatchObject({ outcome: 'declined', reason: 'witnesses_disagree', findings: [] });
      expect(run({ ...base, detectedFigureCount: 6 })).toMatchObject({ outcome: 'declined', reason: 'witnesses_disagree', findings: [] });
    });
  });

  it('every derived finding is MARKED, so it can be told apart from the evaluator D-02/D-04', () => {
    const cases = [
      { figures: figs(3), matches: matched(['Aaron', 'Ben', 'Carl']), cast: roster(['Aaron', 'Ben', 'Carl', 'Dan']), detectedFigureCount: 3 },
      { figures: figs(5), matches: matched(['Aaron', 'Ben', 'Carl', 'Dan', null]), cast: roster(['Aaron', 'Ben', 'Carl', 'Dan']), detectedFigureCount: 5 },
      { figures: figs(4), matches: matched(['Aaron', 'Ben', 'Carl', null]), cast: roster(['Aaron', 'Ben', 'Carl', 'Dan']), detectedFigureCount: 4 },
    ];
    for (const c of cases) for (const f of run(c).findings) expect(f.derivedBy).toBe(PRESENCE_DERIVED_MARKER);
  });

  it('a derived finding is a real, routable, scored finding', () => {
    const [f] = run({ figures: figs(5), matches: matched(['Aaron', 'Ben', 'Carl', 'Dan', null]), cast: roster(['Aaron', 'Ben', 'Carl', 'Dan']), detectedFigureCount: 5 }).findings;
    expect(bucketForType(f.type)).toBe('character_presence');
    const [d] = composeDeductions({ evalResult: { fixableIssues: [f] } }).quality;
    expect(deductionPoints(d)).toBe(25);
    expect(hasCriticalSeverityFinding({ fixableIssues: [f] })).toBe(true);
    // `subType` is deliberately absent — every reader does `subType || type`.
    expect(f.subType).toBeUndefined();
  });

  it('never mutates its inputs', () => {
    const figures = figs(5);
    const matches = matched(['Aaron', 'Ben', 'Carl', 'Dan', null]);
    const cast = roster(['Aaron', 'Ben', 'Carl', 'Dan']);
    const snapshot = JSON.stringify({ figures, matches, cast });
    run({ figures, matches, cast, detectedFigureCount: 5 });
    expect(JSON.stringify({ figures, matches, cast })).toBe(snapshot);
  });

  // THE INVARIANTS of the three-case model, swept over the shape space:
  //   - a figure is never removed while a cast name it could be is still missing;
  //   - a name is never reported missing while an unmatched figure could be it;
  //   - one finding per unmatched figure / missing name, no more.
  it('never removes a figure that could be a missing cast member, never adds a name a figure could be', () => {
    const names = ['Aaron', 'Ben', 'Carl', 'Dan'];
    const outcomes = new Set<string>();
    for (let castSize = 0; castSize <= 4; castSize++) {
      for (let figCount = 0; figCount <= 6; figCount++) {
        for (let namedRefs = 0; namedRefs <= figCount; namedRefs++) {
          for (const det of [figCount, figCount + 1, null]) {
            const refs = Array.from({ length: figCount }, (_, i) => (i < namedRefs ? names[i % 4] : null));
            const r = run({
              figures: figs(figCount), matches: matched(refs),
              cast: roster(names.slice(0, castSize)), detectedFigureCount: det,
            });
            outcomes.add(r.outcome);
            const t = types(r);
            expect(t.includes('extra_character') && t.includes('missing_character')).toBe(false);
            if (r.outcome === 'declined') { expect(r.findings).toEqual([]); continue; }
            const unmatched = refs.filter(x => x === null).length;
            const claimed = new Set(refs.filter(Boolean));
            const missing = names.slice(0, castSize).filter(n => !claimed.has(n)).length;
            expect(t.filter((x: string) => x !== 'missing_character').length).toBe(unmatched);
            expect(t.filter((x: string) => x !== 'extra_character').length).toBe(missing);
          }
        }
      }
    }
    expect(outcomes).toEqual(new Set(['missing_character', 'extra_character', 'character_identity', 'reconciled', 'declined']));
  });
});

describe('parseFixableIssues — the evaluator side, unchanged', () => {
  it('drops entries without a description and defaults the rest', () => {
    const out = parseFixableIssues({ fixable_issues: [{ type: 'x' }, { description: 'd' }] });
    // `fixAuthored: false` marks the stand-in `fix` this mapper built from the
    // description — the landmark guard must not read it as an edit instruction
    // (docs/SETTLED.md: never classify a finding from its description prose).
    // A finding that carries the judge's own `fix` gets no such field.
    expect(out).toEqual([{ description: 'd', severity: 'MODERATE', type: 'default', character: null, fix: 'Fix: d', fixAuthored: false }]);
    expect(parseFixableIssues({ fixable_issues: [{ description: 'd', fix: 'Repaint the sky.' }] }))
      .toEqual([{ description: 'd', severity: 'MODERATE', type: 'default', character: null, fix: 'Repaint the sky.' }]);
    expect(parseFixableIssues(null)).toEqual([]);
  });
});

describe('findBorrowedLabel — two-directional diagnostic', () => {
  const figs = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `F${i}` }));

  it('still refuses on a DEFICIT (fewer figures than the brief) — unchanged semantics', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const r = findBorrowedLabel({ figures: figs(3), sceneCharacters: boys, characterName: 'Dan', pageNumber: 7 });
    expect(r).not.toBeNull();
    expect(r.briefNames).toEqual(['Aaron', 'Ben', 'Carl', 'Dan']);
    expect(r.figureCount).toBe(3);
    expect(warn.mock.calls.some(c => /may be a borrowed label; refusing/.test(String(c[0])))).toBe(true);
    warn.mockRestore();
  });

  it('logs a surplus WARN on EXCESS (more figures than the brief) and does NOT refuse', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const r = findBorrowedLabel({ figures: figs(5), sceneCharacters: boys, characterName: 'Dan', pageNumber: 0 });
    expect(r).toBeNull();
    const line = warn.mock.calls.map(c => String(c[0])).find(l => /surplus/.test(l));
    expect(line).toMatch(/5 figure\(s\) drawn for a brief of 4 character\(s\) — 1 surplus figure\(s\)/);
    warn.mockRestore();
  });

  it('is silent when counts agree', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    expect(findBorrowedLabel({ figures: figs(4), sceneCharacters: boys, characterName: 'Dan' })).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('extra_character — prompt vocabulary', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('image-evaluation carries the D-04b rule at CRITICAL, the EXPECTED CAST input and the matches rule', () => {
    const t = String(PROMPT_TEMPLATES.imageEvaluation || '');
    expect(t).toMatch(/D-04b `extra_character` → CRITICAL/);
    expect(t).toContain('{EXPECTED_CAST}');
    expect(t).toMatch(/`reference` is an EXPECTED CAST name .* or the literal `unmatched`/);
    // N-09 reads the SETTING POPULATION line the Art Director's own `population`
    // field produces — it never re-decides from the prompt (2026-09-19).
    expect(t).toMatch(/N-09 Background people\.\*\* The `SETTING POPULATION` line in EXPECTED CAST decides this/);
    expect(t).toContain('On `ambient`, distant background people belong to the setting and are never extras');
    expect(t).toMatch(/D-04b `extra_character` → CRITICAL\.\*\* A person or animal figure that matches no EXPECTED CAST entry and that N-09 does not excuse/);
  });

  it('D-04b states the three presence cases (owner, 2026-09-24)', () => {
    // Removal only for a CONFIRMED surplus (every cast entry matched); an
    // unmatched figure while an entry is unmatched is that entry drawn wrong.
    const t = String(PROMPT_TEMPLATES.imageEvaluation || '');
    const rule = t.split('\n').find(l => l.includes('D-04b `extra_character`')) || '';
    expect(rule).toMatch(/when EVERY EXPECTED CAST entry is matched[^.]*surplus/);
    expect(rule).toContain('"Remove this figure: it is not one of the characters this page holds."');
    expect(rule).toMatch(/When an EXPECTED CAST entry is matched by NO figure, the unmatched figure is that entry drawn wrong — code `character_identity`/);
    expect(rule).toMatch(/— never a removal\./);
  });

  it('buildEvaluationPrompt renders the roster into the template', () => {
    // Asserts the roster REACHES input 8, not the wording of input 8 — the
    // sentence is prompt copy and gets edited (D6 changed it 2026-09-11).
    const p = buildEvaluationPrompt({ originalPrompt: 'x', expectedCast: 'EXPECTED CAST (4): Aaron, Ben, Carl, Dan' });
    expect(p).toMatch(/^8\. EXPECTED CAST .*: EXPECTED CAST \(4\): Aaron, Ben, Carl, Dan$/m);
    expect(buildEvaluationPrompt({ originalPrompt: 'x' })).not.toContain('{EXPECTED_CAST}');
  });

  it('input 8 distinguishes a blank roster from a declared roster of zero (D6)', () => {
    const t = String(PROMPT_TEMPLATES.imageEvaluation || '');
    expect(t).toMatch(/blank if not supplied, and only then do not judge the figure count/);
    expect(t).toMatch(/"\(0\): none" is a frame written for nobody/);
    // D-04b must agree with it — the two used to be able to drift apart.
    expect(t).toMatch(/Skip this code only when EXPECTED CAST is blank/);
  });

  it('feedback-consolidator keeps the type through merging', () => {
    const t = String(PROMPT_TEMPLATES.feedbackConsolidator || '');
    expect(t).toContain('`extra_character`');
    expect(t).toMatch(/`extra_character`[^\n]*keeps its own type when merging/);
  });

  // THE DELETIONS (owner, 2026-09-13). Four layers argued about the same
  // question; three of them are gone and code answers it. These pin the
  // removals so a later prompt edit cannot quietly re-open the argument.
  it('image-evaluation no longer asks the model to reconcile the counts (D-04c is gone)', () => {
    const t = String(PROMPT_TEMPLATES.imageEvaluation || '');
    expect(t).not.toContain('D-04c');
    // Wording-independent: no rule tells the model what to do when the counts
    // are equal and it holds both an absence and a surplus.
    expect(t).not.toMatch(/counts are EQUAL/i);
  });

  it('image-evaluation D-04 observes an absence and emits no code for it', () => {
    const t = String(PROMPT_TEMPLATES.imageEvaluation || '');
    const line = t.split('\n').find(l => l.startsWith('**D-04 ')) || '';
    expect(line).toBeTruthy();
    // It no longer declares a type or a severity — the two things that make a
    // rule an emission rather than an observation.
    expect(line).not.toContain('`missing_character`');
    expect(line).not.toMatch(/CRITICAL|CATASTROPHIC|MAJOR/);
  });

  it('feedback-consolidator no longer carries the merge exception the derivation replaced', () => {
    const t = String(PROMPT_TEMPLATES.feedbackConsolidator || '');
    // The consolidator must not be told to fold a missing/extra pair into one
    // character_identity — the pair is now unrepresentable upstream.
    expect(t).not.toMatch(/figure count EQUALS the expected cast/i);
    expect(t).not.toMatch(/merge the two into ONE `character_identity`/i);
  });

  it('image-prompt-compliance never pairs an `unmatched` figure with a named character', () => {
    const t = String(PROMPT_TEMPLATES.imagePromptCompliance || PROMPT_TEMPLATES.threeStageCompliance || '');
    expect(t).toMatch(/`reference` is `unmatched`[^\n]*never pair it with a prompt-named character/);
  });
});

describe('derivePresenceFinding — COUNT PEOPLE AGAINST PEOPLE', () => {
  // Owner, 2026-08-18, settled in figureDetection.js and re-broken one layer up
  // on 2026-09-13. GroundingDINO's prompt is "person": its count is a count of
  // PEOPLE. Comparing it to a roster holding the story's dog, dragon or fairies
  // reports a shortfall on every page with one. Measured on
  // job_1789304198359_y3n0euk3z (four fairies in `visualBible.animals`): p7
  // billed a CRITICAL `missing_character` against "Yellow Fairy", and p5/p6/p10/
  // p15 declined `witnesses_disagree` — the evaluator counting the fairies it
  // can see against a detector that mostly cannot.
  //
  // There is deliberately no separate non-human presence check: a missing fairy
  // stops being arithmetic evidence, it does not become a new finding type.

  const roster = (names: string[], nonHumanNames: string[] = [], extra: object = {}) =>
    ({ names, count: names.length, declared: true, crowdExpected: false, block: '', nonHumanNames, ...extra });
  const figs = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i + 1 }));
  const matched = (refs: (string | null)[]) =>
    refs.map((r, i) => ({ figure: i + 1, reference: r ?? 'unmatched', confidence: r ? 0.9 : 0 }));

  it('an animal on the roster is not a person the detector failed to find (p7 v7)', () => {
    // Stored inputs: detector 2 people, evaluator 3 figures of which it named
    // one "Green Fairy", roster [Liz, Ayan, Green Fairy, Yellow Fairy].
    const r = derivePresenceFinding({
      figures: figs(3), matches: matched(['Liz', 'Ayan', 'Green Fairy']),
      cast: roster(['Liz', 'Ayan', 'Green Fairy', 'Yellow Fairy'], ['Green Fairy', 'Yellow Fairy']),
      detectedFigureCount: 2,
    });
    expect(r).toEqual({ outcome: 'reconciled', reason: null, findings: [] });
  });

  it('never bills a CRITICAL absence against a non-human roster entry', () => {
    // The same page as above run the old way would name the fairy. Whatever the
    // outcome, the fairy is never the accused.
    const cast = roster(['Liz', 'Ayan', 'Green Fairy', 'Yellow Fairy'], ['Green Fairy', 'Yellow Fairy']);
    for (const det of [0, 1, 2, 3, 4]) {
      const r = derivePresenceFinding({
        figures: figs(3), matches: matched(['Liz', 'Ayan', 'Green Fairy']), cast, detectedFigureCount: det,
      });
      for (const f of r.findings) {
        expect(String(f.character || '')).not.toMatch(/fairy/i);
        expect(String(f.item || '')).not.toMatch(/fairy/i);
      }
    }
  });

  it('the evaluator side is a people count too — its named non-humans come off (p5 v5)', () => {
    // Two children and four fairies: detector 2, evaluator 6. Raw lengths
    // disagree; people counts do not.
    const r = derivePresenceFinding({
      figures: figs(6),
      matches: matched(['Liz', 'Ayan', 'Pink Fairy', 'Green Fairy', 'Yellow Fairy', 'Blue Fairy']),
      cast: roster(['Liz', 'Ayan', 'Pink Fairy', 'Green Fairy', 'Yellow Fairy', 'Blue Fairy'],
        ['Pink Fairy', 'Green Fairy', 'Yellow Fairy', 'Blue Fairy']),
      detectedFigureCount: 2,
    });
    expect(r.outcome).toBe('reconciled');
    expect(r.findings).toEqual([]);
  });

  it('the witnesses-disagree gate compares two PEOPLE counts, both ways', () => {
    const cast = roster(['Liz', 'Blue Fairy'], ['Blue Fairy']);
    // 2 evaluator figures, one of them the fairy -> 1 person; detector 1 person.
    expect(derivePresenceFinding({
      figures: figs(2), matches: matched(['Liz', 'Blue Fairy']), cast, detectedFigureCount: 1,
    }).outcome).toBe('reconciled');
    // The detector ALSO boxed the fairy and it was counted as a person: the two
    // readings really do differ, and the derivation still refuses to rule.
    expect(derivePresenceFinding({
      figures: figs(2), matches: matched(['Liz', 'Blue Fairy']), cast, detectedFigureCount: 2,
    })).toMatchObject({ outcome: 'declined', reason: 'witnesses_disagree', findings: [] });
    // A figure the evaluator left UNMATCHED is of unknown kind and stays in the
    // people count — an unexplained figure is never explained away as an animal.
    expect(derivePresenceFinding({
      figures: figs(2), matches: matched(['Liz', null]), cast, detectedFigureCount: 1,
    })).toMatchObject({ outcome: 'declined', reason: 'witnesses_disagree' });
  });

  it('a surplus is still a surplus — the fairy just is not part of the sum (p15 v23)', () => {
    const r = derivePresenceFinding({
      figures: figs(3), matches: matched(['Liz', 'Yellow Fairy', null]),
      cast: roster(['Liz', 'Yellow Fairy'], ['Yellow Fairy']), detectedFigureCount: 2,
    });
    expect(r.outcome).toBe('extra_character');
    expect(r.findings.map((f: any) => f.character)).toEqual(['figure 3']);
    // The cast size it states is the PEOPLE cast it actually compared.
    expect(r.findings[0].description).toMatch(/EXPECTED CAST 1\)/);
  });

  it('a short-form roster token for a VB animal is still subtracted (Kapitanin Rossa / Rossa)', () => {
    // vbKind used to exact-match name-or-id, so the short form the brief uses
    // lost its "(animal)" tag and the arithmetic counted the ship's cat as a
    // person — a false extra_character CRITICAL.
    const vb = { secondaryCharacters: [], animals: [{ id: 'ANI007', name: 'Kapitanin Rossa', species: 'cat' }] };
    const cast = buildExpectedCastBlock({ sceneCharacters: [{ name: 'Liz' }, { name: 'Rossa' }], visualBible: vb });
    expect(cast.names).toEqual(['Liz', 'Rossa']);
    expect(cast.nonHumanNames).toEqual(['Rossa']);
    // Detector sees ONE person; the evaluator names both figures. Arithmetic
    // unchanged: 2 - 1 non-human = 1 person vs a people-cast of 1.
    const r = derivePresenceFinding({
      figures: figs(2), matches: matched(['Liz', 'Rossa']), cast, detectedFigureCount: 1,
    });
    expect(r).toEqual({ outcome: 'reconciled', reason: null, findings: [] });
  });

  it('a human-only page is unchanged, with or without the field', () => {
    const args = { figures: figs(3), matches: matched(['Aaron', 'Ben', 'Carl']), detectedFigureCount: 3 };
    const withField = derivePresenceFinding({ ...args, cast: roster(['Aaron', 'Ben', 'Carl', 'Dan'], []) });
    // A roster from before the field existed must behave identically.
    const legacy = derivePresenceFinding({
      ...args, cast: { names: ['Aaron', 'Ben', 'Carl', 'Dan'], count: 4, declared: true, crowdExpected: false, block: '' },
    });
    expect(withField.outcome).toBe('missing_character');
    expect(withField.findings.map((f: any) => f.character)).toEqual(['Dan']);
    expect(legacy).toEqual(withField);
  });

  it('never yields both a removal and an addition — rosters mixing people and animals', () => {
    // The mutual-exclusion invariant, re-checked against rosters that mix
    // people and animals in every proportion.
    const names = ['Liz', 'Ayan', 'Pink Fairy', 'Blue Fairy'];
    for (let nFig = 0; nFig <= 5; nFig++) {
      for (let det = 0; det <= 5; det++) {
        for (const refs of [
          [], ['Liz'], ['Liz', 'Pink Fairy'], ['Liz', 'Ayan', 'Pink Fairy', 'Blue Fairy'], [null, 'Blue Fairy'],
        ]) {
          const matches = matched([...refs, ...Array(Math.max(0, nFig - refs.length)).fill(null)].slice(0, nFig));
          const r = derivePresenceFinding({
            figures: figs(nFig), matches, detectedFigureCount: det,
            cast: roster(names, ['Pink Fairy', 'Blue Fairy']),
          });
          expect(['declined', 'reconciled', 'missing_character', 'extra_character', 'character_identity'])
            .toContain(r.outcome);
          const t = r.findings.map((f: any) => f.type);
          expect(t.includes('extra_character') && t.includes('missing_character')).toBe(false);
        }
      }
    }
  });
});
