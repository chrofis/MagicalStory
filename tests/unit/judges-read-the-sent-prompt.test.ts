/**
 * THE JUDGES READ WHAT THE IMAGE MODEL WAS SENT, AND THE SHRINK NEVER CUTS THE
 * SCENE (owner, 2026-09-26: "The eval should judge the same thing as image
 * generation, not a different prompt").
 *
 * Three behaviours, pinned against the real builder, the real shrink and the
 * real consolidator:
 *   1. an over-cap page prompt loses only ranked generic blocks — every
 *      sentence of the brief's prose, THIS IMAGE DEPICTS and the LIGHT line
 *      reach the model; a prompt the drops cannot fit fails loudly, nothing
 *      is trimmed;
 *   2. the batch judges' scene text is the scene block of that sent prompt
 *      (resolveEvalSceneDescription over the recorded compressedScene);
 *   3. the consolidator reads the scene the judges scored
 *      (evaluation.judgedPrompt), never the page's brief, and refuses to run
 *      without it.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';

const require_ = createRequire(import.meta.url);

// feedbackConsolidator destructures callTextModel at load: stub first.
const textModels = require_('../../server/lib/textModels');
let consolidatorInput: string | null = null;
textModels.callTextModel = async (input: string) => {
  consolidatorInput = input;
  return { text: JSON.stringify({ per_character_fixes: [], scene_fix: { severity: 'NONE', instruction: '', preserve: [] }, dropped_issues: [], deduped_issues: [] }), usage: {} };
};

const PB = require_('../../server/lib/promptBuilders.js');
const { loadPromptTemplates } = require_('../../server/services/prompts.js');
const images = require_('../../server/lib/images.js');
const { resolveEvalSceneDescription, splitBrief } = require_('../../server/lib/sceneMetadata.js');
const { judgedSceneText } = require_('../../server/lib/evalPipeline.js');
const { consolidateFeedback } = require_('../../server/lib/feedbackConsolidator.js');

const inputData: any = {
  title: 'The Lamp on the Pier',
  characters: [{ id: 'c1', name: 'Mira', age: 8, gender: 'girl', hairColor: 'brown' }],
  mainCharacters: ['c1'],
  language: 'en',
  pages: 4,
  storyCategory: 'adventure',
  storyDetails: 'A night at the harbour.',
  artStyle: 'watercolor',
};
const VISUAL_BIBLE: any = {
  artifacts: [{ id: 'ART001', name: 'brass lantern', description: 'a dented brass lantern', pages: [1] }],
  locations: [], vehicles: [], characters: [],
};

// A long brief whose LAST sentence is the one a tail trim would take first.
const PROSE = Array.from({ length: 40 }, (_, i) =>
  `The main character kneels on plank ${i} of the wet pier, both hands cupped around the lantern glass.`).join(' ')
  + ' LAST_BRIEF_SENTENCE the harbour light falls on the water.';
const BRIEF = `${PROSE}\n\n---METADATA---\n${JSON.stringify({
  sceneIntent: 'SCENE_INTENT_SENTINEL the lamp is lit',
  characters: [{ name: 'Mira', position: 'center', depth: 'midground' }],
  shot: 'wide',
  objects: ['ART001'],
  timeOfDay: 'evening',
  weather: 'none',
  textPosition: 'bottom-left',
})}`;

const sentences = (t: string) => t.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);

let built = '';
beforeAll(async () => {
  await loadPromptTemplates();
  built = String(PB.buildImagePrompt(BRIEF, inputData, null, VISUAL_BIBLE, 1, null, {}));
});

describe('the shrink cuts the scene only when nothing else fits', () => {
  it('a cap the ranked drops can reach: the whole brief prose, the scene intent and the LIGHT line are sent', async () => {
    const cap = built.length - 400;
    const meta: any = {};
    const sent: string = await images.shrinkPromptForModel(built, cap, 'TEST scene', null, meta);
    expect(sent.length).toBeLessThanOrEqual(cap);
    expect(sent.length).toBeLessThan(built.length);
    for (const s of sentences(splitBrief(BRIEF).prose)) expect(sent).toContain(s);
    expect(sent).toContain('SCENE_INTENT_SENTINEL');
    expect(sent).toContain('**LIGHT:**');
  });

  // Owner, 2026-09-30: one LLM try, then a sentence cut from the end of the
  // prose. The judges still read exactly what was sent (compressedScene).
  it('a cap the drops cannot reach: the prose is cut at sentence ends, and the judges read that cut scene', async () => {
    const shorten = require_('../../server/lib/sceneShorten.js');
    const orig = shorten.shortenSceneOnce;
    shorten.shortenSceneOnce = async () => null;
    try {
      const floor = images.promptFloor(built);
      const cap = floor - 100;
      const meta: any = {};
      const sent: string = await images.shrinkPromptForModel(built, cap, 'TEST scene', null, meta);
      expect(sent.length).toBeLessThanOrEqual(cap);
      expect(sent).toContain('SCENE_INTENT_SENTINEL');
      expect(sent).toContain('**LIGHT:**');
      expect(sent).not.toContain('LAST_BRIEF_SENTENCE');
      const judged = resolveEvalSceneDescription({ compressedScene: meta.compressedScene, sceneDescription: BRIEF, prompt: sent });
      expect(sent).toContain(judged);
      expect(judged).not.toContain('LAST_BRIEF_SENTENCE');
    } finally { shorten.shortenSceneOnce = orig; }
  });
});

describe('the batch judges read the scene block that was sent', () => {
  it('resolveEvalSceneDescription returns the recorded head of the sent prompt, which carries the whole prose', async () => {
    const meta: any = {};
    const sent: string = await images.shrinkPromptForModel(built, built.length - 400, 'TEST scene', null, meta);
    const judged = resolveEvalSceneDescription({ compressedScene: meta.compressedScene, sceneDescription: BRIEF, prompt: sent });
    expect(judged).toBe(meta.compressedScene);
    expect(sent).toContain(judged);
    expect(judged).toContain('LAST_BRIEF_SENTENCE');
  });
});

describe('the consolidator reads the scene the judges scored', () => {
  it('its "Intended scene description" is evaluation.judgedPrompt, not the brief', async () => {
    consolidatorInput = null;
    const judgedPrompt = judgedSceneText('JUDGED_SCENE_SENTINEL the prompt the model received.');
    const res = await consolidateFeedback({
      evaluation: { judgedPrompt, fixableIssues: [{ description: 'the lantern is missing', severity: 'MAJOR', type: 'object_presence' }] },
      pageNumber: 1, characters: [], visualBible: VISUAL_BIBLE,
    });
    expect(res.error ?? null).toBeNull();
    expect(consolidatorInput).toContain('JUDGED_SCENE_SENTINEL');
  });

  it('refuses to consolidate an evaluation that does not say what the judges scored', async () => {
    consolidatorInput = null;
    const res = await consolidateFeedback({
      evaluation: { fixableIssues: [{ description: 'x', severity: 'MAJOR', type: 'object_presence' }] },
      pageNumber: 1, characters: [], visualBible: VISUAL_BIBLE,
    });
    expect(res.plan).toBeNull();
    expect(res.error).toMatch(/judgedPrompt/);
    expect(consolidatorInput).toBeNull();
  });
});
