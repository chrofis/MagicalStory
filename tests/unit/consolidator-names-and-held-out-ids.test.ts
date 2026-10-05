/**
 * Two stored-plan contracts the consolidator did not hold (staging
 * job_1791222889407_ypl33vk8u, verify entry grouped-face-fix-clothing FAILED):
 *
 * 1. A grouped face fix reached the stored plan as "Emma: remove angry
 *    expression, ...; Noah: remove ..." — rules 3 and 8b of the template ask for
 *    clothing, never names, and the model did not comply. scene_fix.instruction
 *    now leaves consolidateFeedback name-free through the page's repair name map.
 * 2. The two code-appended identity_swap rows (p14 Hans, the initial page Emma)
 *    were the only rows of a stored plan with no `ids`. They now carry a
 *    held-out id (H<n>), which the model's own numbering can never produce.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';

const require_ = createRequire(import.meta.url);

const textModels = require_('../../server/lib/textModels');
let modelReply = '';
const realCall = textModels.callTextModel;
textModels.callTextModel = async () => ({ text: modelReply, usage: {} });

const FC = require_('../../server/lib/feedbackConsolidator.js');
const { loadPromptTemplates } = require_('../../server/services/prompts.js');
const { buildRepairNameMap } = require_('../../server/lib/repairLogic.js');

afterAll(() => { textModels.callTextModel = realCall; });

const CHARACTERS = [
  { name: 'Emma', age: 5, gender: 'female' },
  { name: 'Noah', age: 7, gender: 'male' },
];
const QUALITY = [
  { type: 'emotion', severity: 'MINOR', character: 'Emma', description: "Emma's face reads angry instead of afraid" },
  { type: 'emotion', severity: 'MINOR', character: 'Noah', description: "Noah's face reads angry instead of afraid" },
];

const groupedPlan = (instruction: string) => JSON.stringify({
  spec_conflicts: [], per_character_fixes: [],
  scene_fix: { severity: 'MINOR', types: ['emotion'], ids: ['Q1', 'Q2'], instruction, requires_regeneration: false, preserve: [] },
  dropped_issues: [],
  deduped_issues: [
    { type: 'emotion', character: 'Emma', description: 'angry', ids: ['Q1'] },
    { type: 'emotion', character: 'Noah', description: 'angry', ids: ['Q2'] },
  ],
});

describe('scene_fix.instruction leaves the consolidator name-free', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  const run = (repairNames: any) => FC.consolidateFeedback({
    evaluation: { judgedPrompt: 'Emma and Noah stand in the water.', fixableIssues: QUALITY },
    pageNumber: 4, characters: CHARACTERS, repairNames,
  });

  it('the p4 shape: "Emma: ...; Noah: ..." becomes one descriptor clause per face, remove and show kept', async () => {
    modelReply = groupedPlan('Emma: remove angry expression, show wide fearful eyes and clamped mouth; Noah: remove angry expression, show wide fearful eyes and clamped mouth.');
    const names = buildRepairNameMap({ characters: CHARACTERS });
    const { plan, error } = await run(names);
    expect(error).toBeNull();
    const ins = plan.scene_fix.instruction;
    expect(ins).not.toMatch(/\bEmma\b|\bNoah\b/);
    const clauses = ins.split(/;\s*/);
    expect(clauses).toHaveLength(2);
    for (const c of clauses) expect(c).toMatch(/remove/i), expect(c).toMatch(/show/i);
    expect(clauses[0]).toContain('5-year-old girl');
    expect(clauses[1]).toContain('7-year-old boy');
  });

  it('an instruction already free of names is left as written', async () => {
    const text = 'The child in the red jacket: remove the smile, show wide sad eyes.';
    modelReply = groupedPlan(text);
    const { plan } = await run(buildRepairNameMap({ characters: CHARACTERS }));
    expect(plan.scene_fix.instruction).toBe(text);
  });

  it('with no name map the instruction is left as the model wrote it (inpaintPage strips at send time)', async () => {
    modelReply = groupedPlan('Emma: remove angry expression, show wide fearful eyes.');
    const { plan } = await run(null);
    expect(plan.scene_fix.instruction).toContain('Emma');
  });

  it('the repair pipeline hands the consolidator the page map', () => {
    const { consolidationInputs } = require_('../../server/lib/repairPipeline.js');
    const inputs = consolidationInputs({
      ev: { bboxDetection: { figures: [] } }, entityIssues: [], orig: { sceneDescription: '' },
      pageNumber: 4, round: 0, storyData: { characters: CHARACTERS, artStyle: 'pixar' }, characters: CHARACTERS,
      artStyle: 'pixar', visualBible: null, storyId: 's',
    });
    expect(inputs.repairNames.names).toEqual(expect.arrayContaining(['Emma', 'Noah']));
  });
});

describe('a code-appended identity swap carries a held-out id', () => {
  const swap = (name: string) => ({ name, characterName: name, type: 'identity_swap', subType: 'identity_swap', severity: 'CRITICAL', description: `${name} reads as another person`, sources: ['entity'] });

  it('identitySwapEntries numbers its rows H1, H2 — never an input id', () => {
    const rows = FC.identitySwapEntries([swap('Hans'), swap('Emma')]);
    expect(rows.map((r: any) => r.ids)).toEqual([['H1'], ['H2']]);
  });

  it('appendIdentitySwaps continues the plan numbering and skips a character already charged', () => {
    const plan: any = { deduped_issues: [{ type: 'clothing', character: 'Emma', description: 'x', ids: ['S1'] }] };
    expect(FC.appendIdentitySwaps(plan, [swap('Hans')], 14)).toBe(1);
    expect(FC.appendIdentitySwaps(plan, [swap('Hans'), swap('Emma')], 14)).toBe(1);
    expect(plan.deduped_issues.map((d: any) => d.ids)).toEqual([['S1'], ['H1'], ['H2']]);
  });

  it('every row of a plan that held a swap out names an id (the stored p14 shape)', async () => {
    await loadPromptTemplates();
    modelReply = JSON.stringify({
      spec_conflicts: [], per_character_fixes: [], scene_fix: { severity: 'NONE', types: [], instruction: '', requires_regeneration: false, preserve: [] },
      dropped_issues: [], deduped_issues: [{ type: 'clothing', character: 'Emma', description: 'one-piece has no sleeves', ids: ['E1'] }],
    });
    const { plan } = await FC.consolidateFeedback({
      evaluation: { judgedPrompt: 'Hans and Emma.' }, pageNumber: 14, characters: CHARACTERS,
      entityIssues: [
        { name: 'Emma', type: 'clothing_inconsistent', subType: 'clothing_inconsistent', severity: 'MAJOR', description: 'one-piece has no sleeves' },
        swap('Hans'),
      ],
    });
    expect(plan.deduped_issues).toHaveLength(2);
    for (const d of plan.deduped_issues) expect(d.ids?.length).toBeGreaterThan(0);
    expect(plan.deduped_issues.find((d: any) => d.type === 'identity_swap').ids).toEqual(['H1']);
  });
});
