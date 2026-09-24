import { describe, it, expect, beforeAll } from 'vitest';

// "Char-fix: no judge text" (owner, 2026-09-23). The character-repair prompt
// carried the judge's finding verbatim as "Issues to fix:". On staging
// job_1790100385959_1nitlympp p14 the grid judge called Julian "the canonical
// dark-eyed Julian" while his stored eye colour is blue, and the repaint gave
// him brown eyes. Identity comes from the reference image and the stored
// description; a finding reaches the prompt only as its structured type,
// mapped to a fixed phrase. See docs/decisions.md 2026-09-23.

// eslint-disable-next-line @typescript-eslint/no-var-requires
const faceRepair = require('../../server/lib/faceRepair');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildCharRepairRequest } = require('../../server/lib/charRepairRequest');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { decideRepairMethod } = require('../../server/lib/repairLogic');

const JUDGE_TEXT = "Julian's face in cell E has blue eyes and different facial proportions, "
  + 'making him look like a different child compared to the canonical dark-eyed Julian.';
const STORED_DESCRIPTION = 'Julian is a 3-year-old boy with light blonde curly hair and blue eyes. Wearing: yellow shirt';

const AXES = [
  { treatment: 'crosshatch', regionSource: 'cutout', faceOnly: false },
  { treatment: 'crosshatch', regionSource: 'box', faceOnly: false },
  { treatment: 'blur', regionSource: 'cutout', faceOnly: true },
  { treatment: 'blur', regionSource: 'box', faceOnly: false },
  { treatment: 'none-such', regionSource: 'box', faceOnly: false }, // template-less fallback
];

async function build(axes: Record<string, unknown>, fields: Record<string, unknown>) {
  const opts = buildCharRepairRequest({
    imageBackend: 'grok',
    characterDescription: STORED_DESCRIPTION,
    clothingDescription: 'A yellow long-sleeve shirt',
    artStyle: 'watercolor',
    ...fields,
  });
  return faceRepair.buildPrompt({ ...axes, charName: 'Julian', opts });
}

describe('char-fix prompt carries no judge text', () => {
  beforeAll(async () => { await require('../../server/services/prompts').loadPromptTemplates(); });

  for (const axes of AXES) {
    it(`${axes.treatment}/${axes.regionSource}/${axes.faceOnly ? 'face' : 'body'}: the finding's wrong trait never reaches the prompt`, async () => {
      const prompt = await build(axes, { defectTypes: ['face_mismatch'] });
      expect(prompt).not.toMatch(/dark-eyed/);
      expect(prompt).not.toMatch(/cell E/);
      expect(prompt).not.toMatch(/Issues to fix/);
      // identity still comes from the reference and the stored description
      expect(prompt).toMatch(/Julian/);
      expect(prompt).toMatch(/reference/i);
      // the crosshatch templates also carry the stored description; the blur
      // templates and the fallback name the reference only
      if (axes.treatment === 'crosshatch') expect(prompt).toContain('blue eyes');
      expect(prompt).toContain(`Defect to fix: ${faceRepair.CHAR_FIX_DEFECT_PHRASES.face_mismatch}.`);
    });
  }

  it('every template keeps its match-IMAGE-1 identity line', async () => {
    const cut = await build(AXES[0], { defectTypes: ['face_mismatch'] });
    expect(cut).toContain('Face, hair, skin tone and build: from IMAGE 1.');
    const box = await build(AXES[1], { defectTypes: ['face_mismatch'] });
    expect(box).toContain('Face: match IMAGE 1');
    const face = await build(AXES[2], { defectTypes: ['face_mismatch'] });
    expect(face).toContain('to look like Julian from IMAGE 1');
    const body = await build(AXES[3], { defectTypes: ['face_mismatch'] });
    expect(body).toContain('to match IMAGE 1');
  });

  it('an unknown or missing type adds no defect line — the reference still carries identity', async () => {
    for (const defectTypes of [null, [], ['cutout_artifact'], ['no-such-type']]) {
      const prompt = await build(AXES[0], { defectTypes });
      expect(prompt).not.toMatch(/Defect to fix/);
      expect(prompt).not.toMatch(/dark-eyed/);
      expect(prompt).toContain('IMAGE 1');
    }
  });

  it('the repair request cannot carry the judge sentence — the field is gone from the contract', () => {
    expect(() => buildCharRepairRequest({ imageBackend: 'grok', issueDescription: JUDGE_TEXT })).toThrow(/unknown field/);
  });

  it('several types dedupe to one phrase each', () => {
    const line = faceRepair.charFixDefectContext(['hair_change', 'hair', 'FACE_MISMATCH']);
    expect(line).toBe(`\nDefect to fix: ${faceRepair.CHAR_FIX_DEFECT_PHRASES.hair_change}; ${faceRepair.CHAR_FIX_DEFECT_PHRASES.face_mismatch}.`);
  });

  it('decideRepairMethod → request → prompt: the p14 entity finding reaches the prompt as its type only', async () => {
    const decision = decideRepairMethod(14, {
      scoreBreakdown: { visual: { score: 100 }, semantic: { score: 100 } },
      fixableIssues: [],
      consolidatedPlan: { deduped_issues: [] },
    }, {
      characters: {
        Julian: { issues: [{ type: 'face_mismatch', subType: 'face_mismatch', severity: 'CRITICAL', pagesToFix: [14], description: JUDGE_TEXT }] },
      },
    });
    expect(decision.method).toBe('char-fix');
    expect(decision.issueTypes).toEqual(['face_mismatch']);
    // The decision carries no judge sentence at all — only the type.
    expect(decision).not.toHaveProperty('issueDescription');
    const prompt = await build(AXES[2], { defectTypes: decision.issueTypes });
    expect(prompt).not.toMatch(/dark-eyed/);
    expect(prompt).toContain(faceRepair.CHAR_FIX_DEFECT_PHRASES.face_mismatch);
  });

  it('the clothing gate names its type so the figure redo still says what kind of defect', () => {
    const decision = decideRepairMethod(3, {
      scoreBreakdown: { visual: { score: 70 }, semantic: { score: 80 } },
      fixableIssues: [],
      consolidatedPlan: { deduped_issues: [{ type: 'clothing', severity: 'MAJOR', character: 'Ethan', description: 'wears a red coat instead of the dark-green anorak' }] },
    }, null);
    expect(decision.method).toBe('char-fix');
    expect(decision.issueTypes).toEqual(['clothing']);
  });
});
