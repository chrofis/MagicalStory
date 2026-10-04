/**
 * Code review 2026-10 area 3 (eval + scoring), batch 8. Each case failed before
 * its fix: a failed judge, a crashed check, or a wrong-shape reply read as a
 * clean pass. Behaviour is pinned; the few source pins are for the 3,000-line
 * evaluateImageQuality, which cannot run without Gemini.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const { GoogleGenerativeAI } = require_('@google/generative-ai');
const entity = require_('../../server/lib/entityConsistency.js');
const { mergeEntityIssues } = require_('../../server/lib/repairPipeline.js');
const { recordSemanticJudgeFailure } = require_('../../server/lib/evalPipeline.js');
const { createNotEvaluatedRecorder } = require_('../../server/lib/notEvaluated.js');
const { decideRepairMethod } = require_('../../server/lib/repairLogic.js');
const root = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

let replies: unknown[] = [];
let calls = 0;
const original = GoogleGenerativeAI.prototype.getGenerativeModel;
beforeAll(async () => {
  await require_('../../server/services/prompts').loadPromptTemplates();
  GoogleGenerativeAI.prototype.getGenerativeModel = () => ({
    generateContent: async () => {
      const r = replies[Math.min(calls, replies.length - 1)];
      calls++;
      return { response: { text: () => JSON.stringify(r) } };
    },
  });
});
afterAll(() => { GoogleGenerativeAI.prototype.getGenerativeModel = original; });

const manifest = { cells: [{ letter: 'R', isReference: true, clothing: 'standard' }, { letter: 'A', pageNumber: 3, clothing: 'standard' }] };
const info = { entityType: 'character', entityName: 'Mila', cellCount: 2, clothingCategory: 'standard', expectedClothing: 'a red coat' };

describe('B5 - a judge reply that is not a verdict fails closed and is retried', () => {
  for (const [label, reply] of [['an empty object', {}], ['an array', []], ['an error object', { error: 'quota' }]] as const) {
    it(`${label} is retried, then evalFailed (never a clean pass)`, async () => {
      replies = [reply]; calls = 0;
      const res = await entity.evaluateEntityConsistency(Buffer.from('x'), manifest, info);
      expect(calls).toBe(3);
      expect(res.evalFailed).toBe(true);
      expect(res.consistent).toBe(false);
    }, 20000);
  }
  it('a real verdict is not retried', async () => {
    replies = [{ consistent: true, score: 9, fixable_issues: [], clothing_check: [], summary: 'ok' }]; calls = 0;
    const res = await entity.evaluateEntityConsistency(Buffer.from('x'), manifest, info);
    expect(calls).toBe(1);
    expect(res.consistent).toBe(true);
    expect(res.evalFailed).toBeUndefined();
  });
});

describe('B1 - a crash of the whole entity check rejects', () => {
  it('runEntityConsistencyChecks does not return a half-built overallConsistent:true report', async () => {
    await expect(entity.runEntityConsistencyChecks(null, [])).rejects.toThrow();
  });
});

describe('B3 - evalFailed survives a round merge', () => {
  const base = { timestamp: 't', totalIssues: 0, overallConsistent: false, characters: { Mila: { issues: [], evalFailed: true, overallConsistent: false } } };
  const fresh = { timestamp: 't2', totalIssues: 0, overallConsistent: true, characters: { Mila: { issues: [], overallConsistent: true } } };
  it('a character whose base check failed to run is not consistent after a zero-issue merge', () => {
    const merged = mergeEntityIssues(base, fresh, [3]);
    expect(merged.characters.Mila.evalFailed).toBe(true);
    expect(merged.characters.Mila.overallConsistent).toBe(false);
    expect(merged.overallConsistent).toBe(false);
  });
  it('a fresh-only failure is carried too', () => {
    const b = { ...base, characters: { Mila: { issues: [], overallConsistent: true } }, overallConsistent: true };
    const f = { ...fresh, characters: { Mila: { issues: [], evalFailed: true } } };
    expect(mergeEntityIssues(b, f, [3]).characters.Mila.overallConsistent).toBe(false);
  });
  it('the grid result and the character record carry the flag (source)', () => {
    const src = read('server/lib/entityConsistency.js');
    expect(src).toMatch(/evalFailed: gridResults\.some\(g => g\.evalResult\.evalFailed\)/);
    expect(src).toMatch(/if \(evalResult\.evalFailed\) report\.characters\[charName\]\.evalFailed = true/);
  });
});

describe('A1 - a failed semantic judge is NOT EVALUATED, not a clean pass', () => {
  it('records semantic_fidelity / judge_failed when the judge returned an error', () => {
    const rec = createNotEvaluatedRecorder({ pageContext: 'p1' });
    recordSemanticJudgeFailure({ score: null, semanticIssues: [], error: 'Failed to parse response' }, rec);
    expect(rec.list()).toEqual([expect.objectContaining({ dimension: 'semantic_fidelity', reason: 'judge_failed' })]);
  });
  it('records nothing for a judge that answered', () => {
    const rec = createNotEvaluatedRecorder({ pageContext: 'p1' });
    recordSemanticJudgeFailure({ score: 100, semanticIssues: [] }, rec);
    recordSemanticJudgeFailure(null, rec);
    expect(rec.list()).toEqual([]);
  });
  it('repairLogic no longer reads a missing semantic score as 100', () => {
    const ev = { scoreBreakdown: { visual: { score: 100 } }, fixableIssues: [], consolidatedPlan: { deduped_issues: [] } };
    const d = decideRepairMethod(ev as any, 1 as any);
    expect(d?.reason || '').not.toMatch(/wrong scene/);
    expect(read('server/lib/repairLogic.js')).not.toMatch(/semanticRead \?\? 100/);
  });
});

describe('source pins for evaluateImageQuality (cannot run without Gemini)', () => {
  const src = read('server/lib/evalPipeline.js');
  it('A2: the Grok fallback verdict is stamped with the model that ran', () => {
    expect(src).toMatch(/data = grokData;[\s\S]{0,400}modelId = grokFallbackId;/);
  });
  it('A3: no cover textIssue regex classification remains', () => {
    expect(src).not.toMatch(/textIssue|TITLE_ERROR|STRAY_TEXT/);
  });
  it('A4: a defect report without fixable_issues is recorded as not evaluated', () => {
    expect(src).toMatch(/fixable_issues_missing/);
  });
  it('A5: side judges launch after the reference-attach refusal and are settled in finally', () => {
    expect(src.indexOf('SIDE JUDGES LAUNCH HERE')).toBeGreaterThan(src.indexOf('refusing to grade identity-blind'));
    expect(src.indexOf('evaluateSemanticFidelity(imageData')).toBeGreaterThan(src.indexOf('refusing to grade identity-blind'));
    expect(src).toMatch(/Promise\.allSettled\(\[p1Promise, semanticPromise, threeStagePromise\]/);
  });
});

describe('B4/B6/B7 - entityConsistency', () => {
  const src = read('server/lib/entityConsistency.js');
  it('B4: a character whose crops all fail to extract is a failed check, not absent', () => {
    expect(src).toMatch(/crop extraction failed \(/);
  });
  it('B6: a detection the fallback already produced is not re-run', () => {
    expect(src).toMatch(/!bboxDetection\.entityFallbackRan/);
    expect(src).toMatch(/detection\.entityFallbackRan = true/);
  });
  it('B7: the never-sent single-page prompt, its fallback builder and template are gone', () => {
    expect(src).not.toMatch(/buildFallbackSinglePagePrompt|entitySinglePageRepair/);
    expect(fs.existsSync(path.join(root, 'prompts/entity-single-page-repair.txt'))).toBe(false);
  });
});
