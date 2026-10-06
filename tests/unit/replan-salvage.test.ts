/**
 * A DISCARDED RE-PLAN ROUND KEEPS ITS GOOD PAGES (owner, 2026-09-28).
 *
 * Replays staging job_1790539784661_6mjcny1c7 round 1 from its stored replies
 * (tests/unit/fixtures/replan-salvage-job_1790539784661_6mjcny1c7.json) through
 * the production functions: planCheckInputs, createPlanCheckRunner (its
 * `compose`, the counters over parsed check facts) and
 * replanSalvage.salvageReplanRound. The round cast Levin into p4 and p7 and all
 * four boys into p12; the guard counted 6 → 8 and discarded it whole.
 * No model call is made here: every check is composed from the stored replies.
 * see docs/decisions.md 2026-09-28 "A discarded re-plan round keeps its good pages"
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);
const PB = req('../../server/lib/promptBuilders');
const BP = req('../../server/lib/beatsPipeline');
const { salvageReplanRound, compositeCheckInputs } = req('../../server/lib/replanSalvage');
const { resolveReplayInputData, resolveReplayArc, resolveReplayArcHints, resolveReplayCentralFigure, resolveReplayStoryLogic } = req('../../server/lib/beatsReplayInputs');
const { commissionedCast, parsePlanCastBlock } = req('../../server/lib/castCoverage');
const { loadPromptTemplates } = req('../../server/services/prompts');
const fx = req('./fixtures/replan-salvage-job_1790539784661_6mjcny1c7.json');

const parsedOf = (reply: string) => ({
  roster: PB.parsePlanCheckRoster(reply),
  obstacles: PB.parsePlanCheckObstacles(reply),
  peoplelessPick: PB.parsePlanCheckPeoplelessPick(reply),
  wanted: PB.parsePlanCheckWanted(reply),
  actions: PB.parsePlanCheckActions(reply),
  centralPages: PB.parsePlanCheckCentralPages(reply),
});
const codes = (c: any) => c.findings.filter((f: any) => f.kind === 'counter').map((f: any) => f.code).sort();
const whoOf = (pages: any[], n: number) => String(pages.find(p => p.pageNumber === n).planLine).split(/\s+—\s+/)[1];

let runCheck: any, standing: any[], returned: any[], given: any, recheck: any, round: any;
beforeAll(async () => {
  await loadPromptTemplates();
  const storyData = resolveReplayInputData(fx);
  const approvedArc = resolveReplayArc(storyData, {});
  const storyLogic = resolveReplayStoryLogic(storyData);
  const logic = PB.parseStoryLogic(`STORY LOGIC:\n${storyLogic}`);
  const inputs = BP.planCheckInputs(storyData, { arcPremiseNames: logic.commissioned });
  const b = storyData.beatsReviewReport;
  round = b.discardedRounds[0];
  const castTable = parsePlanCastBlock(b.plannerReply, { listed: commissionedCast(storyData).listed });
  const gl = { info() {}, warn() {}, error() {}, debug() {} };
  runCheck = BP.createPlanCheckRunner({
    inputData: storyData, approvedArc, arcHints: resolveReplayArcHints(storyData), arcStoryLogic: storyLogic,
    arcCentralFigure: resolveReplayCentralFigure(storyData), castTable, commission: inputs.commission,
    commissionedNames: inputs.commissionedNames, placeNames: inputs.placeNames, maxCast: inputs.maxCast,
    arcInventedNames: logic.invented, arcInventedLimit: PB.arcInventedAllowance(storyData),
    mainName: PB.pickMainCharacters(storyData).focus?.name || null, planCheckModel: 'unused', onChunk: null, gl,
  });
  const readPlan = BP.makePlanReader(Array.from({ length: Number(storyData.pages) }, (_, i) => i + 1), approvedArc);
  standing = readPlan(b.plannerReply).parsed.pages;
  const reply = readPlan(round.replanReply).parsed.pages;
  const changed = new Set(round.changedPages.map(Number));
  returned = standing.map(p => (changed.has(Number(p.pageNumber)) ? reply.find((q: any) => q.pageNumber === p.pageNumber) : p));
  given = runCheck.compose(standing, parsedOf(b.checkReply), PB.parsePlanCheck(b.checkReply));
  recheck = runCheck.compose(returned, parsedOf(round.recheck.reply), PB.parsePlanCheck(round.recheck.reply));
});

describe('the stored round, replayed', () => {
  it('composing each check from its stored reply reproduces the stored counter findings', () => {
    // Two counter changes of 2026-10-06 (the planner review) postdate this stored round: one page
    // without a commissioned character is allowed (castCoverage.NO_COMMISSIONED_PAGES_MAX), so a
    // stored finding naming a single page no longer fires; and PLAN_INSTANT_TOO_LONG is new and
    // counts the long instants of a book planned before the budget. Everything else is unchanged.
    const stored = (lines: string[]) => lines
      .filter(l => !/^PLAN\[NO_COMMISSIONED_ON_PAGE\] page \d+:/.test(l))
      .map(l => (l.match(/^PLAN\[([A-Z_]+)\]/) || [])[1]).sort();
    const nowCodes = (c: any) => codes(c).filter((x: string) => x !== 'PLAN_INSTANT_TOO_LONG');
    expect(nowCodes(given)).toEqual(stored(fx.beatsReviewReport.counterFindings));
    expect(nowCodes(recheck)).toEqual(stored(round.recheck.counterFindings));
  });

  it('the whole round regresses 5 → 7 (6 → 8 before one commissioned-free page was allowed), and the guard discards it', () => {
    const v = PB.replanRoundRegressed(given, recheck, round.changedPages, { round: 1 });
    // 6 → 8 when stored; the one page without a commissioned character is now allowed, so 5 → 7.
    expect([v.before, v.after, v.discard]).toEqual([5, 7, true]);
    expect(whoOf(returned, 4)).toMatch(/Levin/);
    expect(whoOf(returned, 7)).toMatch(/Levin/);
  });
});

describe('salvage: put back the fewest pages, keep the rest', () => {
  it('p4 and p7 keep Levin, and the book is back within its group budget', () => {
    const s = salvageReplanRound({ standing, returned, changedPages: round.changedPages, given, recheck, compose: runCheck.compose, round: 1 });
    expect(s).not.toBeNull();
    expect(s!.kept).toEqual(expect.arrayContaining([4, 7]));
    expect(whoOf(s!.pages, 4)).toMatch(/Levin/);
    expect(whoOf(s!.pages, 7)).toMatch(/Levin/);
    const gp = s!.check.counters.stats.groupPages;
    expect(gp.pages.length).toBeLessThanOrEqual(gp.budget);
    expect(codes(s!.check)).not.toContain('GROUP_PAGES_OVER_BUDGET');
    expect(s!.verdict.discard).toBe(false);
    expect(s!.verdict.after).toBeLessThanOrEqual(s!.verdict.before);
    // Every page is either the round's line or the standing line, never a new one.
    s!.pages.forEach((p: any, i: number) => expect([standing[i].planLine, returned[i].planLine]).toContain(p.planLine));
    // eslint-disable-next-line no-console
    console.log(`salvage: put back ${s!.reverted.join(',')}; kept ${s!.kept.join(',')}; cast/focal must-fix ${s!.verdict.before} -> ${s!.verdict.after}; group pages ${gp.pages.join(',')} (budget ${gp.budget})`);
  });

  it('a round that does not regress is left alone', () => {
    expect(salvageReplanRound({ standing, returned: standing, changedPages: [], given, recheck: given, compose: runCheck.compose, round: 1 })).toBeNull();
  });

  it('a runner without compose, or a check without parsed facts, salvages nothing', () => {
    expect(salvageReplanRound({ standing, returned, changedPages: round.changedPages, given, recheck, compose: undefined as any, round: 1 })).toBeNull();
    expect(salvageReplanRound({ standing, returned, changedPages: round.changedPages, given: { ...given, parsed: undefined }, recheck, compose: runCheck.compose, round: 1 })).toBeNull();
  });
});

describe('the round loop wiring', () => {
  const SRC = req('node:fs').readFileSync(req('node:path').join(__dirname, '../../server/lib/beatsPipeline.js'), 'utf8');
  it('salvages before it discards, and the salvaged division gets a real plan check and the same guard', () => {
    const salvageAt = SRC.indexOf('salvageReplanRound({ standing: bestBeats, returned: beats');
    const recheckAt = SRC.indexOf("runCheck(`plan_recheck_salvage_r${round}`, salvage.pages, salvagedPlan)");
    const guardAt = SRC.indexOf('replanRoundRegressed(pendingCheck, check3, salvage.kept, { round })');
    const discardAt = SRC.indexOf("gl.warn('beats_replan_discarded'");
    expect(salvageAt).toBeGreaterThan(0);
    expect(recheckAt).toBeGreaterThan(salvageAt);
    expect(guardAt).toBeGreaterThan(recheckAt);
    expect(discardAt).toBeGreaterThan(guardAt);
  });
});

describe('compositeCheckInputs: each page\'s facts come from the check that judged its line', () => {
  it('a put-back page reads the given check; the rest read the recheck', () => {
    const changed = new Set(round.changedPages.map(Number));
    const { parsed, modelFindings } = compositeCheckInputs({ given, recheck, reverted: new Set([12]), changed });
    expect(parsed.roster.get(12)).toEqual(given.parsed.roster.get(12));
    expect(parsed.roster.get(4)).toEqual(recheck.parsed.roster.get(4));
    const pagesOf = (f: any) => PB.findingPages({ line: `CHECK[${f.check}]: ${f.text}` });
    for (const f of modelFindings) {
      const fromRecheck = recheck.modelFindings.includes(f);
      if (fromRecheck) expect(pagesOf(f)).not.toContain(12);
      else expect(pagesOf(f)).toContain(12);
    }
  });
});
