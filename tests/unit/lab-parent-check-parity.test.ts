/**
 * Lab vs production parity for the PAIRED RE-JUDGE (owner 2026-10-09). Production judges every
 * repair child beside its parent and checks its findings against the parent picture
 * (repairPipeline.attachParentCompare / checkFindingsAgainstParent). The Test Lab's eval, variance
 * and consolidate stages score the same pinned children; they used to skip the check, so a Lab
 * score of a repair child differed from the production one (registry set lab-vs-prod-page-eval).
 * The Lab must call THE SAME two functions, not a copy.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';

// @ts-ignore
const RP = require('../../server/lib/repairPipeline.js');
// @ts-ignore
const { loadPromptTemplates } = require('../../server/services/prompts.js');
// @ts-ignore
const { GoogleGenerativeAI } = require('@google/generative-ai');
// @ts-ignore
const fs = require('fs');
// @ts-ignore
const path = require('path');
const lab: string = fs.readFileSync(path.join(__dirname, '../../server/lib/testlab.js'), 'utf8');

function stageBody(name: string): string {
  const i = lab.indexOf(`async function ${name}(`);
  expect(i).toBeGreaterThan(-1);
  const j = lab.indexOf('\nasync function ', i + 10);
  return lab.slice(i, j === -1 ? undefined : j);
}

describe('the Lab runs production\'s parent check, not a copy', () => {
  it('production exports the two functions the Lab uses', () => {
    expect(typeof RP.attachParentCompare).toBe('function');
    expect(typeof RP.checkFindingsAgainstParent).toBe('function');
  });
  it('the Lab never re-implements the tag call or the compare block', () => {
    expect(lab).not.toContain('tagFindingsSharedWithParent');
    expect(lab).not.toContain('parentFindingsForCompare');
  });
  it.each([
    ['runQualityEvalStage', 'attachParentCompare'],
    ['runSemanticEvalStage', 'attachParentCompare'],
    ['runEvalVarianceStage', 'checkFindingsAgainstParent'],
    ['runConsolidateStage', 'checkFindingsAgainstParent'],
  ])('%s evaluates/consolidates a pinned child through %s', (stage, fn) => {
    const body = stageBody(stage);
    expect(body).toContain('labParentVersion(ctx)');
    expect(body).toContain(fn);
  });
});

describe('the shared pair on a stored repair child', () => {
  beforeAll(async () => { await loadPromptTemplates(); });
  const parent = { imageData: 'data:image/png;base64,AA', deductions: { consolidated: [
    { severity: 'major', type: 'action_interaction', name: 'Levin', description: 'facing viewer' },
  ] } };

  it('attachParentCompare hands the judge the parent picture and its stored findings', () => {
    const input: any = { pageNumber: 18 };
    RP.attachParentCompare(input, parent);
    expect(input.parentCompare.imageData).toBe(parent.imageData);
    expect(input.parentCompare.findings[0]).toMatchObject({ id: 'P1', type: 'action_interaction', character: 'Levin' });
  });

  it('checkFindingsAgainstParent tags a finding the parent shows and records parentCheck', async () => {
    const spy = vi.spyOn(GoogleGenerativeAI.prototype, 'getGenerativeModel').mockReturnValue({
      generateContent: async () => ({ response: { text: () => '{"findings":[{"id":"C1","also_in_parent":true}]}', usageMetadata: {} } }),
    } as any);
    const input: any = { pageNumber: 18 };
    RP.attachParentCompare(input, parent);
    const plan: any = { deduped_issues: [{ type: 'scale', character: 'Julian', severity: 'major', sources: ['compliance'], description: 'same height' }] };
    await RP.checkFindingsAgainstParent({ plan, childImage: 'data:image/png;base64,AA', parentCompare: input.parentCompare, pageNumber: 18, label: 'x' });
    expect(plan.deduped_issues[0].alsoInParent).toBe(true);
    expect(plan.parentCheck).toEqual({ asked: 1, tagged: 1, error: null });
    spy.mockRestore();
  });
});
