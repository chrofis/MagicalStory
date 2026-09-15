import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// Owner ruling 2026-09-15 (generator↔critic gap audit).
describe('the avatar evaluator\'s contract reaches both avatar generators', () => {
  // Row 19 — avatar-evaluation TASK 1 caps faceMatch at 3 on a glasses
  // mismatch, and faceMatch is the LOWEST of seven. The generator was told
  // about glasses only when the user DECLARED them.
  it('both prompts carry the glasses rule', () => {
    for (const f of ['prompts/avatar-main-prompt.txt', 'prompts/avatar-retry-prompt.txt']) {
      expect(read(f)).toContain('Glasses follow the reference photo');
    }
  });

  // Row 20 — the retry's output is judged on all seven identity features.
  it('the retry carries face fidelity and age proportions', () => {
    const t = read('prompts/avatar-retry-prompt.txt');
    expect(t).toContain("The face is the reference photo's face, not an average of it");
    expect(t).toContain('head-to-body ratio follow the age the reference photo shows');
  });

  it('the retry keeps its outfit placeholder', () => {
    expect(read('prompts/avatar-retry-prompt.txt')).toContain('{OUTFIT_DESCRIPTION}');
  });
});

// Rows 23/24/31 — empty-scene QC and its pixel twins measure interior
// artefacts, naturalness and a luminance floor; the template banned only EDGE
// artefacts and doubled VEHICLES. Built through the real builder.
describe('the empty-scene QC\'s checks reach the plate author', () => {
  let prompt: string;

  beforeAll(async () => {
    await require('../../server/services/prompts').loadPromptTemplates();
    const { buildEmptyScenePrompt } = require('../../server/services/prompts');
    prompt = buildEmptyScenePrompt({
      emptySceneDescription: 'A quiet harbour at dusk, the quay running to the right background.',
      artStyle: 'watercolour',
    });
  });

  it('bans the artefact anywhere in frame, not only at the edge', () => {
    expect(prompt).toContain('no white or near-white rectangle, triangle, wedge, diagonal band, monochrome panel or blank patch anywhere in the frame');
  });

  it('generalises the doubled-prop and coherence rules past vehicles', () => {
    expect(prompt).toContain('No prop appears twice in the frame, no shape melts, no surface changes material mid-stroke, and every perspective line agrees with the others.');
  });

  it('states the luminance floor beside the existing lighting rule', () => {
    expect(prompt).toContain('A night, interior or storm scene still keeps enough light to read its surfaces, never a near-black frame.');
  });
});

// Owner ruling D — D-10 is removed: measured at zero precision, and no prompt
// makes a diffusion model draw five fingers.
describe('the anatomy detail check is gone', () => {
  const t = () => read('prompts/image-evaluation.txt');

  it('D-10 no longer exists', () => {
    expect(t()).not.toContain('**D-10');
    expect(t()).not.toContain('six or more fingers');
  });

  it('D-09 and D-12 survive and stay complements', () => {
    expect(t()).toContain('**D-09 `anatomy` → CRITICAL.**');
    expect(t()).toContain('**D-12 `figure_completeness` → MAJOR.**');
  });

  it('the D-11 to D-13 exemption still resolves', () => {
    expect(t()).toContain('Never fire D-11 to D-13');
    for (const d of ['D-11', 'D-12', 'D-13']) expect(t()).toContain(`**${d} `);
  });
});
