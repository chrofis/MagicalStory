/**
 * ONE CORRECTIVE LOOP FOR BOTH BRIEF PATHS.
 *
 * A brief's mechanical findings are answered twice in this codebase: by the
 * scene review on the authored path (beatsPipeline.js) and by a corrective
 * re-ask on the rewrite path (images.js iteratePageCore). The second was a
 * hand-rolled copy of the first and measurably did not work — over the 11
 * stored iterate rounds of staging job_1789584708605_rts4wqupm (p4, p6, p9,
 * p10, p13, p16) and job_1789506283204_3kxqshifx (p2, p7, p10, p13, p16) it
 * fired once per page and resolved findings on ZERO of them.
 *
 * Three defects, pinned here against those same 11 rounds:
 *   1. the corrector was never shown the text it was correcting,
 *   2. acceptance compared COUNTS, so a correction that swaps one fault for
 *      another scored equal and was rejected,
 *   3. the corrector was the model that had just failed the contract.
 *
 * Structure and behaviour, never prose: no assertion reads a finding's wording
 * or a prompt's phrasing. Offline and free — pure code, no model call, no
 * database.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'fs';
import * as path from 'path';

const nodeRequire = createRequire(import.meta.url);
const BC = nodeRequire('../../server/lib/briefCorrection.js');
const IB = nodeRequire('../../server/lib/iterateBeat.js');
const { extractSceneMetadata } = nodeRequire('../../server/lib/sceneMetadata.js');
const { MODEL_DEFAULTS, resolveBriefCorrectionModel } = nodeRequire('../../server/config/models.js');
const FIXTURE = nodeRequire('./fixtures/iterate-rewrite-checks-staging.json');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

type Round = { job: string; pageNumber: number; planLine: string; parentBrief: string; rewriteBrief: string };
const ROUNDS: Round[] = FIXTURE.rounds;
const storyOf = (r: Round) => FIXTURE.stories[r.job];
const label = (r: Round) => `${r.job.slice(-8)} p${r.pageNumber}`;

/** The declaration half of the production check set, exactly as images.js runs it. */
const checksFor = (r: Round) => (text: string) => [
  ...IB.checkRewrittenBrief({
    pageNumber: r.pageNumber, brief: text, parentBrief: r.parentBrief,
    planLine: r.planLine, castNames: storyOf(r).castNames, visualBible: storyOf(r).visualBible,
  }),
  ...IB.checkCarriedFields({
    parentMetadata: extractSceneMetadata(r.parentBrief),
    rewriteMetadata: extractSceneMetadata(String(text || '')),
  }),
];

describe('the verdict is introduced-vs-survived, never a count', () => {
  it('refuses a correction that swaps one fault for another', () => {
    // The old rule was `after.length < before.length`. This pair is the case it
    // cannot see: equal counts, a different fault.
    const before = [{ pageNumber: 4, type: 'element_uncited' }];
    const after = [{ pageNumber: 4, type: 'interaction_multiple_actions' }];
    const v = BC.judgeCorrection({ before, after, acceptance: 'strict' });
    expect(v.accepted).toBe(false);
    expect(v.introduced.map((f: any) => f.type)).toEqual(['interaction_multiple_actions']);
    expect(v.resolved.map((f: any) => f.type)).toEqual(['element_uncited']);
  });

  it('refuses a correction that resolves one fault and adds two, even though the count is unchanged for one of them', () => {
    const before = [{ pageNumber: 2, type: 'a' }, { pageNumber: 2, type: 'b' }];
    const after = [{ pageNumber: 2, type: 'b' }, { pageNumber: 2, type: 'c' }];
    const v = BC.judgeCorrection({ before, after, acceptance: 'strict' });
    expect(v.accepted).toBe(false);
    expect(v.survived.map((f: any) => f.type)).toEqual(['b']);
    expect(v.introduced.map((f: any) => f.type)).toEqual(['c']);
  });

  it('takes a correction that resolves at least one finding and introduces none', () => {
    const before = [{ pageNumber: 9, type: 'a' }, { pageNumber: 9, type: 'b' }];
    const after = [{ pageNumber: 9, type: 'b' }];
    const v = BC.judgeCorrection({ before, after, acceptance: 'strict' });
    expect(v.accepted).toBe(true);
    expect(v.resolved.map((f: any) => f.type)).toEqual(['a']);
    expect(v.introduced).toEqual([]);
  });

  it('refuses a correction that resolves nothing', () => {
    const before = [{ pageNumber: 9, type: 'a' }];
    expect(BC.judgeCorrection({ before, after: before, acceptance: 'strict' }).accepted).toBe(false);
  });

  it('keys a finding by page and type, so the same type on another page is an introduction', () => {
    const v = BC.judgeCorrection({
      before: [{ pageNumber: 3, type: 'a' }],
      after: [{ pageNumber: 4, type: 'a' }],
      acceptance: 'strict',
    });
    expect(v.accepted).toBe(false);
    expect(v.introduced).toHaveLength(1);
  });

  it('advisory takes the correction whatever it did, and still reports the partition', () => {
    // The authored path's ruling (owner, 2026-08-11): the reviewer authored
    // both halves, so its rewrite stands and its faults are reported.
    const v = BC.judgeCorrection({
      before: [{ pageNumber: 1, type: 'a' }],
      after: [{ pageNumber: 1, type: 'b' }],
      acceptance: 'advisory',
    });
    expect(v.accepted).toBe(true);
    expect(v.introduced.map((f: any) => f.type)).toEqual(['b']);
    expect(v.resolved.map((f: any) => f.type)).toEqual(['a']);
  });

  it('rejects an unknown acceptance mode rather than defaulting to one', () => {
    expect(() => BC.judgeCorrection({ before: [], after: [], acceptance: 'lenient' })).toThrow();
  });
});

