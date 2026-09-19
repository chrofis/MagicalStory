/**
 * THE BLIND PROMPT-COMPLIANCE JUDGE IS OFF (owner, 2026-09-19 — docs/decisions.md
 * "The blind prompt-compliance judge is OFF").
 *
 * The eval misnamed "three-stage" has two halves and only ONE of them is gated:
 *
 *   stage 1  runVisualInventory / image-vision-inventory — the call that SEES
 *            the page. NOT gated. It is launched by evaluateImageQuality itself
 *            and the quality eval's own figure merge consumes it, which then
 *            feeds the empty-inventory score floor in images.js. Gating it
 *            would move scores.
 *   stage 2  evaluateThreeStage / image-prompt-compliance — the judge that
 *            rules on the picture WITHOUT seeing it, from stage 1's text. Gated,
 *            default off. Two finding-by-finding audits against the pixels put
 *            8.6% and then ~11% of its deduction points as defensible (3 keepers
 *            out of 29 on Lab experiment 1333), while producing 64% of all
 *            deduction points and 16 of 24 false findings.
 *
 * This file pins that split, and it pins the thing that makes switching a judge
 * off SAFE rather than merely cheap: a page nobody judged must not read as a
 * page a judge cleared. That is the whole point of notEvaluated.js, and every
 * bucket-shaped consumer downstream (scoring's compliance bucket, the
 * consolidator's prompt section) sees `[]` either way.
 *
 * BEHAVIOUR ONLY. The resolved flag, the env override in both directions, which
 * network calls go out, the structured absence record, and that the other three
 * scoring buckets do not move. No log wording and no prompt wording is pinned —
 * the "did not run" marker is asserted to DIFFER from the clean marker, not to
 * equal any particular sentence.
 */
import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

const ENV_KEY = 'PROMPT_COMPLIANCE_JUDGE';
const ORIGINAL_ENV = process.env[ENV_KEY];

// ── 1. The flag ─────────────────────────────────────────────────────────────

/** Load a fresh MODEL_DEFAULTS as it resolves under `value`. */
async function flagUnder(value: string | undefined): Promise<boolean> {
  vi.resetModules();
  if (value === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = value;
  // @ts-expect-error - JS module without types
  const mod = await import('../../server/config/models.js');
  return mod.MODEL_DEFAULTS.promptComplianceJudge;
}

afterAll(() => {
  if (ORIGINAL_ENV === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = ORIGINAL_ENV;
  vi.resetModules();
});

describe('promptComplianceJudge: the code default is OFF', () => {
  it('resolves false when nothing is set in the environment', async () => {
    // Behaviour is code, only secrets are env vars: an environment that sets
    // nothing must get the owner's default, not a paid blind judge.
    expect(await flagUnder(undefined)).toBe(false);
  });

  it(`${ENV_KEY}=true re-arms it without a deploy`, async () => {
    expect(await flagUnder('true')).toBe(true);
  });

  it('stays off for every other value, including an explicit false and garbage', async () => {
    for (const v of ['false', '', '1', '0', 'yes', 'TRUE', 'on', 'null', 'undefined']) {
      expect(await flagUnder(v), `${ENV_KEY}=${JSON.stringify(v)}`).toBe(false);
    }
  });
});

// ── 2. The call path, with only the network boundary stubbed ────────────────

const { loadPromptTemplates } = require_('../../server/services/prompts.js');
const textModels = require_('../../server/lib/textModels.js');
const { evaluateImageQuality } = require_('../../server/lib/evalPipeline.js');

const realCallTextModel = textModels.callTextModel;
const realFetch = globalThis.fetch;
const ORIGINAL_GEMINI_KEY = process.env.GEMINI_API_KEY;

/** A 1x1 JPEG-shaped data URI — never decoded, only passed through. */
const IMAGE = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEB';

/** Gemini's envelope around whatever text a stub wants the judge to have said. */
function geminiReply(text: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
    }),
    text: async () => text,
  } as any;
}

/** A quality-eval verdict with one finding, in the judge's own output shape. */
const QUALITY_JSON = JSON.stringify({
  score: 70,
  reasoning: 'one garment is the wrong colour',
  figures: [{ id: 1, position: 'center', description: 'a child in a coat' }],
  matches: [{ figure: 1, name: 'Mila', confidence: 0.9 }],
  fixable_issues: [{ description: 'the coat is green, the contract says navy', severity: 'MAJOR', type: 'clothing_mismatch' }],
});

