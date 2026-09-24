/**
 * The entity grid judge's CLOSED type list (owner, 2026-09-24: "Closed list in
 * the prompt"). The prompt is filled from evalBuckets.ENTITY_CHECK_TYPES; an
 * off-list type the judge still returns is logged as a parse error, kept on the
 * report as written, and never routed to a repair. No aliases, no bucket moves.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { GoogleGenerativeAI } = require_('@google/generative-ai');
const { ENTITY_CHECK_TYPES, isEntityCheckType, bucketForType } = require_('../../server/lib/evalBuckets.js');
const entity = require_('../../server/lib/entityConsistency.js');
const { decideRepairMethod } = require_('../../server/lib/repairLogic.js');
const { log } = require_('../../server/utils/logger');

let sentPrompt = '';
let reply: unknown = null;
const original = GoogleGenerativeAI.prototype.getGenerativeModel;

beforeAll(async () => {
  await require_('../../server/services/prompts').loadPromptTemplates();
  GoogleGenerativeAI.prototype.getGenerativeModel = () => ({
    generateContent: async (parts: unknown[]) => {
      sentPrompt = String(parts[0]);
      return { response: { text: () => JSON.stringify(reply) } };
    },
  });
});
afterAll(() => { GoogleGenerativeAI.prototype.getGenerativeModel = original; });

const manifest = { cells: [{ letter: 'R', isReference: true, clothing: 'standard' }, { letter: 'A', pageNumber: 3, clothing: 'standard' }] };
const info = { entityType: 'character', entityName: 'Mila', cellCount: 2, clothingCategory: 'standard', expectedClothing: 'a red coat' };

describe('entity judge — closed type list', () => {
  it('the constant is the prompt\'s vocabulary and every value has a bucket', () => {
    for (const t of ENTITY_CHECK_TYPES) expect(bucketForType(t), t).not.toBe('other');
    expect(isEntityCheckType('FACE_MISMATCH')).toBe(true);
    expect(isEntityCheckType('facial_features')).toBe(false);
    expect(isEntityCheckType('body_build')).toBe(true);
    expect(isEntityCheckType('body_build_change')).toBe(false);
  });

  it('the built prompt carries the closed list from the constant, and no unfilled placeholder', async () => {
    reply = { consistent: true, score: 10, fixable_issues: [], clothing_check: [], summary: 'ok' };
    await entity.evaluateEntityConsistency(Buffer.from('x'), manifest, info);
    expect(sentPrompt).toContain(`is exactly one of these values, and nothing else: ${entity.entityIssueTypesForPrompt()}.`);
    for (const t of ENTITY_CHECK_TYPES) expect(sentPrompt).toContain('`' + t + '`');
    expect(sentPrompt).not.toMatch(/\{ENTITY_ISSUE_TYPES\}/);
  });

  it('an off-list type is logged as an error and kept as reported', async () => {
    const spy = vi.spyOn(log, 'error');
    reply = {
      consistent: false, score: 5, clothing_check: [], summary: 'x',
      fixable_issues: [
        { type: 'facial_features', severity: 'CRITICAL', description: 'different features', pagesToFix: [3], cells: ['A'] },
        { type: 'age_shift', severity: 'CRITICAL', description: 'looks older', pagesToFix: [3], cells: ['A'] },
      ],
    };
    const res = await entity.evaluateEntityConsistency(Buffer.from('x'), manifest, info);
    const msgs = spy.mock.calls.map(c => String(c[0]));
    expect(msgs.some(m => m.includes('"facial_features" is not on the closed list'))).toBe(true);
    expect(msgs.some(m => m.includes('"age_shift" is not on the closed list'))).toBe(false);
    expect(res.issues.map((i: { type: string }) => i.type)).toEqual(['facial_features', 'age_shift']);
    spy.mockRestore();
  });

  it('an off-list type is never routed — even one whose word maps to a bucket', () => {
    const evaluation = { scoreBreakdown: { visual: { score: 100 }, semantic: { score: 100 } }, fixableIssues: [], consolidatedPlan: { deduped_issues: [] } };
    const report = (type: string) => ({ characters: { Mila: { issues: [{ type, severity: 'CRITICAL', pagesToFix: [3], description: 'x' }] } } });
    // facial_hair_change normalises to the `hair` bucket; the closed list still refuses it.
    for (const t of ['facial_hair_change', 'body_build_change', 'character_mismatch', 'consistency']) {
      expect(decideRepairMethod(3, evaluation, report(t)).method, t).not.toBe('char-fix');
    }
    expect(decideRepairMethod(3, evaluation, report('age_shift')).method).toBe('char-fix');
  });
});

describe('body_build — a scored entity type (owner, 2026-09-24)', () => {
  const { resolveRepairAxes } = require_('../../server/lib/faceRepair.js');
  const scoring = require_('../../server/lib/scoring.js');

  it('is on the closed list the judge is sent, with its tie-break and severity lines', async () => {
    reply = { consistent: true, score: 10, fixable_issues: [], clothing_check: [], summary: 'ok' };
    await entity.evaluateEntityConsistency(Buffer.from('x'), manifest, info);
    expect(ENTITY_CHECK_TYPES).toContain('body_build');
    expect(sentPrompt).toMatch(/nothing else: [^\n]*`body_build`/);
    expect(sentPrompt).toMatch(/→ `body_build`/);
    expect(sentPrompt).toMatch(/`body_build` is MAJOR/);
  });

  it('routes to a whole-figure repair, never a face patch — alone or beside a face type', () => {
    expect(resolveRepairAxes({ hasFaceBbox: true, issueTypes: ['body_build'] }).faceOnly).toBe(false);
    expect(resolveRepairAxes({ hasFaceBbox: true, issueTypes: ['age_shift', 'body_build'] }).faceOnly).toBe(false);
    const evaluation = { scoreBreakdown: { visual: { score: 100 }, semantic: { score: 100 } }, fixableIssues: [], consolidatedPlan: { deduped_issues: [] } };
    const d = decideRepairMethod(3, evaluation, { characters: { Mila: { issues: [{ type: 'body_build', severity: 'CRITICAL', pagesToFix: [3], description: 'x' }] } } });
    expect(d.method).toBe('char-fix');
    expect(d.repairParams.faceOnly).toBe(false);
  });

  it('scores by its severity on both finding shapes and bills in the per-character build class', () => {
    for (const [sev, pts] of [['MINOR', scoring.SEVERITY_POINTS.minor], ['MAJOR', scoring.SEVERITY_POINTS.major], ['CRITICAL', scoring.SEVERITY_POINTS.critical]] as const) {
      expect(scoring.deductionPoints({ type: 'body_build', severity: sev })).toBe(pts);
      expect(scoring.deductionPoints({ type: 'consistency', subType: 'body_build', severity: sev }, { entity: true })).toBe(pts);
    }
    expect(scoring.deductionClassKey({ type: 'body_build', name: 'Mila' })).toBe('build|mila');
  });
});
