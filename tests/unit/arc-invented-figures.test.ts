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
 *
 * Since 2026-09-24 (logic-first arc, D1-A) the enumeration is the FACTS section
 * of the STORY LOGIC block: every named figure the plot runs on, tagged
 * (commissioned) or (new). Code counts the (new) tags against the allowance and
 * keeps the one forced round; the (commissioned) names outside the character
 * list feed commissionedCast.
 */
import { describe, it, expect } from 'vitest';

// @ts-ignore — CommonJS lib
import pb from '../../server/lib/promptBuilders.js';
const {
  parseStoryLogic, parseArcRetell, critiqueMaxSeverity,
  arcInventedAllowance, arcLogicSpec, replanRank,
} = pb as any;
// @ts-ignore — CommonJS lib
import counters from '../../server/lib/planCounters.js';
const { runPlanCounters } = counters as any;
// @ts-ignore — CommonJS lib
import modelsCfg from '../../server/config/models.js';
const { MODEL_DEFAULTS } = modelsCfg as any;
// @ts-ignore — CommonJS lib
import cc from '../../server/lib/castCoverage.js';
const { commissionedCast } = cc as any;

const logicBlock = (figureLines: string[], central = 'Central figure: Fenno') => [
  'STORY LOGIC:',
  'Want and stakes: the boys want to bring the egg home before dark.',
  'Opposition: the cold wind; a rival wants the egg for herself.',
  'Facts:',
  ...figureLines,
  '- An egg that cools too far never hatches.',
  central,
  'Chain:',
  '- because the egg knocks, the boys decide to keep it warm',
  '- but the wind takes the warmth, so they carry it to the bakery',
].join('\n');

const FOUR_NEW = [
  '- Levin (commissioned) — can climb; cannot carry the egg alone',
  '- Fenno (new) — can fly short hops; cannot speak',
  '- Nolo (new) — can dig; cannot climb',
  '- Mama (new) — can wait at the door; cannot leave the house',
  '- Nia (new) — can track by smell; cannot open doors',
];

const RETELL = [
  logicBlock(FOUR_NEW),
  'Fixing: fault 2, by giving the guard a motive.',
  'Keeping: the market scene and the climb.',
  'Challenges taken:',
  '1. reach the summit',
  'Used: Panelist A',
  'FINAL ARC:',
  '1. The children set out.',
  '2. They reach the ridge.',
  'CRITIQUE:',
  'Logic:',
  '- none',
  'Faults:',
  '1. [MINOR] the ridge is thin.',
].join('\n');

describe('the FACTS tags are the enumeration', () => {
  it('counts the (new) tags and keeps the (commissioned) ones apart', () => {
    const logic = parseStoryLogic(logicBlock(FOUR_NEW));
    expect(logic.invented).toEqual(['Fenno', 'Nolo', 'Mama', 'Nia']);
    expect(logic.commissioned).toEqual(['Levin']);
  });

  // job_1789147573901_m3uam0nxi: the premise reads "<child> and his dog <name>".
  // The dog is not in inputData.characters, only the arc reads the premise, and
  // the plan counters charged her against the invented allowance until the arc
  // carried her name out as commissioned.
  it('a premise figure tagged (commissioned) reaches commissionedCast, never the invented list', () => {
    const logic = parseStoryLogic(logicBlock([
      '- Levin (commissioned) — can climb; cannot fly',
      "- Nia (commissioned) — the boy's dog; can track; cannot open doors",
      '- Stone Guard (new) — can block the path; cannot leave the gate',
    ]));
    expect(logic.invented).toEqual(['Stone Guard']);
    const cast = commissionedCast({ characters: [{ name: 'Levin' }] }, logic.commissioned);
    expect(cast.listed).toEqual(['Levin']);
    expect(cast.supplied).toEqual(['Nia']);
    expect(cast.all).toEqual(['Levin', 'Nia']);
  });

  it('a figure line keeps a parenthetical of its own ahead of the tag', () => {
    const logic = parseStoryLogic(logicBlock(["- Nia (the hero's dog) (commissioned) — can track; cannot climb"]));
    expect(logic.commissioned).toEqual(["Nia (the hero's dog)"]);
  });

  it('a block with no tagged figure fails loudly — there is no degraded reading', () => {
    expect(() => parseStoryLogic(logicBlock(['- Levin — can climb']))).toThrow(/tagged/);
  });
});

