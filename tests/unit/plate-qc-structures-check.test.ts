/**
 * The plate QC fails a structure that does not match its description (owner,
 * 2026-09-26): a vessel, vehicle or large structure the plate's author was
 * given under STRUCTURES that the scene puts in view and the plate lacks, or
 * that the plate shows as another kind or shape. Filed under the SOFT
 * `structures` key.
 *
 * Pinned on the BUILT prompts: the check exists only when the author was given
 * structures, it quotes the author's own two rules from the constants that
 * build the author's block, the reference image is named only when attached,
 * and the key is soft. No wording is pinned. Offline and free.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

let build: any;
let prompts: any;
let plateQc: any;

const VB = {
  vehicles: [{ id: 'VEH001', name: 'river barge', type: 'boat', description: 'a flat green barge with one short mast', pages: [3] }],
  artifacts: [],
};

beforeAll(async () => {
  prompts = require_('../../server/services/prompts.js');
  await prompts.loadPromptTemplates();
  build = require_('../../server/lib/evalPipeline.js').buildEmptySceneQcPrompt;
  plateQc = require_('../../server/lib/plateQc.js');
});

describe('the structures check', () => {
  it('the author and the judge read the same two rules', () => {
    const structures = prompts.buildPlateStructuresText({ visualBible: VB, pageNumber: 3, sceneObjects: ['VEH001'] });
    expect(structures).toContain(prompts.PLATE_STRUCTURE_MATCH_RULE);
    expect(structures).toContain(prompts.PLATE_STRUCTURE_PART_RULE);
    const qc = build({ sceneDescription: 'A quay.', structures });
    const check = qc.split('\n').find((l: string) => l.startsWith('- Structures:')) || '';
    expect(check).toContain(prompts.PLATE_STRUCTURE_MATCH_RULE);
    expect(check).toContain(prompts.PLATE_STRUCTURE_PART_RULE);
    expect(qc).not.toMatch(/\{[A-Z_]{3,}\}/);
  });

  it('no structures given, no check', () => {
    const qc = build({ sceneDescription: 'A quay.' });
    expect(qc).not.toContain('- Structures:');
    expect(qc).not.toMatch(/\{[A-Z_]{3,}\}/);
  });

  it('names the reference render only when one is attached', () => {
    const structures = prompts.buildPlateStructuresText({ visualBible: VB, pageNumber: 3, sceneObjects: ['VEH001'] });
    const line = (p: string) => p.split('\n').find((l: string) => l.startsWith('- Structures:')) || '';
    expect(line(build({ structures, structureReference: true }))).toContain('STRUCTURE REFERENCE');
    expect(line(build({ structures, structureReference: false }))).not.toContain('STRUCTURE REFERENCE');
  });

  it('`structures` is a known, soft check key the judge is offered', () => {
    const entry = plateQc.PLATE_QC_CHECKS.find((c: any) => c.key === 'structures');
    expect(entry).toBeTruthy();
    expect(entry.hard).toBe(false);
    expect(plateQc.checkKeysForPrompt()).toContain('structures (');
    expect(plateQc.normaliseJudgeIssue({ check: 'structures', issue: 'a rowboat where a sailing ship is described' }).check).toBe('structures');
    const sev = plateQc.qcSeverity({ findings: [{ check: 'structures', issue: 'x' }] });
    expect(sev.hard).toHaveLength(0);
    expect(sev.soft).toHaveLength(1);
  });
});
