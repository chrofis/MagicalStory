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

describe('buildExpectedCastBlock — page roster', () => {
  it('is blank when the caller knows NO cast (null), so the evaluator does not judge the count', () => {
    expect(buildExpectedCastBlock({ sceneCharacters: null })).toEqual({ block: '', names: [], count: 0, declared: false, crowdExpected: false });
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
    expect(r.block).toBe('EXPECTED CAST (0): none — this frame was written with no people and no animals in it');
  });

  it('a declared-empty page still picks up the VB creature its metadata names', () => {
    // The early return used to sit ABOVE the secondary/animal expansion, so a
    // creature-only page got nothing at all instead of its creature.
    const sceneHint = 'A dog alone in the meadow.\n\n---METADATA---\n'
      + JSON.stringify({ characters: [{ name: 'ANI001' }] });
    const r = buildExpectedCastBlock({ sceneCharacters: [], sceneHint, visualBible, evaluationType: 'scene' });
    expect(r.declared).toBe(true);
    expect(r.names).toEqual(['ANI001']);
    expect(r.block).toBe('EXPECTED CAST (1): ANI001 (animal, dog)');
  });

  it('lists sceneCharacters plus the VB secondary AND animal the page metadata names, with the count', () => {
    const sceneHint = 'Four boys fly a kite while a dog barks.\n\n' +
      '---METADATA---\n' + JSON.stringify({ characters: [{ name: 'Aaron' }, { name: 'Ben' }, { name: 'Carl' }, { name: 'Dan' }, { name: 'CHR001' }, { name: 'ANI001' }] });
    const r = buildExpectedCastBlock({ sceneCharacters: boys, sceneHint, visualBible, evaluationType: 'scene' });
    expect(r.names).toEqual(['Aaron', 'Ben', 'Carl', 'Dan', 'CHR001', 'ANI001']);
    expect(r.count).toBe(6);
    expect(r.block).toBe('EXPECTED CAST (6): Aaron, Ben, Carl, Dan, CHR001 (secondary character), ANI001 (animal, dog)');
  });

  it('appends the detector figure count when one is supplied, and not otherwise', () => {
    const withDet = buildExpectedCastBlock({ sceneCharacters: boys, detectedFigureCount: 5 });
    expect(withDet.block).toBe('EXPECTED CAST (4): Aaron, Ben, Carl, Dan\nDetector figure count (GroundingDINO): 5');
    expect(buildExpectedCastBlock({ sceneCharacters: boys, detectedFigureCount: null }).block)
      .toBe('EXPECTED CAST (4): Aaron, Ben, Carl, Dan');
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
    expect(r.block).toBe('EXPECTED CAST (5): Aaron, Ben, Carl, Dan, Nia (animal, dog)');
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

  it('shares the character_presence bucket with missing_character (regen route, not a face patch)', () => {
    expect(bucketForType('extra_character')).toBe('character_presence');
    expect(bucketForType('missing_character')).toBe('character_presence');
  });

  // Owner decision 2026-09-13: the type stays scored, but it may never cause a
  // figure to be deleted. Inpaint was the removal route (a Grok whole-frame
  // edit executing the old "Remove this figure" fix erased a commissioned child
  // from a cover), so the route is closed at the type.
  it('is barred from inpaint — the removal route is closed', () => {
    expect(NOT_INPAINTABLE_TYPES.has('extra_character')).toBe(true);
  });
});

describe('derivePresenceFinding — the one presence signal', () => {
  // ONE PAGE, ONE OUTCOME (owner, 2026-09-13). The evaluator observes
  // (`figures[]` + `matches[]`, one match per figure, same ids and order); code
  // does the arithmetic. Four layers used to argue about "is this figure really
  // extra?" and their disagreement was destructive — an `extra_character` sent
  // to inpaint erased a commissioned child from a cover while the same page
  // also carried a `missing_character` for the child it had just erased.

  const roster = (names: string[], extra: object = {}) =>
    ({ names, count: names.length, declared: true, crowdExpected: false, block: '', ...extra });
  const figs = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i + 1 }));
  const matched = (refs: (string | null)[]) =>
    refs.map((r, i) => ({ figure: i + 1, reference: r ?? 'unmatched', confidence: r ? 0.9 : 0 }));
  const run = (o: object) => derivePresenceFinding(o);

  it('figures < cast -> missing_character, naming who, with `item` for the inpaint reference attach', () => {
    const r = run({
      figures: figs(3), matches: matched(['Aaron', 'Ben', 'Carl']),
      cast: roster(['Aaron', 'Ben', 'Carl', 'Dan']), detectedFigureCount: 3,
    });
    expect(r.outcome).toBe('missing_character');
    expect(r.finding.type).toBe('missing_character');
    expect(r.finding.severity).toBe('CRITICAL');
    expect(r.finding.character).toBe('Dan');
    // images.js reads `missing.item` to attach the VB reference cell for inpaint.
    expect(r.finding.item).toBe('Dan');
    // Never a removal instruction — that is the whole reason this rewrite exists.
    expect(r.finding.fix).not.toMatch(/remove|delete|erase|paint out|take out/i);
  });

  it('figures > cast -> extra_character against the unmatched figure', () => {
    const r = run({
      figures: figs(5), matches: matched(['Aaron', 'Ben', 'Carl', 'Dan', null]),
      cast: roster(['Aaron', 'Ben', 'Carl', 'Dan']), detectedFigureCount: 5,
    });
    expect(r.outcome).toBe('extra_character');
    expect(r.finding.type).toBe('extra_character');
    expect(r.finding.character).toBe('figure 5');
    expect(r.finding.fix).not.toMatch(/remove|delete|erase|paint out|take out/i);
  });

  it('the crowd flag suppresses the surplus branch, and only that branch', () => {
    const crowd = roster(['Aaron', 'Ben', 'Carl', 'Dan'], { crowdExpected: true });
    expect(run({ figures: figs(9), matches: matched(['Aaron', 'Ben', 'Carl', 'Dan', null, null, null, null, null]), cast: crowd, detectedFigureCount: 9 }))
      .toMatchObject({ outcome: 'declined', reason: 'crowd_expected', finding: null });
    // A shortfall on a crowd page is still a shortfall.
    expect(run({ figures: figs(3), matches: matched(['Aaron', 'Ben', 'Carl']), cast: crowd, detectedFigureCount: 3 }).outcome)
      .toBe('missing_character');
  });

  it('figures == cast with an unmatched figure -> character_identity naming the cast member it should be', () => {
    // The old D-04c, now arithmetic: an absence plus a surplus on a page whose
    // counts reconcile is ONE recognition failure, not two findings.
    const r = run({
      figures: figs(4), matches: matched(['Aaron', 'Ben', 'Carl', null]),
      cast: roster(['Aaron', 'Ben', 'Carl', 'Dan']), detectedFigureCount: 4,
    });
    expect(r.outcome).toBe('character_identity');
    expect(r.finding.type).toBe('character_identity');
    expect(r.finding.character).toBe('Dan');
    expect(r.finding.description).toMatch(/figure 4/);
    expect(r.finding.description).toMatch(/Dan/);
  });

  it('figures == cast, all matched -> nothing', () => {
    expect(run({
      figures: figs(4), matches: matched(['Aaron', 'Ben', 'Carl', 'Dan']),
      cast: roster(['Aaron', 'Ben', 'Carl', 'Dan']), detectedFigureCount: 4,
    })).toEqual({ outcome: 'reconciled', reason: null, finding: null });
  });

  it('a declared-empty roster still counts: any figure at all is a surplus', () => {
    expect(run({ figures: figs(3), matches: matched([null, null, null]), cast: roster([]), detectedFigureCount: 3 }).outcome)
      .toBe('extra_character');
    expect(run({ figures: [], matches: [], cast: roster([]), detectedFigureCount: 0 }).outcome).toBe('reconciled');
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
      // The detector saw 4 real figures, the evaluator enumerated 5. Two
      // readings of one picture; when they differ the count is not trustworthy
      // for this page, so no claim is made at all. This replaces the absence
      // filter that used to delete claims one at a time after the fact.
      expect(run({ ...base, detectedFigureCount: 4 })).toMatchObject({ outcome: 'declined', reason: 'witnesses_disagree', finding: null });
      expect(run({ ...base, detectedFigureCount: 6 })).toMatchObject({ outcome: 'declined', reason: 'witnesses_disagree', finding: null });
    });
  });

  it('every derived finding is MARKED, so it can be told apart from the evaluator D-02/D-04', () => {
    const cases = [
      { figures: figs(3), matches: matched(['Aaron', 'Ben', 'Carl']), cast: roster(['Aaron', 'Ben', 'Carl', 'Dan']), detectedFigureCount: 3 },
      { figures: figs(5), matches: matched(['Aaron', 'Ben', 'Carl', 'Dan', null]), cast: roster(['Aaron', 'Ben', 'Carl', 'Dan']), detectedFigureCount: 5 },
      { figures: figs(4), matches: matched(['Aaron', 'Ben', 'Carl', null]), cast: roster(['Aaron', 'Ben', 'Carl', 'Dan']), detectedFigureCount: 4 },
    ];
    for (const c of cases) expect(run(c).finding.derivedBy).toBe(PRESENCE_DERIVED_MARKER);
  });

  it('a derived finding is a real, routable, scored finding', () => {
    const f = run({ figures: figs(5), matches: matched(['Aaron', 'Ben', 'Carl', 'Dan', null]), cast: roster(['Aaron', 'Ben', 'Carl', 'Dan']), detectedFigureCount: 5 }).finding;
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

  // THE INVARIANT. This is the whole design: the two presence types are
  // mutually exclusive BY CONSTRUCTION, so no input can ever produce both.
  // Exhaustive over the shape space rather than over a few hand-picked cases.
  it('MUTUAL EXCLUSION: no input yields both presence types, ever', () => {
    const names = ['Aaron', 'Ben', 'Carl', 'Dan'];
    const outcomes = new Set<string>();
    for (let castSize = 0; castSize <= 4; castSize++) {
      for (let figCount = 0; figCount <= 6; figCount++) {
        for (let namedRefs = 0; namedRefs <= figCount; namedRefs++) {
          for (const crowd of [false, true]) {
            for (const det of [figCount, figCount + 1, null]) {
              const refs = Array.from({ length: figCount }, (_, i) => (i < namedRefs ? names[i % 4] : null));
              const r = run({
                figures: figs(figCount), matches: matched(refs),
                cast: roster(names.slice(0, castSize), { crowdExpected: crowd }),
                detectedFigureCount: det,
              });
              outcomes.add(r.outcome);
              const emitted = r.finding ? [r.finding.type] : [];
              expect(emitted.filter(t => t === 'missing_character' || t === 'extra_character').length).toBeLessThanOrEqual(1);
              expect(emitted.includes('missing_character') && emitted.includes('extra_character')).toBe(false);
              if (r.outcome === 'declined') expect(r.finding).toBeNull();
              else expect(r.outcome).toBe(r.finding ? r.finding.type : 'reconciled');
            }
          }
        }
      }
    }
    // The sweep actually reached every branch, so the invariant is not vacuous.
    expect(outcomes).toEqual(new Set(['missing_character', 'extra_character', 'character_identity', 'reconciled', 'declined']));
  });
});

