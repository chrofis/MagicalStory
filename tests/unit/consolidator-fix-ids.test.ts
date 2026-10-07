/**
 * EVERY CRITICAL/MAJOR FIX NAMES THE FINDINGS IT FIXES, AND ONE OF THEM IS SCORED
 * (owner, 2026-10-04).
 *
 * Staging job_1791040103540_atbttop6w p17 (consolidator_calls 2971): the page's
 * only finding (semantic CRITICAL, the creature stays inside the canopy instead
 * of rising out) was dropped as finding_contradicts_brief, so it left the
 * scoring list — and the plan still carried a CRITICAL scene_fix for it. The
 * page scored 100 and was never repaired. The plan shape had no link from a fix
 * to a finding; fixes now carry `ids`, and a CRITICAL/MAJOR fix whose ids are not
 * in any kept deduped entry is logged at ERROR and recorded on `plan.fix_errors`.
 * The check never reclassifies: the score is what the kept list says.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';

const require_ = createRequire(import.meta.url);

const textModels = require_('../../server/lib/textModels');
let modelReply = '';
const realCall = textModels.callTextModel;
textModels.callTextModel = async () => ({ text: modelReply, usage: {} });

const FC = require_('../../server/lib/feedbackConsolidator.js');
const { loadPromptTemplates, PROMPT_TEMPLATES } = require_('../../server/services/prompts.js');
const { sumDeductionPoints, composeDeductions } = require_('../../server/lib/scoring.js');
const { GenerationLogger, setCurrentLogger, clearCurrentLogger } = require_('../../server/lib/generationLogger.js');

afterAll(() => { textModels.callTextModel = realCall; });

const SEMANTIC = [
  { type: 'action_interaction', severity: 'CRITICAL', description: 'The creature is still within the canopy instead of rising out of it.' },
  { type: 'emotion', severity: 'MINOR', description: 'The face reads calm, not afraid.' },
];
const index = () => FC.indexFindings({ semanticIssues: SEMANTIC });

const sceneFix = (over: any = {}) => ({
  severity: 'CRITICAL', types: ['action_interaction'], ids: ['S1'],
  instruction: 'Move the creature above the canopy.', requires_regeneration: true, preserve: [], ...over,
});

describe('checkFixesRestOnKeptFindings', () => {
  it('flags a CRITICAL scene_fix whose only finding was dropped as finding_contradicts_brief (the p17 shape)', () => {
    const plan: any = {
      scene_fix: sceneFix(),
      per_character_fixes: [],
      dropped_issues: [{ issue: 'x', reason: 'finding_contradicts_brief', ids: ['S1'] }],
      deduped_issues: [], // resolveDedupedIssues removed the entry whose ids were all dropped
    };
    const errors = FC.checkFixesRestOnKeptFindings(plan, index(), 17);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('scene_fix CRITICAL');
    expect(errors[0]).toContain('all dropped as not a defect');
  });

  it('writes the error to the generation log at level error', () => {
    const genLog = new GenerationLogger();
    setCurrentLogger(genLog);
    try {
      FC.checkFixesRestOnKeptFindings({
        scene_fix: sceneFix(), per_character_fixes: [], dropped_issues: [{ reason: 'finding_contradicts_brief', ids: ['S1'] }], deduped_issues: [],
      }, index(), 17);
    } finally { clearCurrentLogger(); }
    const e = genLog.entries.filter((x: any) => x.event === 'consolidator_fix_unbacked');
    expect(e).toHaveLength(1);
    expect(e[0].level).toBe('error');
    expect(e[0].details).toMatchObject({ pageNumber: 17, fix: 'scene_fix', severity: 'CRITICAL', ids: ['S1'] });
  });

  it('is silent when one of the fix ids is in a kept entry', () => {
    const plan: any = {
      scene_fix: sceneFix(),
      per_character_fixes: [],
      dropped_issues: [{ reason: 'finding_contradicts_brief', ids: ['S2'] }],
      deduped_issues: [{ description: 'd', severity: 'CRITICAL', ids: ['S1'] }],
    };
    expect(FC.checkFixesRestOnKeptFindings(plan, index(), 17)).toEqual([]);
  });

  it('flags a fix with no ids, an unknown id, and a per-character fix on a dropped finding', () => {
    const plan: any = {
      scene_fix: sceneFix({ ids: undefined }),
      per_character_fixes: [
        { characterName: 'A', severity: 'MAJOR', ids: ['S9'], fix_instruction: 'Turn the head left.' },
        { characterName: 'B', severity: 'MAJOR', ids: ['S2'], fix_instruction: 'Open the eyes wide.' },
      ],
      dropped_issues: [{ reason: 'finding_contradicts_brief', ids: ['S2'] }],
      deduped_issues: [{ description: 'd', severity: 'CRITICAL', ids: ['S1'] }],
    };
    const errors = FC.checkFixesRestOnKeptFindings(plan, index(), 3);
    expect(errors).toHaveLength(3);
    expect(errors[0]).toContain('names no finding id');
    expect(errors[1]).toContain('unknown id(s) S9');
    expect(errors[2]).toContain('all dropped as not a defect');
  });

  it('flags a fix whose findings are in no scored entry and no not-a-defect drop (capped / unaccounted)', () => {
    const plan: any = {
      scene_fix: sceneFix(), per_character_fixes: [], dropped_issues: [], deduped_issues: [{ description: 'd', severity: 'MINOR', ids: ['S2'] }],
    };
    const errors = FC.checkFixesRestOnKeptFindings(plan, index(), 3);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('none in a scored entry');
  });

  it('ignores MODERATE/MINOR fixes, empty instructions and an empty plan', () => {
    const plan: any = {
      scene_fix: sceneFix({ severity: 'MODERATE', ids: undefined }),
      per_character_fixes: [{ characterName: 'A', severity: 'CRITICAL', fix_instruction: '' }],
      dropped_issues: [], deduped_issues: [],
    };
    expect(FC.checkFixesRestOnKeptFindings(plan, index(), 3)).toEqual([]);
    expect(FC.checkFixesRestOnKeptFindings({}, index(), 3)).toEqual([]);
  });
});

describe('consolidateFeedback — the p17 reply', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('records fix_errors, keeps the score untouched (100: nothing reclassified in code)', async () => {
    modelReply = JSON.stringify({
      spec_conflicts: [], per_character_fixes: [],
      scene_fix: sceneFix(),
      dropped_issues: [{ issue: 'wings do not convey flight', reason: 'finding_contradicts_brief', ids: ['S1'], type: 'action_interaction', character: 'Hero' }],
      deduped_issues: [{ type: 'action_interaction', character: 'Hero', description: 'still within the canopy', ids: ['S1'] }],
    });
    const { plan, error } = await FC.consolidateFeedback({
      evaluation: { judgedPrompt: 'The hero rises out of the canopy.', semanticResult: { semanticIssues: [SEMANTIC[0]] } },
      pageNumber: 17,
    });
    expect(error).toBeNull();
    expect(plan.deduped_issues).toEqual([]);
    expect(plan.fix_errors).toHaveLength(1);
    expect(100 - sumDeductionPoints(composeDeductions({ consolidated: plan.deduped_issues }))).toBe(100);
  });

  it('records no fix_errors when the fix rests on a kept finding', async () => {
    modelReply = JSON.stringify({
      spec_conflicts: [], per_character_fixes: [], scene_fix: sceneFix(), dropped_issues: [],
      deduped_issues: [{ type: 'action_interaction', character: 'Hero', description: 'still within the canopy', ids: ['S1'] }],
    });
    const { plan } = await FC.consolidateFeedback({
      evaluation: { judgedPrompt: 'The hero rises out of the canopy.', semanticResult: { semanticIssues: [SEMANTIC[0]] } },
      pageNumber: 17,
    });
    expect(plan.fix_errors).toBeUndefined();
    expect(plan.deduped_issues[0].severity).toBe('CRITICAL');
  });
});

describe('prompt contract', () => {
  beforeAll(async () => { await loadPromptTemplates(); });
  it('asks every fix for ids and shows them in the output example', () => {
    const t: string = PROMPT_TEMPLATES.feedbackConsolidator;
    expect(t).toContain('Every fix carries `ids`');
    expect(t.match(/"ids": \["[A-Z]\d"/g)!.length).toBeGreaterThanOrEqual(5);
  });
});
