/**
 * THE REWRITE, REBUILT FROM THE RUNS THAT MOTIVATED THE PARITY WORK.
 *
 * tests/unit/ad-iterate-parity.test.ts checks that the four page-brief authoring
 * sites hold one contract. This one checks the contract against the real thing:
 * the 11 stored iterate rounds of staging job_1789584708605_rts4wqupm and
 * job_1789506283204_3kxqshifx, and one of them rebuilt through the real builder.
 *
 * The fixture (fixtures/ad-iterate-parity-staging.json) is stored data, not a
 * hand-written shape: each round's Art Director brief and its rewrite as they
 * were persisted, plus everything buildSceneDescriptionPrompt needs to rebuild
 * job_1789584708605_rts4wqupm p16 — the page whose rewrite emptied REQUIRED
 * OBJECTS and flipped "Levin is NOT wearing this" to "Levin IS wearing this".
 *
 * Two halves:
 *   1. THE MEASUREMENT, pinned. If a future change makes the rewrite carry these
 *      fields by some other route, this half fails and should be re-measured —
 *      it is the evidence the parity work rests on, not a target.
 *   2. THE REBUILD. The inputs the rewriter was missing now arrive, with a
 *      negative control for each so "the value arrived" is distinguishable from
 *      "the template says those words anyway".
 *
 * Offline and free: no API call, no database.
 */
import { describe, it, beforeAll, expect } from 'vitest';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const PB = nodeRequire('../../server/lib/promptBuilders.js');
const IB = nodeRequire('../../server/lib/iterateBeat.js');
const { loadPromptTemplates } = nodeRequire('../../server/services/prompts.js');
const FIXTURE = nodeRequire('./fixtures/ad-iterate-parity-staging.json');

const F = FIXTURE.focus;
const unfilled = (p: string) => [...new Set(String(p).match(/\{[A-Z][A-Z0-9_]*\}/g) || [])];

// ── 1. The measurement ──────────────────────────────────────────────────────

describe('what a brief rewrite dropped, on every stored round of two staging runs', () => {
  it('there are 11 rounds across the two runs', () => {
    expect(FIXTURE.rounds.length).toBe(11);
    expect(new Set(FIXTURE.rounds.map((r: any) => r.job)).size).toBe(2);
  });

  it.each(['shot', 'landmarkView'])(
    'the Art Director declared %s on every round and the rewrite on none', (field) => {
      const ad = FIXTURE.rounds.filter((r: any) => r.artDirector[field]).length;
      const rw = FIXTURE.rounds.filter((r: any) => r.rewrite[field]).length;
      expect(ad, `the brief being replaced carried ${field}`).toBe(11);
      expect(rw, `the rewrite carried ${field} — re-measure, the gap may have closed elsewhere`).toBe(0);
    });

  it('every Art Director character carried depth and looksAt; no rewritten character carried either', () => {
    for (const r of FIXTURE.rounds) {
      const label = `${r.job} p${r.pageNumber}`;
      if (r.artDirector.characters > 0) {
        expect(r.artDirector.depth, `${label}: AD depth`).toBe(r.artDirector.characters);
        expect(r.artDirector.looksAt, `${label}: AD looksAt`).toBe(r.artDirector.characters);
      }
      expect(r.rewrite.depth, `${label}: rewrite depth`).toBe(0);
      expect(r.rewrite.looksAt, `${label}: rewrite looksAt`).toBe(0);
    }
  });

  it('every Art Director interaction named an action; no rewritten interaction did', () => {
    for (const r of FIXTURE.rounds) {
      expect(r.artDirector.action, `${r.job} p${r.pageNumber}: AD action`).toBe(r.artDirector.interactions);
      expect(r.rewrite.action, `${r.job} p${r.pageNumber}: rewrite action`).toBe(0);
    }
  });

  it('no rewrite emitted a wornItems row', () => {
    expect(FIXTURE.rounds.filter((r: any) => r.rewrite.wornItems)).toEqual([]);
  });

  it('p16: the rewrite emptied REQUIRED OBJECTS and flipped the jacket back on', () => {
    // The stored image prompts, exactly as they were sent.
    expect(F.originalPrompt.objectsInPrompt).toMatch(/dragon egg/);
    expect(F.originalPrompt.objectsInPrompt).toMatch(/red jacket/);
    expect(F.storedRewrite.objectsInPrompt).not.toMatch(/dragon egg/);
    expect(F.originalPrompt.wornBlockInPrompt).toMatch(/is NOT wearing this/);
    expect(F.storedRewrite.wornBlockInPrompt).toMatch(/IS wearing this/);
  });
});

// ── 2. The rebuild ──────────────────────────────────────────────────────────

const parentWorn = () => IB.renderParentWornState({
  visualBible: F.visualBible,
  promptCharacters: F.characters,
  parentSceneMetadata: F.parentSceneMetadata,
  pageNumber: F.pageNumber,
});

