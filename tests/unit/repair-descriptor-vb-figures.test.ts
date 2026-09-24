/**
 * A repair instruction names a figure by sight — creatures and secondary
 * characters included (owner, 2026-09-24).
 *
 * dbdc6b1c2 made every repair instruction identify a CAST character by age,
 * clothing and position. The bible's named figures were not in that list:
 * staging job_1790100385959_1nitlympp p13 sent Grok "For the rust-red dragon in
 * the center: Sit <creature name> heavily back on his haunches". The image model
 * has never heard the name.
 *
 * Only the network boundary is stubbed (Grok's edit call); inpaintPage runs for
 * real. No paid call is made.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

// images.js destructures grok's exports at module load — stub before requiring.
const grok = require_('../../server/lib/grok');
let sent: string[] = [];
grok.isGrokConfigured = () => true;
grok.packReferences = async () => [];
grok.editWithGrok = async (p: string) => { sent.push(p); return { imageData: 'data:image/jpeg;base64,' + 'A'.repeat(2000), modelId: 'grok-imagine-image', usage: {} }; };
grok.generateWithGrok = async () => { throw new Error('not used'); };

const images = require_('../../server/lib/images');
const { loadPromptTemplates } = require_('../../server/services/prompts');
const { describeFigureForRepair, buildRepairNameMap } = require_('../../server/lib/repairLogic');

// Archetypal fixture — the shape of a stored bible, no story names.
const VB = {
  animals: [{
    id: 'ANI001', name: 'Bramble', species: 'young dragon',
    coloring: 'warm rust-red smooth scales',
    features: 'rounded snout, single pair of short blunt horns, large round yellow eyes',
    scaleClass: 'waist-high',
    description: 'young dragon. stands hip-high to an adult. warm rust-red smooth scales. rounded snout',
  }],
  secondaryCharacters: [{
    id: 'CHR001', name: 'Oldwick', age: 60,
    clothing: 'dark grey woollen tunic falling to the knees, matching trousers',
    description: '60. a man, tall and lean. Clothing: dark grey woollen tunic',
  }],
  artifacts: [], vehicles: [], locations: [],
};
const CAST = [
  { name: 'Mika', age: 5, gender: 'male' },
  { name: 'Lotte', age: 7, gender: 'female' },
];
const FIGURES = [
  { name: 'Mika', box: [0.4, 0.05, 0.9, 0.25] },
  { name: 'Bramble', box: [0.47, 0.35, 0.78, 0.81] },
  { name: 'Lotte', box: [0.4, 0.85, 0.9, 0.98] },
];

describe('describeFigureForRepair: a bible figure', () => {
  it('describes a creature by kind, colouring and key features — never its name or size', () => {
    const out = describeFigureForRepair({ name: 'Bramble', characters: CAST, visualBible: VB, detectedFigures: FIGURES });
    expect(out).toBe('the young dragon with warm rust-red smooth scales (rounded snout, single pair of short blunt horns), second from the left');
    expect(out).not.toMatch(/Bramble|hip-high|waist-high/);
  });

  it('describes a secondary character by age and garment', () => {
    const out = describeFigureForRepair({ name: 'Oldwick', characters: CAST, visualBible: VB });
    expect(out).toBe('the 60-year-old figure in dark grey woollen tunic falling to the knees');
  });

  it('leaves the cast description unchanged', () => {
    const withVb = describeFigureForRepair({ name: 'Mika', characters: CAST, visualBible: VB, detectedFigures: FIGURES });
    const without = describeFigureForRepair({ name: 'Mika', characters: CAST, detectedFigures: FIGURES });
    expect(withVb).toBe(without);
    expect(withVb).toBe('the 5-year-old boy, on the far left');
  });
});

describe('buildRepairNameMap', () => {
  it('lists the cast and the bible figures, one descriptor each', () => {
    const { names, fallbackByName } = buildRepairNameMap({ characters: CAST, visualBible: VB });
    expect(names).toEqual(['Mika', 'Lotte', 'Oldwick', 'Bramble']);
    expect(fallbackByName.get('bramble')).toMatch(/^the young dragon/);
  });
});

describe('inpaintPage: the instruction the image model receives', () => {
  beforeAll(async () => { await loadPromptTemplates(); });
  beforeEach(() => { sent = []; });

  const evaluation = {
    fixableIssues: [
      { description: 'creature lies down instead of sitting', type: 'action_interaction' },
      { description: 'expression too mild', type: 'emotion' },
    ],
  };
  const run = (plan: any) => images.inpaintPage('data:image/jpeg;base64,AAAA', evaluation, {
    consolidatedPlan: plan, visualBible: VB, characters: CAST, pageNumber: 5,
    detectedFigures: FIGURES, aspectRatio: '3:4',
  });

  it('a creature named in a per-character fix arrives as its description', async () => {
    // The stored run-6 p13 shape: the plan's own identifier, the name in the body.
    await run({
      scene_fix: { instruction: 'Show Bramble with wide yellow eyes.', types: ['emotion'], severity: 'CRITICAL' },
      per_character_fixes: [{
        characterName: 'Bramble', types: ['action_interaction'], severity: 'CRITICAL',
        visual_identifier: 'the rust-red dragon in the center',
        fix_instruction: 'Sit Bramble heavily back on his haunches.',
      }],
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toContain('Bramble');
    expect(sent[0]).toContain('For the rust-red dragon in the center: Sit this character heavily back on his haunches.');
    expect(sent[0]).toContain('Show the rust-red dragon in the center with wide yellow eyes.');
  }, 30000);

  it('a creature with no per-character entry — and one cited by id — gets the bible descriptor', async () => {
    await run({
      scene_fix: { instruction: "Turn Bramble's head toward ANI001's tail and Oldwick.", types: ['action_interaction'], severity: 'MAJOR' },
      per_character_fixes: [],
    });
    expect(sent[0]).not.toMatch(/Bramble|Oldwick|ANI001/);
    expect(sent[0]).toContain("the young dragon with warm rust-red smooth scales (rounded snout, single pair of short blunt horns), second from the left's head");
    expect(sent[0]).toContain('the 60-year-old figure in dark grey woollen tunic falling to the knees');
  }, 30000);

  it('cast names are replaced exactly as before', async () => {
    await run({
      scene_fix: { instruction: 'Make Lotte look at Mika.', types: ['gaze'], severity: 'MAJOR' },
      per_character_fixes: [],
    });
    expect(sent[0]).toContain('Make the 7-year-old girl, on the far right look at the 5-year-old boy, on the far left.');
  }, 30000);

  it('a lone fix that cites a creature by id is not sent past the name strip', async () => {
    const single = { fixableIssues: [{ description: 'd', type: 'action_interaction', fix: 'Sit ANI001 back on his haunches.' }] };
    const res = await images.inpaintPage('data:image/jpeg;base64,AAAA', single, {
      visualBible: VB, characters: CAST, pageNumber: 5, detectedFigures: FIGURES,
    });
    // Not the verbatim shortcut: with no plan it stops loudly instead.
    expect(res.error).toBe('no consolidated plan on the evaluation');
    expect(sent).toHaveLength(0);
  }, 30000);
});