/** The blind inventory's own output shape (stage 1). */
const INVENTORY_JSON = JSON.stringify({
  figures: [{ id: 1, position: 'center', hair: 'brown', clothing: 'a green coat' }],
  interactions: [], objects: [], setting: 'a garden', lettering: [], rendering: {},
});

type Trace = { visionCalls: number; textLabels: string[] };

/**
 * Run the REAL evaluateImageQuality with both network boundaries stubbed, and
 * report what actually went out. Every vision call (quality judge, stage-1
 * inventory) crosses `fetch`; the compliance judge is the only caller of
 * callTextModel on this path.
 */
async function runEval(evalOptions: Record<string, unknown>): Promise<{ result: any; trace: Trace }> {
  const trace: Trace = { visionCalls: 0, textLabels: [] };

  globalThis.fetch = (async (url: any) => {
    trace.visionCalls++;
    // The inventory asks for far less than the quality judge; both are answered
    // with the shape their own parser expects, keyed off the model in the URL
    // only to pick which body to hand back.
    const isInventory = trace.visionCalls > 1 || String(url).includes('inventory');
    return geminiReply(isInventory ? INVENTORY_JSON : QUALITY_JSON);
  }) as any;

  textModels.callTextModel = async (_prompt: string, _max: any, model: string, opts: any) => {
    trace.textLabels.push(String(opts?.usageLabel || 'text'));
    return {
      text: JSON.stringify({ verdict: 'FAIL', fixable_issues: [{ description: 'the scarf is missing', severity: 'MAJOR', type: 'missing_object' }] }),
      usage: { input_tokens: 4000, output_tokens: 300 },
      stop_reason: 'end_turn',
      modelId: model,
      provider: 'mock',
    };
  };

  const result = await evaluateImageQuality(
    IMAGE,
    'A child called Mila stands in a garden wearing a navy coat and a red scarf.',
    [], 'scene', null, 'p1-test', null, 'Mila stands in the garden', null,
    evalOptions
  );
  return { result, trace };
}

beforeAll(async () => {
  await loadPromptTemplates();
  // The stage-1 inventory is key-guarded; a dummy key keeps it on the path so
  // "stage 1 still ran" is actually observable. Nothing is sent anywhere —
  // fetch is stubbed for the whole describe block.
  process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key-not-used';
});

afterEach(() => {
  textModels.callTextModel = realCallTextModel;
  globalThis.fetch = realFetch;
});