function build(opts: any = {}) {
  return PB.buildSceneDescriptionPrompt(
    F.pageNumber, F.pageText, F.characters, F.parentSceneMetadata?.imageSummary || '',
    F.language, F.visualBible, [], F.expectedClothing, '', '',
    { planLine: F.planLine },
    {
      composition: '(the vision analysis of the failed render)',
      fixIssues: (F.evaluationFeedback.fixableIssues || []).map((i: any) => i?.description || i?.issue || String(i)),
      previousScore: F.evaluationFeedback.score,
    },
    {
      freeIterate: false,
      textInImage: (F.layout?.textInImage ?? false) === true,
      clothingRequirements: F.clothingRequirements,
      story: { ...F, characters: F.characters },
      evaluatorReasoning: IB.renderEvaluatorReasoning(F.evaluationFeedback),
      fixTargets: IB.renderFixTargetLines(F.evaluationFeedback, null),
      wornState: parentWorn(),
      ...opts,
    }
  );
}

describe('rebuilding job_1789584708605_rts4wqupm p16 through the real builder', () => {
  let prompt = '';
  let blind = '';

  beforeAll(async () => {
    await loadPromptTemplates();
    prompt = build();
    // Negative control: the same page with none of the new inputs supplied.
    blind = build({ evaluatorReasoning: '', fixTargets: '', wornState: '', story: null });
  });

  it('builds, and no placeholder survives unfilled', () => {
    expect(prompt.length).toBeGreaterThan(10000);
    expect(unfilled(prompt)).toEqual([]);
    expect(unfilled(blind)).toEqual([]);
  });

  it('the page\'s declared worn state arrives — the exact fact the stored rewrite contradicted', () => {
    const worn = parentWorn();
    expect(worn, 'the parent brief\'s worn row no longer resolves').toMatch(/is NOT wearing this on this page/);
    expect(worn).toMatch(/carried as a bundle/);
    expect(prompt).toContain(worn);
    expect(blind, 'negative control: the sentence is an input, not template boilerplate')
      .not.toMatch(/is NOT wearing this on this page/);
  });

  it('the evaluator\'s own reasoning arrives', () => {
    const reasoning = IB.renderEvaluatorReasoning(F.evaluationFeedback);
    expect(reasoning.length).toBeGreaterThan(500);
    expect(prompt).toContain(reasoning);
    expect(prompt).toMatch(/Evaluator reasoning on the previous render/);
    expect(blind).not.toMatch(/Evaluator reasoning on the previous render/);
  });

  it('the regions the evaluator marked arrive, named as frame regions rather than numbers', () => {
    const targets = IB.renderFixTargetLines(F.evaluationFeedback, null);
    expect(targets.split('\n').length).toBe(F.evaluationFeedback.fixTargets.length);
    expect(targets).toMatch(/of the frame|centre of the frame/);
    expect(targets, 'a brief never carries coordinates').not.toMatch(/0\.\d{3}/);
    expect(prompt).toContain(targets);
    expect(blind).not.toMatch(/Regions the evaluator marked/);
  });

  it('the book\'s season and the cast\'s height order arrive', () => {
    expect(prompt).toMatch(/\*\*Season:\*\* Autumn/);
    expect(prompt).toMatch(/HEIGHT ORDER/);
    // The season resolver falls back to today's date when it has no story, so
    // the control is a DIFFERENT season rather than none: the value has to
    // track the story, not the calendar.
    const winter = build({ story: { ...F, season: 'winter' } });
    expect(winter).toMatch(/\*\*Season:\*\* Winter/);
    expect(winter).not.toMatch(/\*\*Season:\*\* Autumn/);
    expect(blind, 'the height order comes from the cast this call is given').toMatch(/HEIGHT ORDER/);
  });

  it('a cited state carries the page range that decides which handle this page uses', () => {
    // ART004 (the jacket) has states [7,9,10] and [15,16,17,18]; p16 is the second.
    expect(prompt).toMatch(/\[ART004\.2\][^\n]*\(pages 15, 16, 17, 18\)/);
    expect(prompt).toMatch(/\[ART004\.1\][^\n]*\(pages 7, 9, 10\)/);
  });

  it('the rewriter is now asked for the fields it dropped on all 11 rounds', () => {
    for (const field of ['`shot`', '`landmarkPhoto`', '`wornItems[]`', '`depth`', '`looksAt`']) {
      expect(prompt.includes(field), `the rewrite prompt never mentions ${field}`).toBe(true);
    }
    expect(prompt).toMatch(/`action` is required on every row/);
  });

  it('the shared page contracts reach this real build', () => {
    for (const name of ['ONE_INSTANT_RULE', 'GAZE_TARGET_RULE', 'LOOKS_AT_FIELD_RULE',
      'GARMENT_REMOVED_RULE', 'WORN_ON_OTHER_RULE', 'ABSENT_THING_RULE',
      'SCENE_INTENT_FIELD_RULE', 'PLAN_LINE_CAST_RULE', 'COUNTING_RULE']) {
      expect(prompt.includes(PB[name]), `${name} does not reach the rewrite of a real page`).toBe(true);
    }
  });
});
