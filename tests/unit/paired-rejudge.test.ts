/**
 * THE PAIRED RE-JUDGE (A2, owner 2026-10-07). A repaired version is judged beside its parent; a
 * finding the judge says is also in the parent is the same defect, charged to both versions so it
 * cannot decide the winner. Happy-path pages carry no parent and are untouched.
 */
import { describe, it, expect } from 'vitest';

// @ts-ignore — plain CommonJS modules
const { buildParentCompareBlock, buildSemanticPrompt } = require('../../server/lib/sceneValidator.js');
// @ts-ignore
const S = require('../../server/lib/scoring.js');
// @ts-ignore
const FC = require('../../server/lib/feedbackConsolidator.js');
// @ts-ignore
const { PROMPT_TEMPLATES, loadPromptTemplates } = require('../../server/services/prompts.js');

const EMPTY = { quality: [], semantic: [], compliance: [], consolidated: [], entity: [] };
const f = (type: string, severity: string, name: string | null = null, extra: any = {}) =>
  ({ type, severity, name, description: `${type} ${name}`, source: 'consolidated', ...extra });
const v = (finalScore: number, consolidated: any[]) => ({ finalScore, evalScore: finalScore, deductions: { ...EMPTY, consolidated } });

describe('the parent block', () => {
  it('is empty when no parent is attached, so the happy-path prompt is untouched', () => {
    expect(buildParentCompareBlock(null)).toBe('');
    expect(buildParentCompareBlock({ imageData: '', findings: [] })).toBe('');
  });
  it('lists the parent findings by id and asks for the two answers', () => {
    const block = buildParentCompareBlock({ imageData: 'x', findings: [{ id: 'P1', severity: 'MAJOR', type: 'hair', character: 'Sarah', description: 'wrong hair' }] });
    expect(block).toContain('P1');
    expect(block).toContain('Sarah');
    expect(block).toContain('parent_findings');
    expect(block).toContain('also_in_parent');
  });
  it('reaches the built semantic prompt only on a paired call', async () => {
    await loadPromptTemplates();
    const base = { storyText: 't', sceneHint: 'h', imagePrompt: 'p', interactionsBlock: '', elementsBlock: '' };
    const plain = buildSemanticPrompt(PROMPT_TEMPLATES.imageSemantic, { ...base, evalContext: {} });
    const paired = buildSemanticPrompt(PROMPT_TEMPLATES.imageSemantic, { ...base, evalContext: { parent: { imageData: 'x', findings: [{ id: 'P1', severity: 'MAJOR', description: 'd' }] } } });
    expect(plain).not.toContain('also_in_parent');
    expect(plain).not.toContain('{PARENT_COMPARE}');
    expect(paired).toContain('also_in_parent');
  });
});

describe('what the parent is shown', () => {
  it('lists MODERATE and above, worst first, with stable ids', () => {
    const rows = S.parentFindingsForCompare(v(50, [f('clothing', 'minor', 'A'), f('hair', 'major', 'B'), f('action_interaction', 'critical', 'C')]));
    expect(rows.map((r: any) => [r.id, r.severity])).toEqual([['P1', 'CRITICAL'], ['P2', 'MAJOR']]);
  });
  it('is empty for a version without a deductions record', () => {
    expect(S.parentFindingsForCompare({ finalScore: 50 })).toEqual([]);
  });
});

describe('a shared finding is charged to both versions', () => {
  it('adds a finding the parent missed to the parent, at the same charge', () => {
    const parent = v(85, [f('clothing', 'major', 'A')]);
    const child = v(60, [f('clothing', 'major', 'A'), f('action_interaction', 'major', 'B', { alsoInParent: true })]);
    expect(S.chargeSharedFindingsToParent(child, parent)).toBe(1);
    expect(parent.finalScore).toBe(70);
  });
  it('leaves a parent that already carries the class at that charge alone', () => {
    const parent = v(70, [f('action_interaction', 'major', 'B')]);
    const child = v(70, [f('action_interaction', 'major', 'B', { alsoInParent: true })]);
    expect(S.chargeSharedFindingsToParent(child, parent)).toBe(0);
    expect(parent.finalScore).toBe(70);
  });
  it('never charges a finding the judge did not tag as shared', () => {
    const parent = v(85, []);
    const child = v(70, [f('action_interaction', 'major', 'B')]);
    expect(S.chargeSharedFindingsToParent(child, parent)).toBe(0);
    expect(parent.finalScore).toBe(85);
  });
});

describe('the tag survives scoring and consolidation', () => {
  it('normalizeIssues carries alsoInParent into the deductions', () => {
    const d = S.composeDeductions({ consolidated: [{ type: 'hair', severity: 'MAJOR', description: 'x', alsoInParent: true, sources: ['semantic'] }] });
    expect(d.consolidated[0].alsoInParent).toBe(true);
  });
  it('a deduped entry is shared only when EVERY finding behind it is', () => {
    const idx = FC.indexFindings({ semanticIssues: [
      { type: 'hair', severity: 'MAJOR', description: 'a', alsoInParent: true },
      { type: 'hair', severity: 'MAJOR', description: 'b' },
    ] });
    const both = FC.resolveDedupedIssues({ deduped_issues: [{ type: 'hair', description: 'ab', ids: ['S1', 'S2'] }] }, idx, 1);
    expect(both.deduped[0].alsoInParent).toBeUndefined();
    const one = FC.resolveDedupedIssues({ deduped_issues: [{ type: 'hair', description: 'a', ids: ['S1'] }] }, idx, 1);
    expect(one.deduped[0].alsoInParent).toBe(true);
  });
});

describe('B5: a clearing repair that adds a new CRITICAL/MAJOR does not dominate', () => {
  it('a shared finding is not new', () => {
    const v0 = v(75, [f('identity_swap', 'critical', 'Sarah')]);
    const v1 = v(43, [f('hair', 'major', 'Daniel', { alsoInParent: true })]);
    expect(S.dominatesByCritical(v1, v0)).toBe(true);
  });
  it('an untagged new MAJOR on anyone blocks it', () => {
    const v0 = v(75, [f('identity_swap', 'critical', 'Sarah')]);
    const v1 = v(43, [f('hair', 'major', 'Daniel')]);
    expect(S.dominatesByCritical(v1, v0)).toBe(false);
    expect(S.pickBestVersionIndex([v0, v1], { tieBreak: 'earliest' })).toBe(0);
  });
  it('a finding the parent already had at CRITICAL/MAJOR is not new', () => {
    const v0 = v(60, [f('identity_swap', 'critical', 'Sarah'), f('hair', 'major', 'Daniel')]);
    const v1 = v(85, [f('hair', 'major', 'Daniel')]);
    expect(S.dominatesByCritical(v1, v0)).toBe(true);
  });
});