describe('the corrector receives the text it is correcting', () => {
  it('the request built for a real stored round carries that round rewrite verbatim', () => {
    for (const r of ROUNDS) {
      const payload = BC.renderCorrectionRequest({
        context: 'RULES', priorText: r.rewriteBrief, findingsText: '[t] d', instruction: 'Return it again.',
      });
      expect(payload.includes(r.rewriteBrief.trim()), label(r)).toBe(true);
      expect(() => BC.assertCorrectorSeesText(payload, r.rewriteBrief, label(r))).not.toThrow();
    }
  });

  it('the payload shape the pre-change code sent is refused for every stored round', () => {
    // The old payload was the ORIGINAL prompt plus the findings: a re-roll, not
    // a correction. The parent brief stands in for that prompt here — what
    // matters is that the answer being corrected is absent from it.
    for (const r of ROUNDS) {
      const oldShape = `${r.parentBrief}\n\nYour previous answer breaks the brief contract:\n[t] d\n\nReturn the whole brief again.`;
      expect(() => BC.assertCorrectorSeesText(oldShape, r.rewriteBrief, label(r))).toThrow();
    }
  });

  it('a whole-book review prompt satisfies the same contract for each brief it carries', () => {
    // The authored path asserts against its own review prompt, whose scenes
    // block carries every brief. One contract, both paths.
    const allScenes = ROUNDS.map(r => `## Page ${r.pageNumber}\n${r.rewriteBrief}`).join('\n\n');
    const reviewPrompt = `# ALL SCENE BRIEFS\n\n${allScenes}\n\n# BRIEF FAULTS\n- Page 4:\n  - [t] d`;
    for (const r of ROUNDS) {
      expect(() => BC.assertCorrectorSeesText(reviewPrompt, r.rewriteBrief, label(r))).not.toThrow();
    }
  });

  it('refuses to run a correction with no prior text at all', () => {
    expect(() => BC.assertCorrectorSeesText('anything', '')).toThrow();
  });
});

describe('correctFindings over the real stored rounds', () => {
  const faulted = ROUNDS.filter(r => checksFor(r)(r.rewriteBrief).length > 0);

  it('every stored round still carries at least one finding — the fixture is the failing case', () => {
    expect(faulted.length).toBeGreaterThan(0);
  });

  it('hands the corrector a payload carrying the rewrite, and keeps the rewrite when the correction swaps a fault', async () => {
    const r = faulted[0];
    const before = checksFor(r)(r.rewriteBrief);
    let seen = '';
    const out = await BC.correctFindings({
      label: label(r),
      priorText: r.rewriteBrief,
      before,
      payload: BC.renderCorrectionRequest({
        context: 'RULES', priorText: r.rewriteBrief, findingsText: IB.describeBriefFindings(before), instruction: 'Return it again.',
      }),
      invoke: async (payload: string) => { seen = payload; return { text: 'CORRECTED', usable: true }; },
      // Resolves everything it was sent and returns one fault of another type:
      // the same COUNT is possible, and the old rule would have taken it.
      recheck: () => [{ pageNumber: r.pageNumber, type: 'zzz_other_fault' }],
    });
    expect(seen.includes(r.rewriteBrief.trim())).toBe(true);
    expect(out.accepted).toBe(false);
    expect(out.text).toBe(r.rewriteBrief);
  });

  it('takes the correction when it resolves without introducing, on every faulted round', async () => {
    for (const r of faulted) {
      const before = checksFor(r)(r.rewriteBrief);
      const out = await BC.correctFindings({
        label: label(r),
        priorText: r.rewriteBrief,
        before,
        payload: BC.renderCorrectionRequest({
          context: 'RULES', priorText: r.rewriteBrief, findingsText: IB.describeBriefFindings(before), instruction: 'Return it again.',
        }),
        invoke: async () => ({ text: 'CORRECTED', usable: true }),
        recheck: () => [],
      });
      expect(out.accepted, label(r)).toBe(true);
      expect(out.text).toBe('CORRECTED');
      expect(out.resolved.length, label(r)).toBe(before.length);
    }
  });

  it('keeps the prior text when the correction comes back unusable', async () => {
    const r = faulted[0];
    const before = checksFor(r)(r.rewriteBrief);
    const out = await BC.correctFindings({
      label: label(r),
      priorText: r.rewriteBrief,
      before,
      payload: BC.renderCorrectionRequest({
        context: 'RULES', priorText: r.rewriteBrief, findingsText: 'x', instruction: 'y',
      }),
      invoke: async () => ({ text: 'cut off mid-', usable: false }),
      recheck: () => [],
    });
    expect(out.accepted).toBe(false);
    expect(out.text).toBe(r.rewriteBrief);
    expect(out.after).toEqual(before);
  });

  it('refuses to run without a re-check — a correction nobody measures is a re-roll', async () => {
    await expect(BC.correctFindings({ priorText: 'a', payload: 'a', invoke: async () => ({ text: 'b' }) }))
      .rejects.toThrow();
  });
});

