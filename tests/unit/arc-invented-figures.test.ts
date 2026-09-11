/**
 * INVENTED FIGURES — enumeration, re-count, and the forced arc round.
 *
 * Evidence: job_1788903616404_iqvhj4l8m. Commissioned cast = four children
 * with photos; allowance 2. The arc invented four named figures (a dragon, a
 * mountain creature, a mother with a wholly fabricated face on pages 2 and 18,
 * and a dog) and its own critique reported, verbatim:
 *   "Invented figures past allowance: none — Fenno and Nolo, exactly two"
 * Nobody caught it: the check was a self-certifiable verdict, the definition of
 * what counts was a role gloss, the independent readers were never told the
 * allowance, and no code re-counted anything.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';

// @ts-ignore — CommonJS lib
import pb from '../../server/lib/promptBuilders.js';
const {
  parseInventedFigures, parsePremiseFigures, parseArcRetell, critiqueMaxSeverity,
  arcInventedAllowance, buildArcBudgetSection, replanRank,
} = pb as any;
// @ts-ignore — CommonJS lib
import counters from '../../server/lib/planCounters.js';
const { runPlanCounters } = counters as any;
// @ts-ignore — CommonJS lib
import modelsCfg from '../../server/config/models.js';
const { MODEL_DEFAULTS } = modelsCfg as any;

const HEAD_BLOCK = [
  'Invented figures:',
  '- Fenno — a young dragon',
  '- Nolo — a mountain creature',
  '- Mama — the boy’s mother',
  '- Nia — the family dog',
  'Allowed: 2. Written: 4.',
].join('\n');

const RETELL = [
  HEAD_BLOCK,
  'Fixing: fault 2, by giving the guard a motive.',
  'Keeping: the market scene and the climb.',
  'Challenges taken:',
  '1. reach the summit',
  'Used: Panelist A',
  'FINAL ARC:',
  '1. The children set out.',
  '2. They reach the ridge.',
  'CRITIQUE:',
  '1. [MINOR] the ridge is thin.',
].join('\n');

describe('parsePremiseFigures — a figure the commission\'s premise supplied is commissioned, not invented', () => {
  // job_1789147573901_m3uam0nxi: the premise reads "<child> and his dog <name>".
  // The dog is not in inputData.characters (there is no pet field), only the arc
  // reads the premise, and nothing carried her name out — so the plan counters
  // charged her against the invented allowance.
  const WITH_PREMISE = [
    'Premise figures:',
    "- Nia — the boy's dog, tracker",
    '- Fauchi — the wingless dragon',
    '',
    'Invented figures:',
    '- Stone Guard One — summit gatekeeper',
    '- Stone Guard Two — summit gatekeeper',
    'Allowed: 3. Written: 2.',
    '',
    'Fixing: nothing.',
    'FINAL ARC:',
    '1. Something happens.',
  ].join('\n');

  it('reads the premise block and stops at the invented heading', () => {
    const p = parsePremiseFigures(WITH_PREMISE);
    expect(p.present).toBe(true);
    expect(p.names).toEqual(['Nia', 'Fauchi']);
  });

  it('does not pull the premise figures into the invented list', () => {
    const inv = parseInventedFigures(WITH_PREMISE);
    expect(inv.names).toEqual(['Stone Guard One', 'Stone Guard Two']);
    expect(inv.allowed).toBe(3);
    expect(inv.written).toBe(2);
  });

  it('an arc with no premise block degrades safely', () => {
    expect(() => parsePremiseFigures('')).not.toThrow();
    expect(parsePremiseFigures('Invented figures:\n- X — a thing\nAllowed: 2. Written: 1.').present).toBe(false);
  });
});

describe('parseInventedFigures', () => {
  it('reads the emitted block: names plus the two counts', () => {
    const inv = parseInventedFigures(HEAD_BLOCK);
    expect(inv.present).toBe(true);
    expect(inv.names).toEqual(['Fenno', 'Nolo', 'Mama', 'Nia']);
    expect(inv.allowed).toBe(2);
    expect(inv.written).toBe(4);
  });

  it('an ABSENT block degrades safely — no throw, empty reading', () => {
    expect(() => parseInventedFigures('')).not.toThrow();
    const inv = parseInventedFigures('Fixing: nothing.\nFINAL ARC:\n1. A story.');
    expect(inv.present).toBe(false);
    expect(inv.names).toEqual([]);
    expect(inv.allowed).toBeNull();
  });

  it('an empty list ("- none") reads as zero figures', () => {
    const inv = parseInventedFigures('Invented figures:\n- none\nAllowed: 2. Written: 0.');
    expect(inv.names).toEqual([]);
    expect(inv.written).toBe(0);
  });
});

describe('parseArcRetell with the head block', () => {
  it('does not throw and does not leak the block into finalArc', () => {
    const r = parseArcRetell(RETELL);
    expect(r.invented.names).toEqual(['Fenno', 'Nolo', 'Mama', 'Nia']);
    expect(r.finalArc).not.toMatch(/Invented figures/);
    expect(r.finalArc).toMatch(/The children set out/);
    expect(r.fixing).toMatch(/fault 2/);
    expect(r.keeping).toMatch(/market scene/);
    expect(r.used).toBe('Panelist A');
  });

  it('a re-telling WITHOUT the block still parses (degrades to pre-2026-09-09 behaviour)', () => {
    const old = 'Fixing: x.\nKeeping: y.\nUsed: Panelist B\nFINAL ARC:\n1. A story.\nCRITIQUE:\n1. [MAJOR] a fault.';
    const r = parseArcRetell(old);
    expect(r.invented.present).toBe(false);
    expect(r.finalArc).toBe('1. A story.');
    expect(critiqueMaxSeverity(r.critique)).toBe('MAJOR');
  });
});

describe('the list must not inflate critiqueMaxSeverity', () => {
  it('an UNNUMBERED list adds no fault', () => {
    const critique = HEAD_BLOCK + '\n1. [MINOR] a blemish.';
    expect(critiqueMaxSeverity(critique)).toBe('MINOR');
  });

  it('a NUMBERED list would have minted phantom MAJORs — the contract forbids it', () => {
    const numbered = 'Invented figures:\n1. Fenno — a young dragon\n2. Nolo — a mountain creature\n3. [MINOR] a blemish.';
    expect(critiqueMaxSeverity(numbered)).toBe('MAJOR');
    for (const f of ['prompts/arc-create.txt', 'prompts/arc-retell.txt']) {
      const t = fs.readFileSync(f, 'utf8');
      expect(t).toMatch(/Invented figures:/);
      expect(t).toMatch(/"- <name> — <what it is in the story, three words>"/);
    }
  });
});

describe('the source-based definition', () => {
  it('the budget section defines counting by SOURCE, not by role', () => {
    const txt = buildArcBudgetSection({ characters: [{ age: '7' }, { age: '6' }], languageLevel: 'standard' }, 18);
    expect(txt).not.toMatch(/opposition and its help/);
    expect(txt).toMatch(/the story gives it a name and the commission did not/);
    expect(txt).toMatch(/parent, grandparent, teacher, shopkeeper or neighbour/);
    expect(txt).toMatch(/never speaks/);
    expect(txt).toMatch(/including any animal or companion it supplied/);
    expect(txt).toMatch(/places, buildings, landmarks, rivers, mountains, vehicles and objects/);
    expect(txt).toMatch(/taking its name away is not a way off it/);
  });

  it('a commission-named animal is NOT invented; a story-named one is', () => {
    const commissioned = ['Levin', 'Julian', 'Max', 'Kiaan', 'Nia'];
    const isInvented = (name: string) => !commissioned.some(c => c.toLowerCase() === name.toLowerCase());
    expect(isInvented('Nia')).toBe(false);
    expect(isInvented('Fenno')).toBe(true);
  });
});

describe('the count-vs-allowance comparison and the forced round', () => {
  const allowanceOf = (cast: number, extra: any) =>
    arcInventedAllowance({ characters: Array.from({ length: cast }, () => ({ age: '7' })), ...extra });

  it('the allowance NUMBER is unchanged: the floor of 2 still holds', () => {
    expect(allowanceOf(4, { languageLevel: 'standard' })).toBeGreaterThanOrEqual(2);
    expect(allowanceOf(20, { languageLevel: 'standard' })).toBe(2);
    expect(allowanceOf(20, { languageLevel: '1st-grade' })).toBe(2);
  });

  // Pure arithmetic over the DECLARED list — never over the arc prose.
  const overcount = (names: string[], allowance: number) => names.length > allowance;

  it('4 declared figures against an allowance of 2 is an overcount', () => {
    expect(overcount(['Fenno', 'Nolo', 'Mama', 'Nia'], 2)).toBe(true);
  });
  it('2 declared figures against an allowance of 2 is not', () => {
    expect(overcount(['Fenno', 'Nolo'], 2)).toBe(false);
  });

  /** The forcing decision, exactly as beatsPipeline applies it. */
  function decide(round: number, roundBudget: number, max: number, alreadyForced: boolean, over: boolean) {
    if (!MODEL_DEFAULTS.arcForceRoundOnInventedOvercount || !over) return { action: 'none', roundBudget };
    if (alreadyForced) return { action: 'ship-with-warning', roundBudget };
    if (round >= roundBudget && roundBudget >= max) return { action: 'declined-clamp', roundBudget };
    return { action: 'forced', roundBudget: round >= roundBudget ? Math.min(max, roundBudget + 1) : roundBudget };
  }
  const MAX = MODEL_DEFAULTS.arcRoundsMax;

  it('forces one more round at the default arcRounds=1', () => {
    expect(decide(1, 1, MAX, false, true)).toEqual({ action: 'forced', roundBudget: 2 });
  });
  it('forces AT MOST ONE round per story', () => {
    expect(decide(2, 2, MAX, true, true).action).toBe('ship-with-warning');
  });
  it('declines at the clamp of 3 rather than exceeding it', () => {
    expect(MAX).toBe(3);
    expect(decide(3, 3, MAX, false, true)).toEqual({ action: 'declined-clamp', roundBudget: 3 });
  });
  it('never forces when there is no overcount', () => {
    expect(decide(1, 1, MAX, false, false).action).toBe('none');
  });
  it('the forcing behaviour is a named, switchable config constant', () => {
    expect(MODEL_DEFAULTS).toHaveProperty('arcForceRoundOnInventedOvercount');
    expect(MODEL_DEFAULTS).toHaveProperty('arcRoundsMax');
  });
});

