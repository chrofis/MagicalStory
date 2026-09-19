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
 * And one ruling on top of them (owner, 2026-09-18): a finding the corrected
 * text reports and the prior text did not is REPORTED, never a refusal. Over
 * the same 11 rounds that refusal fired 5 times and was wrong 5 times — see
 * the "a newly reported finding does not refuse the correction" block.
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
  it('reports the partition when a correction swaps one fault for another', () => {
    // The old rule was `after.length < before.length`. This pair is the case it
    // cannot see: equal counts, a different fault. The partition names both
    // halves; what the verdict DOES with them is the next describe block.
    const before = [{ pageNumber: 4, type: 'cast_unlisted' }];
    const after = [{ pageNumber: 4, type: 'interaction_multiple_actions' }];
    const v = BC.judgeCorrection({ before, after, acceptance: 'strict' });
    expect(v.introduced.map((f: any) => f.type)).toEqual(['interaction_multiple_actions']);
    expect(v.resolved.map((f: any) => f.type)).toEqual(['cast_unlisted']);
  });

  it('separates survived from newly reported when one of each is present', () => {
    const before = [{ pageNumber: 2, type: 'a' }, { pageNumber: 2, type: 'b' }];
    const after = [{ pageNumber: 2, type: 'b' }, { pageNumber: 2, type: 'c' }];
    const v = BC.judgeCorrection({ before, after, acceptance: 'strict' });
    expect(v.resolved.map((f: any) => f.type)).toEqual(['a']);
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

  it('refuses a correction that resolves nothing even when it reports something new', () => {
    // The surviving refusal branch. `resolves nothing` is a different ruling
    // from the deleted `introduces` one and is not touched by it: no gain was
    // shown, so the text that was reviewed stands.
    const v = BC.judgeCorrection({
      before: [{ pageNumber: 9, type: 'a' }],
      after: [{ pageNumber: 9, type: 'a' }, { pageNumber: 9, type: 'b' }],
      acceptance: 'strict',
    });
    expect(v.accepted).toBe(false);
    expect(v.reason).toContain('resolves nothing');
  });

  it('keys a finding by page and type, so the same type on another page is a different finding', () => {
    const v = BC.judgeCorrection({
      before: [{ pageNumber: 3, type: 'a' }],
      after: [{ pageNumber: 4, type: 'a' }],
      acceptance: 'strict',
    });
    expect(v.resolved.map((f: any) => f.pageNumber)).toEqual([3]);
    expect(v.introduced.map((f: any) => f.pageNumber)).toEqual([4]);
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

/**
 * A NEWLY REPORTED FINDING IS NOT GROUNDS TO REFUSE (owner, 2026-09-18).
 *
 * `strict` used to refuse any correction whose after-list carried a (page,
 * type) the before-list did not. Over these same 11 stored rounds that branch
 * fired 5 times and was wrong on 5 of 5: the corrector had resolved EVERY
 * finding it was sent, and the "introduced" fault was already stated in the
 * page's own plan line, which predates both the rewrite and the correction.
 *
 * The mechanism is the checks' own inputs, and it is pinned below on the real
 * fixture: `interaction_multiple_actions` counts `interactions[].action` and
 * `interaction_object_shared_hands` counts `interactions[].hands`, and all 11
 * rewrites return their rows with neither. Both checks are therefore
 * structurally OFF before the correction — silent, not passing — and the
 * corrector restoring the field (which is exactly what `brief_field_dropped`
 * asked of it) wakes them on a fault that was always there.
 */
describe('a newly reported finding does not refuse the correction', () => {
  it('both interaction checks are silent on every stored rewrite, because the rows state neither field', () => {
    for (const r of ROUNDS) {
      const meta = extractSceneMetadata(r.rewriteBrief);
      const rows = ((meta?.fullData?.interactions ?? meta?.interactions ?? []) as any[])
        .filter((x: any) => x && typeof x === 'object');
      expect(rows.length, label(r)).toBeGreaterThan(0);
      expect(rows.some((x: any) => String(x.action || '').trim()), `${label(r)} states an action`).toBe(false);
      expect(rows.some((x: any) => x.hands === true), `${label(r)} states hands`).toBe(false);
      // …and the carried-field check is what asks for the field back, on every round.
      const dropped = IB.checkCarriedFields({
        parentMetadata: extractSceneMetadata(r.parentBrief),
        rewriteMetadata: meta,
      });
      expect(dropped.map((f: any) => f.type), label(r)).toEqual(['brief_field_dropped']);
      expect(dropped[0].fields, label(r)).toContain('interactions[].action');
    }
  });

  /**
   * The five rounds the deleted branch refused, as re-measured offline at
   * dba954ee6 over the 2026-09-17 live replay's stored finding lists. One page
   * per round; `after` is what the production check set reports against the
   * corrector's answer. Every one of them resolves its whole before-list.
   */
  const MEASURED = [
    { round: 'rts4wqupm p6', page: 6, before: ['brief_field_dropped', 'object_dropped_from_declared_set'], after: ['interaction_object_shared_hands'] },
    { round: 'rts4wqupm p10', page: 10, before: ['brief_field_dropped'], after: ['interaction_multiple_actions'] },
    { round: 'rts4wqupm p16', page: 16, before: ['brief_field_dropped', 'object_dropped_from_declared_set'], after: ['interaction_multiple_actions'] },
    { round: 'kxqshifx p2', page: 2, before: ['brief_field_dropped'], after: ['interaction_multiple_actions'] },
    { round: 'kxqshifx p10', page: 10, before: ['brief_field_dropped', 'character_outside_declared_set'], after: ['interaction_multiple_actions'] },
  ];

  it.each(MEASURED)('$round: a correction resolving everything it was sent is taken, and names what it now reports', (m) => {
    const mk = (types: string[]) => types.map(t => ({ pageNumber: m.page, type: t }));
    const v = BC.judgeCorrection({ before: mk(m.before), after: mk(m.after), acceptance: 'strict' });
    expect(v.accepted).toBe(true);
    expect(v.resolved.map((f: any) => f.type)).toEqual(m.before);
    expect(v.survived).toEqual([]);
    // The diagnostic is not destroyed with the refusal: the partition still
    // carries it and the verdict still names it.
    expect(v.introduced.map((f: any) => f.type)).toEqual(m.after);
    for (const t of m.after) expect(v.reason).toContain(t);
  });

  it('the deleted branch cannot come back by accident', () => {
    const src = read('server/lib/briefCorrection.js');
    expect(src).not.toContain('refused: introduces');
    // …while the branch the owner did NOT rule on is still there.
    expect(src).toContain("reason: 'refused: resolves nothing'");
  });

  it('the authored path still gets its introduced list, which is what it logs', () => {
    // beatsPipeline destructures { introduced, survived } and raises
    // `beats_brief_introduced` from it. Deleting the refusal must not delete
    // the field.
    const v = BC.judgeCorrection({
      before: [{ pageNumber: 1, type: 'a' }],
      after: [{ pageNumber: 1, type: 'b' }],
      acceptance: 'advisory',
    });
    expect(v).toHaveProperty('introduced');
    expect(v).toHaveProperty('survived');
    expect(read('server/lib/beatsPipeline.js')).toContain('const { introduced, survived } = judgeCorrection(');
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

  it('hands the corrector a payload carrying the rewrite, and takes a correction that resolves everything it was sent', async () => {
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
      // Resolves everything it was sent and comes back carrying a fault of
      // another type. That is the measured shape of all five 2026-09-18
      // refusals, and it is taken.
      recheck: () => [{ pageNumber: r.pageNumber, type: 'zzz_other_fault' }],
    });
    expect(seen.includes(r.rewriteBrief.trim())).toBe(true);
    expect(out.accepted).toBe(true);
    expect(out.text).toBe('CORRECTED');
    expect(out.resolved.length).toBe(before.length);
    expect(out.introduced.map((f: any) => f.type)).toEqual(['zzz_other_fault']);
    // The information is not dropped with the refusal — the verdict names it.
    expect(out.reason).toContain('zzz_other_fault');
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