describe('parseFixableIssues — the evaluator side, unchanged', () => {
  it('drops entries without a description and defaults the rest', () => {
    const out = parseFixableIssues({ fixable_issues: [{ type: 'x' }, { description: 'd' }] });
    expect(out).toEqual([{ description: 'd', severity: 'MODERATE', type: 'default', character: null, fix: 'Fix: d' }]);
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
    // N-09 is scoped to a populated setting the prompt itself calls for.
    expect(t).toMatch(/N-09 Crowd extras\.\*\* Extra background figures ONLY when the USER_PROMPT itself calls for a populated setting/);
  });

  it('D-04b never instructs a removal (owner, 2026-09-13)', () => {
    // Pins the PROPERTY, not the wording: whatever D-04b's fix says, it may not
    // ask for the figure to be taken out of the frame.
    const t = String(PROMPT_TEMPLATES.imageEvaluation || '');
    const rule = t.split('\n').find(l => l.includes('D-04b `extra_character`')) || '';
    expect(rule).not.toBe('');
    expect(rule).not.toMatch(/\b(remove|delete|erase|paint out|take out)\b/i);
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

  it('image-prompt-compliance never pairs an `unmatched` figure with a named character', () => {
    const t = String(PROMPT_TEMPLATES.imagePromptCompliance || PROMPT_TEMPLATES.threeStageCompliance || '');
    expect(t).toMatch(/`reference` is `unmatched`[^\n]*never pair it with a prompt-named character/);
  });
});
