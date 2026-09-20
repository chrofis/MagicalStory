/**
 * FOUR THINGS A RUN MUST NOT DO IN SILENCE.
 *
 * Every case below was measured on staging job_1789584708605_rts4wqupm (the
 * reference run) or on the 33 staging stories that carry a stored lector reply.
 *
 * 1. **A CHAR FIX ROUTED AT A FIGURE IT CANNOT PAINT.** p11's plan line stages
 *    an invented secondary, the bible has its entry, the entity check filed a
 *    CRITICAL on it, and the round reported `character <name> not found`. The
 *    figure was drawn, detected and graded — what is missing is the avatar a
 *    repaint copies from, which an invented figure never has. The round was
 *    spent on a certain failure and the message named the wrong cause.
 *
 * 2. **THE LAB'S SCENE-REVIEW REPLAY SAW LESS THAN PRODUCTION.** Production
 *    passes `{ clothingFindings, briefFindings, beats, visualBible }`; the
 *    replay passed three of the four, so `{BRIEF_FINDINGS}` filled empty and the
 *    stage could not reproduce a rewrite the production run made.
 *
 * 3. **A FINDING-SHAPED LINE THE PARSER CANNOT READ.** Skipping unparseable
 *    lines is right for a model musing between findings and wrong for a
 *    malformed finding: the two were indistinguishable, and a reply offering
 *    nine findings could be reported as seven with no trace of the other two.
 *
 * 4. **A WHOLE-PAGE PASS'S OWN REPORT.** The page blocks it returns are a
 *    claim; the diff is the check. A returned block identical to the text it was
 *    given used to read exactly like a page the pass never answered.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require_ = createRequire(import.meta.url);
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

// @ts-ignore — CommonJS libs
const { charFixReferenceGap } = require_('../../server/lib/charRepairTarget.js');
// @ts-ignore
const { decideRepairMethod } = require_('../../server/lib/repairLogic.js');
// @ts-ignore
const {
  parseLectorFindings, parseLectorLines, classifyLectorLine,
  resolveFindingOutcomes, FINDING_OUTCOME,
} = require_('../../server/lib/textRefine.js');

// ── 1. A FIGURE WITH NO REFERENCE IS DECLINED, NOT MISNAMED ──────────────────

describe('charFixReferenceGap — can a char fix paint this figure at all', () => {
  const roster = [{ name: 'Mila' }, { name: 'Tomás' }];

  it('a roster character is repairable', () => {
    expect(charFixReferenceGap({ characters: roster, characterName: 'Mila' })).toBeNull();
  });

  it('matches the roster canonically, so casing and accents do not create a phantom gap', () => {
    expect(charFixReferenceGap({ characters: roster, characterName: 'mila' })).toBeNull();
    expect(charFixReferenceGap({ characters: roster, characterName: 'Tomas' })).toBeNull();
  });

  it('a figure the story invented has no reference, and the reason says so', () => {
    const gap = charFixReferenceGap({ characters: roster, characterName: 'the scooter boy' });
    expect(gap).not.toBeNull();
    expect(gap.reason).toBe('no-roster-entry');
    // The old sentence was "character X not found", which reads as a typo or a
    // detection miss on a page where the figure is plainly there.
    expect(gap.message).toMatch(/no uploaded character entry/);
    expect(gap.message).not.toMatch(/not found/);
  });
});

describe('the repair router declines a char fix it cannot execute', () => {
  const roster = [{ name: 'Mila' }];
  const evaluation = { scoreBreakdown: { visual: { score: 60 }, semantic: { score: 60 } }, qualityScore: 60 };
  const entityReport = (name: string) => ({
    characters: { [name]: { issues: [{ id: 'i1', severity: 'CRITICAL', description: 'face drift', pagesToFix: [11] }] } },
  });

  it('routes char-fix for a CRITICAL on a roster character', () => {
    const d = decideRepairMethod(11, evaluation, entityReport('Mila'), { characters: roster });
    expect(d.method).toBe('char-fix');
    expect(d.charName).toBe('Mila');
  });

  it('does NOT route char-fix for a CRITICAL on an invented figure', () => {
    const d = decideRepairMethod(11, evaluation, entityReport('the scooter boy'), { characters: roster });
    expect(d.method).not.toBe('char-fix');
  });

  it('keeps its old behaviour when no roster is handed in', () => {
    // Callers that do not carry the roster (and the unit tests that predate it)
    // must not start losing repairs to a check they cannot answer.
    const d = decideRepairMethod(11, evaluation, entityReport('the scooter boy'));
    expect(d.method).toBe('char-fix');
  });

  it('a wardrobe figure-redo is declined on the same grounds', () => {
    const clothingOn = (name: string) => ({
      ...evaluation,
      fixableIssues: [{ type: 'clothing', severity: 'MAJOR', character: name, description: 'wrong jacket' }],
    });
    // Positive control first — the gate must still fire for a roster character,
    // or this test would pass on a gate that stopped working altogether.
    expect(decideRepairMethod(11, clothingOn('Mila'), null, { characters: roster }).method).toBe('char-fix');
    expect(decideRepairMethod(11, clothingOn('the scooter boy'), null, { characters: roster }).method).not.toBe('char-fix');
  });
});

describe('every char-repair entry point reports the same reason', () => {
  it('the pipeline round and the manual endpoint both ask charFixReferenceGap', () => {
    expect(read('server/lib/repairPipeline.js')).toMatch(/charFixReferenceGap\(\{ characters, characterName: charName \}\)/);
    expect(read('server/routes/regeneration.js')).toMatch(/charFixReferenceGap\(\{ characters: storyData\.characters/);
  });

  it('the router is handed the roster', () => {
    expect(read('server/lib/repairPipeline.js'))
      .toMatch(/decideRepairMethod\(img\.pageNumber, latestEval, currentEntityReport, \{ characters \}\)/);
  });
});

// ── 2. THE LAB REPLAY IS GIVEN WHAT PRODUCTION IS GIVEN ──────────────────────

describe('the scene-review replay passes all four options production passes', () => {
  const testlab = read('server/lib/testlab.js');

  it('the replay stage passes brief findings alongside clothing, beats and the bible', () => {
    expect(testlab).toMatch(/prompt = buildSceneReviewPrompt\(storyData, scenes, \{[\s\S]{0,300}?briefFindings: briefFindingsBlock,/);
    expect(testlab).toMatch(/prompt = buildSceneReviewPrompt\(storyData, scenes, \{[\s\S]{0,300}?visualBible: storyData\.visualBible,/);
  });

  it('it computes them from the same check production runs, with the bible secondaries in the cast', () => {
    // A figure the story invents can never trigger cast_unlisted unless the
    // bible's secondaries are in the name list — the same reason beatsPipeline
    // builds it that way.
    expect(testlab).toMatch(/require\('\.\/sceneBriefCheck'\)/);
    expect(testlab).toMatch(/visualBible\?\.secondaryCharacters/);
  });

  it('the block only reaches the reviewer when the option is passed', async () => {
    const { loadPromptTemplates } = require_('../../server/services/prompts');
    await loadPromptTemplates();
    const PB = require_('../../server/lib/promptBuilders');
    const inputData = { characters: [{ name: 'Mila' }], language: 'de', pages: 1 };
    const scenes = [{ pageNumber: 1, brief: 'A hallway.' }];
    const block = '# BRIEF FAULTS\n\n- Page 1:\n  - [cast_unlisted] the prose names a second figure';
    expect(PB.buildSceneReviewPrompt(inputData, scenes, {})).not.toContain('# BRIEF FAULTS');
    expect(PB.buildSceneReviewPrompt(inputData, scenes, { briefFindings: block })).toContain('# BRIEF FAULTS');
  });
});

// ── 3. AN UNREADABLE FINDING LINE IS COUNTED ─────────────────────────────────

describe('parseLectorLines — findings AND the lines it could not read', () => {
  it('a well-formed line is a finding and nothing is reported unreadable', () => {
    const { findings, unparsed } = parseLectorLines("PAGE 3: 'a bridge of stone' -> 'a stone bridge'");
    expect(findings).toHaveLength(1);
    expect(unparsed).toHaveLength(0);
  });

  it('prose between findings is NOT counted — a musing model is not a defect', () => {
    const { findings, unparsed } = parseLectorLines([
      'Ich habe den Text zweimal gelesen.',
      "PAGE 2: 'ein Wort' -> 'zwei Woerter'",
      'Sonst ist alles in Ordnung.',
    ].join('\n'));
    expect(findings).toHaveLength(1);
    expect(unparsed).toHaveLength(0);
  });

  it('a finding-shaped line the parser cannot read is counted, with a reason', () => {
    const { findings, unparsed } = parseLectorLines([
      "PAGE 3: 'unclosed span -> 'a fix'",          // malformed quoting
      "PAGE 4: 'the extra words' -> ''",            // empty correction
      "PAGE 5: 'same words' -> 'same words'",       // nothing to change
    ].join('\n'));
    expect(findings).toHaveLength(0);
    expect(unparsed).toHaveLength(3);
    expect(unparsed.map((u: any) => u.reason)).toEqual([
      'a quote is opened and never closed',
      'one side of the arrow is empty',
      'the correction is identical to the quote',
    ]);
    expect(unparsed[0].line).toContain('PAGE 3');
  });

  it('parseLectorFindings is the findings half of the same classification', () => {
    const text = ["PAGE 3: 'a' -> 'b'", "PAGE 4: 'unclosed -> 'c'"].join('\n');
    expect(parseLectorFindings(text)).toEqual(parseLectorLines(text).findings);
    expect(parseLectorFindings(text)).toHaveLength(1);
  });

  it('classifyLectorLine answers exactly one of the three for any line', () => {
    expect(classifyLectorLine('')).toBeNull();
    expect(classifyLectorLine('just prose')).toBeNull();
    expect(classifyLectorLine("PAGE 1: 'a' -> 'b'")).toHaveProperty('finding');
    expect(classifyLectorLine("PAGE 1: 'a' -> 'a'")).toHaveProperty('rejected');
  });

  it('both passes record the count they used to drop', () => {
    const src = read('server/lib/textRefine.js');
    expect(src).toMatch(/unparsedCount: lectorUnparsed\.length/);
    expect(src).toMatch(/unparsedCount: diffUnparsed\.length/);
    expect(read('server/lib/textRefine.js')).toMatch(/unparsedCount: r\.unparsedCount \?\? null/);
  });
});

// ── 4. THE PASS'S CLAIM, CHECKED AGAINST THE DIFF ────────────────────────────

describe('resolveFindingOutcomes separates a refuted claim from an unanswered finding', () => {
  const pages = [{ pageNumber: 1 }, { pageNumber: 2 }, { pageNumber: 3 }];
  const findings = [
    { category: 'UNFORCED', pageNumber: 1, text: 'p1 fault' },
    { category: 'CAUSE', pageNumber: 2, text: 'p2 fault' },
    { category: 'PULL', pageNumber: 3, text: 'p3 fault' },
  ];

  it('a page returned as a rewrite whose text did not move is its own outcome', () => {
    // p1 rewritten, p2 returned byte-identical, p3 never returned.
    const out = resolveFindingOutcomes(findings, pages, [1], [1, 2]);
    expect(out[0].outcome).toBe(FINDING_OUTCOME.PAGE_REWRITTEN);
    expect(out[1].outcome).toBe(FINDING_OUTCOME.PAGE_RETURNED_IDENTICAL);
    expect(out[1].reason).toMatch(/identical to the one it was given/);
    expect(out[2].outcome).toBe(FINDING_OUTCOME.PAGE_UNCHANGED);
    expect(out[2].reason).toMatch(/did not return page 3/);
  });

  it('without the returned list both stay page-unchanged, as every earlier caller meant', () => {
    const out = resolveFindingOutcomes(findings, pages, [1]);
    expect(out[1].outcome).toBe(FINDING_OUTCOME.PAGE_UNCHANGED);
    expect(out[2].outcome).toBe(FINDING_OUTCOME.PAGE_UNCHANGED);
  });

  it('the ledger stays total — one outcome per finding, and neither new state is silent', () => {
    const out = resolveFindingOutcomes(findings, pages, [1], [1, 2]);
    expect(out).toHaveLength(findings.length);
    for (const f of out) {
      expect(Object.values(FINDING_OUTCOME)).toContain(f.outcome);
      if (f.outcome !== FINDING_OUTCOME.PAGE_REWRITTEN) expect(f.reason).toBeTruthy();
    }
  });

  it('the repair pass computes both halves of its report from the diff', () => {
    const src = read('server/lib/textRefine.js');
    expect(src).toMatch(/const returnedIdentical = returnedPages\.filter\(n => !changedPages\.includes\(n\)\)/);
    expect(src).toMatch(/const changedUnasked = changedPages\.filter\(n => !askedPages\.has\(n\)\)/);
    expect(src).toMatch(/resolveFindingOutcomes\(findings, base, changedPages, returnedPages\)/);
    expect(read('server/lib/textRefine.js')).toMatch(/returnedIdentical: r\.returnedIdentical \|\| \[\]/);
  });
});

// ── 5. A DECLARED TRAIT IS COPIED, NOT RECALLED ──────────────────────────────

describe('both iterate templates carry the declared-trait contract', () => {
  it('each template declares the placeholder', () => {
    // fillTemplate drops an undeclared key in silence, so the rule reaches a
    // template only through a placeholder that template spells out.
    expect(read('prompts/scene-iteration.txt')).toContain('{DECLARED_TRAIT_VERBATIM}');
    expect(read('prompts/scene-iteration-free.txt')).toContain('{DECLARED_TRAIT_VERBATIM}');
  });

  it('the one call site fills it for both, and nothing is left unfilled', async () => {
    const { loadPromptTemplates } = require_('../../server/services/prompts');
    await loadPromptTemplates();
    const PB = require_('../../server/lib/promptBuilders');
    const characters = [{
      name: 'Mila',
      physical: { hairColor: 'light blonde', hair: 'light blonde, wavy, short', eyeColor: 'green', apparentAge: 'preschooler', build: 'average' },
    }];
    for (const freeIterate of [false, true]) {
      const prompt = PB.buildSceneDescriptionPrompt(
        4, 'page text', characters, 'a summary', 'de', null, [], {}, '', '', null, null,
        { freeIterate, textInImage: false },
      );
      expect(prompt).toContain(PB.DECLARED_TRAIT_VERBATIM_RULE);
      expect(prompt).not.toContain('{DECLARED_TRAIT_VERBATIM}');
      // The traits the rule protects are in the same prompt, verbatim — that is
      // what makes a drifted colour a rewrite fault and not a missing input.
      expect(prompt).toMatch(/Eyes: green/);
      expect(prompt).toMatch(/Hair: light blonde, wavy, short/);
    }
  });

  it('the rule names the trait words as the part that may not be reworded', () => {
    const PB = require_('../../server/lib/promptBuilders');
    expect(PB.DECLARED_TRAIT_VERBATIM_RULE).toMatch(/entry's own words/);
    expect(PB.DECLARED_TRAIT_VERBATIM_RULE).toMatch(/hair colour/);
    expect(PB.DECLARED_TRAIT_VERBATIM_RULE).toMatch(/eye colour/);
  });
});