describe('both call sites go through the one routine', () => {
  const imagesJs = read('server/lib/images.js');
  const beatsJs = read('server/lib/beatsPipeline.js');

  it('each path requires the shared module', () => {
    expect(imagesJs).toContain("require('./briefCorrection')");
    expect(beatsJs).toContain("require('./briefCorrection')");
  });

  it('the rewrite path issues its correction through correctFindings', () => {
    expect(imagesJs).toContain('correctFindings(');
    expect(imagesJs).toContain('renderCorrectionRequest(');
  });

  it('the authored path takes its verdict from judgeCorrection', () => {
    expect(beatsJs).toContain('judgeCorrection(');
    expect(beatsJs).toContain('assertCorrectorSeesText(');
  });

  it('neither path hand-rolls a count comparison over its findings', () => {
    // The defect this whole change exists to remove. A `.length <` between two
    // finding lists is the shape it had on both re-asks.
    const countRule = /Findings\.length\s*[<>]=?\s*\w*Findings\.length/;
    expect(countRule.test(imagesJs), 'images.js compares finding COUNTS').toBe(false);
    expect(countRule.test(beatsJs), 'beatsPipeline.js compares finding COUNTS').toBe(false);
  });

  it('a failed correction never destroys the round it was improving', () => {
    // The old code's own comment promised this ("a gate is a guideline and an
    // iterate round is paid, so this never fails the round") while a provider
    // error inside the re-ask threw straight out of iteratePageCore.
    const call = imagesJs.indexOf('correctFindings({');
    const tail = imagesJs.slice(call, call + 3000);
    expect(tail).toMatch(/\}\)\.catch\(\(err\) => \{/);
    expect(tail).toContain('return { accepted: false };');
  });

  it('the authored path reports a payload violation instead of killing the review', () => {
    const at = beatsJs.indexOf('assertCorrectorSeesText(');
    expect(beatsJs.slice(Math.max(0, at - 400), at + 400)).toMatch(/try \{[\s\S]*assertCorrectorSeesText\([\s\S]*\} catch/);
  });

  it('the rewrite path issues exactly one corrective re-ask', () => {
    // Two stood here and neither worked; a third would be the same mistake a
    // third time. One call site, one call.
    expect((imagesJs.match(/correctFindings\(\{/g) || []).length).toBe(1);
  });
});

describe('the corrector runs on the pipeline model, from a named constant', () => {
  it('the brief corrector has its own key and is not the rewriter model', () => {
    expect(typeof MODEL_DEFAULTS.briefCorrectionModel).toBe('string');
    expect(MODEL_DEFAULTS.briefCorrectionModel).not.toBe(MODEL_DEFAULTS.sceneIteration);
  });

  it('it defaults to the scene reviewer — the model that answers these findings on the authored path', () => {
    expect(MODEL_DEFAULTS.briefCorrectionModel).toBe(MODEL_DEFAULTS.sceneReviewModel);
  });

  it('the rewrite path resolves the model through that key, never a literal', () => {
    expect(read('server/lib/images.js')).toContain('resolveBriefCorrectionModel()');
    expect(typeof resolveBriefCorrectionModel()).toBe('string');
  });
});
