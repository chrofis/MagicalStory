/**
 * THE CONSOLIDATOR CITES FINDINGS BY ID; CODE READS THE VOTES OFF THE IDS
 * (owner, 2026-10-04 — replaces the 2026-09-24 vote clamp and the 2026-09-23
 * type+character drop match).
 *
 * Staging job_1791040103540_atbttop6w p12 (consolidator_calls 2983 / 2996):
 *   - the model credited the semantic MAJOR "Kiaan wears the jacket the brief
 *     takes off" to `quality`, the clamp held it to quality's page maximum
 *     (MINOR) and it was billed MINOR;
 *   - it dropped the reader finding "Kiaan is shown standing" as
 *     finding_contradicts_brief, and the type+character guard also deleted the
 *     semantic MAJOR "the egg is not wrapped in the jacket" (action_interaction
 *     /Kiaan too), which nothing dropped.
 * The page scored 83 and was never repaired. Pinned here: each input finding is
 * shown with an id; an entry's sources, votes and severity come from the input
 * findings its ids name; a not-a-defect drop removes exactly its ids; an unknown
 * or missing id is an error and is not applied.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';

const require_ = createRequire(import.meta.url);

// feedbackConsolidator destructures callTextModel at load: stub first.
const textModels = require_('../../server/lib/textModels');
let modelReply = '';
let modelInput = '';
const realCall = textModels.callTextModel;
textModels.callTextModel = async (input: string) => { modelInput = input; return { text: modelReply, usage: {} }; };

const FC = require_('../../server/lib/feedbackConsolidator.js');
const { loadPromptTemplates } = require_('../../server/services/prompts.js');
const { sumDeductionPoints, composeDeductions } = require_('../../server/lib/scoring.js');

afterAll(() => { textModels.callTextModel = realCall; });

// The p12 inputs as the consolidator was shown them (round 1).
const QUALITY = [
  { type: 'emotion', severity: 'MINOR', description: 'Julian is declared afraid, but the face reads sad.' },
  { type: 'emotion', severity: 'MINOR', description: 'Kiaan is declared sad, but the face reads surprised.' },
];
const SEMANTIC = [
  { type: 'clothing', severity: 'MAJOR', description: 'Kiaan is wearing the purple quilted autumn jacket the prompt takes off.' },
  { type: 'action_interaction', severity: 'MAJOR', description: 'Kiaan holds the egg, but it is not wrapped in the jacket.' },
  { type: 'action_interaction', severity: 'MODERATE', description: "Julian's eyes are squeezed shut, contradicting 'Julian looks at the egg'." },
];
const READER = [
  { severity: 'MAJOR', type: 'action_interaction', line: 'FAULT[IMG][MAJOR][action_interaction]: p12 — Kiaan is shown standing, but the text states he is cowering.' },
  { severity: 'MAJOR', type: 'setting', line: 'FAULT[IMG][MAJOR][setting]: p12 — Herr Keller is shown in the background.' },
];
const index = () => FC.indexFindings({ fixableIssues: QUALITY, semanticIssues: SEMANTIC, readerFindings: READER });

describe('indexFindings + buildFeedbackInput — one numbering', () => {
  it('numbers each section with its own prefix and shows the same ids in the input', () => {
    const idx = index();
    expect([...idx.keys()]).toEqual(['Q1', 'Q2', 'S1', 'S2', 'S3', 'R1', 'R2']);
    expect(idx.get('S1')).toMatchObject({ source: 'semantic', severity: 'MAJOR' });
    const input = FC.buildFeedbackInput({ sceneDescription: 's', fixableIssues: QUALITY, semanticIssues: SEMANTIC, readerFindings: READER });
    for (const id of idx.keys()) expect(input).toContain(`- ${id} [`);
    expect(input).toContain('- R1 [MAJOR] (action_interaction) FAULT[IMG]');
  });
  it('a reader finding with no text is neither shown nor numbered', () => {
    const idx = FC.indexFindings({ readerFindings: [{ severity: 'MAJOR', line: '  ' }, READER[0]] });
    expect([...idx.keys()]).toEqual(['R1']);
    expect(idx.get('R1').finding).toBe(READER[0]);
  });
});

describe('resolveDedupedIssues — votes come from the input findings', () => {
  it('REGRESSION p12: a semantic MAJOR keeps MAJOR — there is no transcribed source to mis-credit', () => {
    const plan = { deduped_issues: [{ type: 'clothing', character: 'Kiaan', description: 'jacket worn', ids: ['S1'],
      // what the model used to write, now ignored
      sources: ['quality'], severities: { quality: 'MAJOR' } }], dropped_issues: [] };
    const { deduped, errors } = FC.resolveDedupedIssues(plan, index(), 12);
    expect(errors).toEqual([]);
    expect(deduped).toEqual([expect.objectContaining({ type: 'clothing', severity: 'MAJOR', sources: ['semantic'], severities: { semantic: 'MAJOR' }, ids: ['S1'] })]);
  });
  it('merged ids: one vote per source (its highest), then the median; a CRITICAL still wins', () => {
    const idx = FC.indexFindings({ fixableIssues: [{ severity: 'MINOR', description: 'a' }, { severity: 'MODERATE', description: 'b' }], semanticIssues: [{ severity: 'MAJOR', description: 'c' }], complianceIssues: [{ severity: 'CRITICAL', description: 'd' }] });
    const r = FC.resolveDedupedIssues({ deduped_issues: [
      { type: 'x', description: 'two sources', ids: ['Q1', 'Q2', 'S1'] },
      { type: 'y', description: 'critical wins', ids: ['S1', 'C1'] },
    ] }, idx, 1);
    expect(r.deduped[0]).toMatchObject({ severities: { quality: 'MODERATE', semantic: 'MAJOR' }, severity: 'MODERATE', sources: ['quality', 'semantic'] });
    expect(r.deduped[1]).toMatchObject({ severity: 'CRITICAL' });
  });
  it('REGRESSION p12: a not-a-defect drop removes only its own id, never another finding on the same type+character', () => {
    const plan = {
      deduped_issues: [
        { type: 'action_interaction', character: 'Kiaan', description: 'egg not wrapped', ids: ['S2'] },
        { type: 'action_interaction', character: 'Kiaan', description: 'shown standing', ids: ['R1'] },
      ],
      dropped_issues: [{ issue: 'Kiaan standing', reason: 'finding_contradicts_brief', ids: ['R1'], type: 'action_interaction', character: 'Kiaan' }],
    };
    const { deduped, removedByDrops } = FC.resolveDedupedIssues(plan, index(), 12);
    expect(removedByDrops).toBe(1);
    expect(deduped.map((d: any) => d.description)).toEqual(['egg not wrapped']);
    expect(deduped[0]).toMatchObject({ severity: 'MAJOR', sources: ['semantic'] });
  });
  it('a dropped id leaves an entry that merges it with a live finding; the votes are recomputed without it', () => {
    const plan = {
      deduped_issues: [{ type: 'action_interaction', character: 'Kiaan', description: 'merged', ids: ['S2', 'R1'] }],
      dropped_issues: [{ reason: 'finding_contradicts_brief', ids: ['S2'] }],
    };
    const { deduped } = FC.resolveDedupedIssues(plan, index(), 12);
    expect(deduped).toEqual([expect.objectContaining({ ids: ['R1'], sources: ['reader'], severity: 'MAJOR' })]);
  });
  it('REGRESSION: profile_says_trait_is_correct is refused for a missing_element finding (2026-10-07)', () => {
    const idx = FC.indexFindings({ semanticIssues: [{ type: 'missing_element', severity: 'MAJOR', description: 'the lantern is absent' }] });
    const plan = {
      deduped_issues: [{ type: 'missing_element', description: 'lantern absent', ids: ['S1'] }],
      dropped_issues: [{ reason: 'profile_says_trait_is_correct', ids: ['S1'] }],
    };
    const { deduped, errors, removedByDrops } = FC.resolveDedupedIssues(plan, idx, 4);
    expect(removedByDrops).toBe(0);
    expect(errors.length).toBe(1);
    expect(deduped).toEqual([expect.objectContaining({ ids: ['S1'], severity: 'MAJOR' })]);
  });
  it('profile_says_trait_is_correct still drops a hair finding', () => {
    const idx = FC.indexFindings({ fixableIssues: [{ type: 'hair', severity: 'MAJOR', description: 'wrong hair' }] });
    const plan = {
      deduped_issues: [{ type: 'hair', description: 'wrong hair', ids: ['Q1'] }],
      dropped_issues: [{ reason: 'profile_says_trait_is_correct', ids: ['Q1'] }],
    };
    expect(FC.resolveDedupedIssues(plan, idx, 4).removedByDrops).toBe(1);
  });
  it('NEGATIVE CONTROL: a plan-only drop (capped at 3) removes nothing', () => {
    const plan = {
      deduped_issues: [{ type: 'emotion', character: 'Julian', description: 'face', ids: ['Q1'] }],
      dropped_issues: [{ reason: 'capped at 3, defer to next round', ids: ['Q1'] }],
    };
    expect(FC.resolveDedupedIssues(plan, index(), 12).deduped).toHaveLength(1);
  });
  it('an unknown or missing id is an error and the entry is not applied', () => {
    const plan = { deduped_issues: [
      { type: 'clothing', description: 'unknown id', ids: ['S9'] },
      { type: 'clothing', description: 'no ids', sources: ['semantic'], severities: { semantic: 'MAJOR' }, severity: 'MAJOR' },
      { type: 'clothing', description: 'one bad of two', ids: ['S1', 'Q7'] },
      { type: 'emotion', description: 'good', ids: ['q1'] },
    ] };
    const r = FC.resolveDedupedIssues(plan, index(), 12);
    expect(r.deduped.map((d: any) => d.description)).toEqual(['good']);
    expect(r.errors).toHaveLength(3);
  });
  it('a not-a-defect drop with an unknown or no id removes nothing and is an error', () => {
    const plan = {
      deduped_issues: [{ type: 'action_interaction', character: 'Kiaan', description: 'egg not wrapped', ids: ['S2'] }],
      dropped_issues: [
        { reason: 'finding_contradicts_brief', type: 'action_interaction', character: 'Kiaan' },
        { reason: 'finding_contradicts_brief', ids: ['R9'] },
      ],
    };
    const r = FC.resolveDedupedIssues(plan, index(), 12);
    expect(r.deduped).toHaveLength(1);
    expect(r.errors).toHaveLength(2);
  });
});

describe('consolidateFeedback end to end on the stored p12 shape', () => {
  beforeAll(async () => { await loadPromptTemplates(); });
  it('scores 65 (was 83) — the jacket and the unwrapped egg are both billed MAJOR, Julian at the MODERATE the judge gave', async () => {
    modelReply = JSON.stringify({
      spec_conflicts: [], per_character_fixes: [], scene_fix: { severity: 'NONE', types: [], instruction: '', requires_regeneration: false, preserve: [] },
      dropped_issues: [
        { issue: 'Julian afraid vs sad', reason: 'profile_says_trait_is_correct', ids: ['Q1'], type: 'emotion', character: 'Julian' },
        { issue: 'Kiaan sad vs surprised', reason: 'profile_says_trait_is_correct', ids: ['Q2'], type: 'emotion', character: 'Kiaan' },
        { issue: 'Kiaan standing', reason: 'finding_contradicts_brief', ids: ['R1'], type: 'action_interaction', character: 'Kiaan' },
        { issue: 'Herr Keller background', reason: 'finding_contradicts_brief', ids: ['R2'], type: 'setting', character: 'Herr Keller' },
      ],
      deduped_issues: [
        { type: 'clothing', character: 'Kiaan', description: 'jacket worn', ids: ['S1'], sources: ['quality'], severities: { quality: 'MAJOR' } },
        { type: 'action_interaction', character: 'Julian', description: 'eyes shut', ids: ['S3'] },
        { type: 'action_interaction', character: 'Kiaan', description: 'egg not wrapped', ids: ['S2'] },
        { type: 'action_interaction', character: 'Kiaan', description: 'shown standing', ids: ['R1'] },
        { type: 'setting', character: 'Herr Keller', description: 'background', ids: ['R2'] },
      ],
    });
    const { plan, error } = await FC.consolidateFeedback({
      evaluation: { judgedPrompt: 'Kiaan holds the jacket-wrapped egg.', fixableIssues: QUALITY, semanticResult: { semanticIssues: SEMANTIC } },
      readerFindings: READER, pageNumber: 12,
    });
    expect(error).toBeNull();
    expect(modelInput).toContain('- S1 [MAJOR] (clothing)');
    expect(plan.deduped_issues.map((d: any) => `${d.type}/${d.character}/${d.severity}`)).toEqual([
      'clothing/Kiaan/MAJOR', 'action_interaction/Julian/MODERATE', 'action_interaction/Kiaan/MAJOR',
    ]);
    // The stored run billed Julian's semantic MODERATE as MAJOR (the model
    // transcribed {"semantic":"MAJOR"}); the id reads what the judge said.
    // 15 + 5 + 15 = 35 → 65.
    const pts = sumDeductionPoints(composeDeductions({ consolidated: plan.deduped_issues }));
    expect(100 - pts).toBe(65);
  });
});