describe('Part 5 — the beats cross-check is reporting only', () => {
  const pages = [
    { pageNumber: 1, planLine: 'Wide — Levin, Mama — Mama waves at Levin — Levin is outside' },
    { pageNumber: 2, planLine: 'Wide — Levin, Fenno — Fenno lands beside Levin — the dragon is here' },
  ];
  // The plan check's roster is what tells the counters who is a person; without
  // it they refuse to run (the grammar that used to guess was deleted 2026-09-11).
  const roster = new Map<number, { people: string[]; things: string[] }>([
    [1, { people: ['Levin', 'Mama'], things: [] }],
    [2, { people: ['Levin', 'Fenno'], things: [] }],
  ]);

  it('names an invented figure the arc did not declare', () => {
    const c: any = runPlanCounters({
      pages, roster, commissionedNames: ['Levin'], placeNames: [],
      declaredInvented: ['Fenno'], inventedAllowance: 2,
    });
    const f = c.findings.find((x: any) => x.code === 'ARC_INVENTED_UNDECLARED');
    expect(f).toBeTruthy();
    expect(f.detail).toMatch(/Mama/);
  });
  it('is never must-fix — a re-plan cannot remove a character', () => {
    expect(replanRank({ kind: 'counter', code: 'ARC_INVENTED_UNDECLARED' })).toBe('also');
    expect(replanRank({ kind: 'counter', code: 'ARC_INVENTED_OVER_ALLOWANCE' })).toBe('also');
  });
  it('stays silent when nothing is passed (old callers unaffected)', () => {
    const c: any = runPlanCounters({ pages, commissionedNames: ['Levin'], placeNames: [] });
    expect(c.findings.some((x: any) => String(x.code).startsWith('ARC_INVENTED'))).toBe(false);
  });
});