afterAll(() => {
  if (ORIGINAL_GEMINI_KEY === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = ORIGINAL_GEMINI_KEY;
});

/** The compliance judge's own usage label — its one call site, its one bucket. */
const COMPLIANCE_LABEL = 'semantic_compliance';
const entryFor = (result: any, dimension: string) =>
  (result?.notEvaluated || []).find((e: any) => e?.dimension === dimension) || null;

describe('with the judge off, the Stage-2 call is NOT MADE', () => {
  it('no compliance model call goes out, and no compliance result comes back', async () => {
    const { result, trace } = await runEval({ complianceJudgeOverride: false });
    // THE COST CHANGE: the call itself, not a discarded result.
    expect(trace.textLabels).not.toContain(COMPLIANCE_LABEL);
    expect(result).toBeTruthy();
    expect(result.threeStageResult ?? null).toBeNull();
    expect(result.threeStageScore ?? null).toBeNull();
  });

  it('the page carries a structured record that the judge did not run', async () => {
    const { result } = await runEval({ complianceJudgeOverride: false });
    const entry = entryFor(result, 'prompt_compliance');
    // Not an empty-but-silent bucket: a machine-stable (dimension, reason) pair
    // an analyst can grep for in stored stories months later.
    expect(entry, 'a disabled judge must leave a notEvaluated entry').toBeTruthy();
    expect(entry.reason).toBe('compliance_judge_disabled');
    expect(typeof entry.detail).toBe('string');
  });

  it('stage 1 still runs — gating stage 2 removes no call that SEES the image', async () => {
    const off = await runEval({ complianceJudgeOverride: false });
    const on = await runEval({ complianceJudgeOverride: true });
    expect(off.trace.visionCalls).toBe(on.trace.visionCalls);
    expect(off.trace.visionCalls).toBeGreaterThan(0);
  });
});

describe('with the judge on, nothing about it changed', () => {
  it('the compliance call goes out and its result comes back', async () => {
    const { result, trace } = await runEval({ complianceJudgeOverride: true });
    expect(trace.textLabels).toContain(COMPLIANCE_LABEL);
    expect(result.threeStageResult).toBeTruthy();
    expect(typeof result.threeStageResult.score).toBe('number');
  });

  it('and no "did not run" record is written for a judge that did run', async () => {
    const { result } = await runEval({ complianceJudgeOverride: true });
    const entry = entryFor(result, 'prompt_compliance');
    expect(entry === null || entry.reason !== 'compliance_judge_disabled').toBe(true);
  });
});

describe('the production default is what an unconfigured caller gets', () => {
  it('a caller passing no override follows MODEL_DEFAULTS.promptComplianceJudge', async () => {
    const { MODEL_DEFAULTS } = require_('../../server/config/models.js');
    const { trace } = await runEval({});
    expect(trace.textLabels.includes(COMPLIANCE_LABEL)).toBe(!!MODEL_DEFAULTS.promptComplianceJudge);
  });
});

// ── 3. Scoring: the other three buckets do not move ─────────────────────────

const scoring = require_('../../server/lib/scoring.js');

/** The same evaluation, once with a compliance verdict and once without. */
function evalResultPair() {
  const quality = { description: 'the coat is green, the contract says navy', severity: 'MAJOR', type: 'clothing_mismatch' };
  const semantic = { description: 'the declared lantern is not visible', severity: 'MAJOR', type: 'missing_object' };
  const compliance = { description: 'the scarf is missing', severity: 'MAJOR', type: 'missing_object' };
  const base = {
    fixableIssues: [quality],
    semanticResult: { semanticIssues: [semantic] },
  };
  return {
    withJudge: { ...base, threeStageResult: { score: 70, fixableIssues: [compliance] } },
    withoutJudge: { ...base, threeStageResult: null },
  };
}

const entityResult = { characters: [{ name: 'Mila', issues: [{ severity: 'MINOR', description: 'hair is lighter than the reference' }] }] };

describe('scoring: switching the judge off removes ONLY the compliance bucket', () => {
  it('quality, semantic and entity deductions are byte-identical either way', () => {
    const { withJudge, withoutJudge } = evalResultPair();
    const a = scoring.composeDeductions({ evalResult: withJudge, entityResult });
    const b = scoring.composeDeductions({ evalResult: withoutJudge, entityResult });
    for (const bucket of ['quality', 'semantic', 'entity'] as const) {
      expect(JSON.stringify(b[bucket]), `${bucket} bucket moved`).toBe(JSON.stringify(a[bucket]));
    }
    // And the compliance bucket is the only thing that emptied.
    expect(a.compliance.length).toBeGreaterThan(0);
    expect(b.compliance.length).toBe(0);
  });

  it('scoreBreakdown.threeStage stays NULL, not a zero-score card', () => {
    // This is the one place the distinction survives into stored data: a reader
    // can tell "never judged" from "judged, found nothing". A `{score: 0/100,
    // issues: []}` card here would erase that forever.
    const { withJudge, withoutJudge } = evalResultPair();
    const off: any = {}; scoring.applyScore(off, { evalResult: withoutJudge, entityResult });
    const on: any = {};  scoring.applyScore(on,  { evalResult: withJudge,    entityResult });
    expect(off.scoreBreakdown.threeStage).toBeNull();
    expect(on.scoreBreakdown.threeStage).toBeTruthy();
    // The other cards are untouched by the judge's absence.
    expect(JSON.stringify(off.scoreBreakdown.visual)).toBe(JSON.stringify(on.scoreBreakdown.visual));
    expect(JSON.stringify(off.scoreBreakdown.entity)).toBe(JSON.stringify(on.scoreBreakdown.entity));
  });
});

// ── 4. The consolidator is not told the judge cleared the page ──────────────

const { buildFeedbackInput } = require_('../../server/lib/feedbackConsolidator.js');

/** The body of the one section headed for the compliance evaluator. */
function complianceSection(input: string): string {
  const lines = input.split('\n');
  const at = lines.findIndex(l => /^##\s.*[Cc]ompliance/.test(l));
  if (at < 0) return '';
  const rest = lines.slice(at + 1);
  const end = rest.findIndex(l => /^##\s/.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n').trim();
}

const CONSOLIDATOR_ARGS = {
  sceneDescription: 'a child in a garden',
  fixableIssues: [],
  semanticIssues: [],
  complianceIssues: [],
  entityIssues: [],
};

describe('consolidator input: a judge that did not run is not reported as clean', () => {
  it('the "did not run" section differs from the "ran and found nothing" section', () => {
    const ran = complianceSection(buildFeedbackInput({ ...CONSOLIDATOR_ARGS, complianceEvaluated: true }));
    const never = complianceSection(buildFeedbackInput({ ...CONSOLIDATOR_ARGS, complianceEvaluated: false }));
    expect(ran).not.toBe('');
    expect(never).not.toBe('');
    // The model that authors the repair plan must be able to tell these apart.
    // What they SAY is the owner's to reword; that they differ is the contract.
    expect(never).not.toBe(ran);
  });

  it('the "did not run" section does not reuse the empty marker the other sections use', () => {
    // Derived, never hard-coded: whatever string a clean section uses is the one
    // a not-run section must not borrow.
    const emptyMarker = complianceSection(buildFeedbackInput({ ...CONSOLIDATOR_ARGS, complianceEvaluated: true }));
    const never = complianceSection(buildFeedbackInput({ ...CONSOLIDATOR_ARGS, complianceEvaluated: false }));
    expect(never.includes(emptyMarker)).toBe(false);
  });

  it('callers that say nothing keep the old behaviour (an evaluator with an opinion)', () => {
    const legacy = complianceSection(buildFeedbackInput({ ...CONSOLIDATOR_ARGS }));
    const explicit = complianceSection(buildFeedbackInput({ ...CONSOLIDATOR_ARGS, complianceEvaluated: true }));
    expect(legacy).toBe(explicit);
  });

  it('real findings still render whatever the flag says', () => {
    const issues = [{ description: 'the scarf is missing', severity: 'MAJOR', type: 'missing_object' }];
    const s = complianceSection(buildFeedbackInput({ ...CONSOLIDATOR_ARGS, complianceIssues: issues, complianceEvaluated: true }));
    expect(s).toContain('the scarf is missing');
  });
});

// ── 5. The Lab sibling ──────────────────────────────────────────────────────

import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const TESTLAB_SRC = fs.readFileSync(path.join(ROOT, 'server/lib/testlab.js'), 'utf8');
const EVALPIPE_SRC = fs.readFileSync(path.join(ROOT, 'server/lib/evalPipeline.js'), 'utf8');

describe('Test Lab vs production: the Lab follows the flag, and can still measure the judge', () => {
  it('the Lab image-eval stage passes an explicit override rather than forcing the judge on', () => {
    // Always-on in the Lab would be exactly the prod/Lab drift the sibling
    // registry exists to catch: the Lab would score against a judge production
    // never consults.
    expect(TESTLAB_SRC).toContain('complianceJudgeOverride');
    expect(TESTLAB_SRC).toContain('params.complianceJudge');
  });

  it('an A/B on the judge\'s own model or template implies the judge', () => {
    // A compliance model/prompt A/B with the judge off measures nothing.
    const at = TESTLAB_SRC.indexOf('complianceJudgeOverride');
    const block = TESTLAB_SRC.slice(at, at + 400);
    expect(block).toContain('params.complianceModel');
    expect(block).toContain('params.compliancePrompt');
  });

  it('there is exactly ONE evaluateThreeStage call site, and it is behind the gate', () => {
    // The gate is only a gate while nothing calls around it.
    const calls = [...EVALPIPE_SRC.matchAll(/^[ \t]*[\w.]*\s*=?\s*(?:await\s+)?evaluateThreeStage\(/gm)];
    expect(calls.length).toBe(1);
    const gateAt = EVALPIPE_SRC.search(/^[ \t]*if \(!complianceJudgeOn\) \{$/m);
    expect(gateAt).toBeGreaterThan(-1);
    expect(calls[0].index!).toBeGreaterThan(gateAt);
  });

  it('stage 1 is launched ABOVE the gate, so it is not gated with stage 2', () => {
    const inventoryAt = EVALPIPE_SRC.indexOf('p1Promise = runVisualInventory(');
    const gateAt = EVALPIPE_SRC.search(/^[ \t]*if \(!complianceJudgeOn\) \{$/m);
    expect(inventoryAt).toBeGreaterThan(-1);
    expect(gateAt).toBeGreaterThan(inventoryAt);
  });
});
