import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createRequire } from 'node:module';

// CJS registry, not vitest's ESM graph — the prompt store and scoring both
// reach each other with plain require() (see duplicate-object-type.test.ts).
const require_ = createRequire(import.meta.url);
const { buildExpectedCastBlock, parseFixableIssues } = require_('../../server/lib/evalPipeline');
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
    expect(buildExpectedCastBlock({ sceneCharacters: null })).toEqual({ block: '', names: [], count: 0, declared: false });
    expect(buildExpectedCastBlock({}).block).toBe('');
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

describe('extra_character — parse + score path', () => {
  // A synthetic evaluator response: five figures for a four-name roster, one
  // `unmatched`, and the D-04b finding the prompt asks for.
  const parsedJson = {
    figures: [1, 2, 3, 4, 5].map(id => ({ id, zone: 'center-midground' })),
    matches: [
      { figure: 1, reference: 'Aaron', confidence: 0.9 },
      { figure: 2, reference: 'Ben', confidence: 0.9 },
      { figure: 3, reference: 'Carl', confidence: 0.85 },
      { figure: 4, reference: 'Dan', confidence: 0.85 },
      { figure: 5, reference: 'unmatched', confidence: 0 },
    ],
    verdict: 'FAIL',
    fixable_issues: [
      { type: 'extra_character', severity: 'CRITICAL', character: 'figure 5',
        description: 'A fifth child stands at the right; the EXPECTED CAST lists four.',
        fix: "Redraw this figure as the EXPECTED CAST entry it should be, matching that entry's reference and CLOTHING CONTRACT." },
    ],
  };

  it('parses to one CRITICAL extra_character finding billed at 25', () => {
    const fixableIssues = parseFixableIssues(parsedJson);
    expect(fixableIssues).toHaveLength(1);
    expect(fixableIssues[0]).toMatchObject({ type: 'extra_character', severity: 'CRITICAL', character: 'figure 5' });
    const [d] = composeDeductions({ evalResult: { fixableIssues } }).quality;
    expect(d.severity).toBe('critical');
    expect(d.type).toBe('extra_character');
    expect(deductionPoints(d)).toBe(25);
  });

  it('puts the page in the repair queue through the critical arm', () => {
    expect(hasCriticalSeverityFinding({ fixableIssues: parseFixableIssues(parsedJson) })).toBe(true);
  });

  it('parseFixableIssues drops entries without a description and defaults the rest', () => {
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