describe('parseArcRetell reads the updated logic block', () => {
  it('does not leak the block into finalArc', () => {
    const r = parseArcRetell(RETELL);
    expect(r.logic.invented).toEqual(['Fenno', 'Nolo', 'Mama', 'Nia']);
    expect(r.finalArc).not.toMatch(/STORY LOGIC|\(new\)|because the egg knocks/);
    expect(r.finalArc).toMatch(/The children set out/);
    expect(r.fixing).toMatch(/fault 2/);
    expect(r.keeping).toMatch(/market scene/);
    expect(r.used).toBe('Panelist A');
    expect(r.sentences).toBe(2);
  });

  it('a re-telling WITHOUT the block is a parse error (NO FALLBACKS)', () => {
    const old = 'Fixing: x.\nKeeping: y.\nUsed: Panelist B\nFINAL ARC:\n1. A story.\nCRITIQUE:\n1. [MAJOR] a fault.';
    expect(() => parseArcRetell(old)).toThrow(/STORY LOGIC/);
  });
});

describe('the block must not inflate critiqueMaxSeverity', () => {
  it('the dash-line figure and chain lines add no fault', () => {
    expect(critiqueMaxSeverity(`${logicBlock(FOUR_NEW)}\n1. [MINOR] a blemish.`)).toBe('MINOR');
  });

  it('the contract says dash lines, never numbered', () => {
    const spec = arcLogicSpec({ characters: [{ name: 'A', age: 7 }] }, 18);
    expect(spec).toMatch(/never numbered/);
    expect(spec).toContain('"- <name> (new) — can …; cannot …"');
  });
});

describe('the source-based definition', () => {
  it('the FACTS spec defines the tags by SOURCE, not by role', () => {
    const txt = arcLogicSpec({ characters: [{ age: '7' }, { age: '6' }], languageLevel: 'standard' }, 18);
    expect(txt).not.toMatch(/opposition and its help/);
    expect(txt).toMatch(/never speaks/);
    expect(txt).toMatch(/an adult who sets a rule, waits or permits/);
    // Commissioned = character list + premise figures + figures a character's
    // saved details name (2026-09-23, one definition for every arc stage).
    expect(txt).toContain((pb as any).COMMISSIONED_CAST_DEF);
    expect(txt).toMatch(/places, vehicles and objects/);
    expect(txt).toMatch(/taking its name away does not take it off/);
    expect(txt).toContain(`room for ${arcInventedAllowance({ characters: [{ age: '7' }, { age: '6' }], languageLevel: 'standard' })} new named figures`);
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

  it('4 (new) figures against an allowance of 2 is an overcount; 2 is not', () => {
    const { arcShapeCounts } = pb as any;
    const input = { characters: Array.from({ length: 4 }, () => ({ age: '5' })), languageLevel: '1st-grade' };
    const over = arcShapeCounts({ sentences: 16, logic: parseStoryLogic(logicBlock(FOUR_NEW)), inputData: input, pageCount: 18 });
    expect(over.inventedAllowance).toBe(2);
    expect(over.inventedOver).toBe(true);
    const ok = arcShapeCounts({ sentences: 16, logic: parseStoryLogic(logicBlock(FOUR_NEW.slice(0, 3))), inputData: input, pageCount: 18 });
    expect(ok.inventedOver).toBe(false);
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

// Staging job_1790100385959_1nitlympp: the arc wrote an empty list as one
// wholly parenthesised line. The " — " split left "(none", which became a
// commissioned character and drew NO_FOCAL_PAGE + UNDER_COVERED_CHARACTER
// against itself on both plan rounds. The same negative answers are read the
// same way on a tagged figure line and on the central-figure line.
describe('a negative answer is no figure', () => {
  it('a tagged "none" line is no figure', () => {
    for (const line of ['- (none) (new) — nobody', '- none (commissioned) — the premise names nobody else', '- keine (new)']) {
      const logic = parseStoryLogic(logicBlock(['- Levin (commissioned) — can climb', line]));
      expect(logic.invented, line).toEqual([]);
      expect(logic.commissioned, line).toEqual(['Levin']);
    }
  });

  it('every parenthesised or qualified negative central figure is none', () => {
    for (const line of ['Central figure: none', 'Central figure: (none)', 'Central figure: none — the idea is about the main character', 'Central figure: (none']) {
      expect(parseStoryLogic(logicBlock(FOUR_NEW, line)).centralFigure, line).toBeNull();
    }
  });
});
