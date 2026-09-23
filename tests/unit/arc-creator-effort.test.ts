/**
 * The arc creator's two calls carry their own thinking effort (owner,
 * 2026-09-23, staging trial): arc_create at MODEL_DEFAULTS.arcCreateEffort,
 * arc_retell at MODEL_DEFAULTS.arcRetellEffort, both uncapped (null max_tokens
 * = the model's ceiling). Runs the real arc machine with the model call mocked
 * and reads the options each call was built with.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const textModels = require('../../server/lib/textModels.js');
const { MODEL_DEFAULTS } = require('../../server/config/models.js');
const { loadPromptTemplates } = require('../../server/services/prompts.js');

const realStreaming = textModels.callTextModelStreaming;
afterEach(() => { textModels.callTextModelStreaming = realStreaming; });

const CREATE = [
  'ARC 1:',
  '1. The child finds a lost egg.',
  '2. The child returns it.',
  'CRITIQUE:',
  '1. [MINOR] the ending is quiet.',
  '',
  'ARC 2:',
  '1. The child builds a nest.',
  'CRITIQUE:',
  '1. [MAJOR] nothing goes wrong.',
  '',
  'Stronger: Arc 1 — it has a turn.',
].join('\n');

const RETELL = [
  'Fixing: nothing above MINOR.',
  'Keeping: the return.',
  'Used: Panelist A',
  'FINAL ARC:',
  '1. The child finds a lost egg.',
  '2. The child returns it to its mother.',
  'CRITIQUE:',
  '1. [MINOR] the ending is quiet.',
].join('\n');

describe('arc machine — create and retell effort', () => {
  it('pins the owner decision: create max, retell medium', () => {
    expect(MODEL_DEFAULTS.arcCreateEffort).toBe('max');
    expect(MODEL_DEFAULTS.arcRetellEffort).toBe('medium');
  });

  it('sends arcCreateEffort on arc_create and arcRetellEffort on arc_retell, uncapped', async () => {
    await loadPromptTemplates();
    const calls: { label: string; maxTokens: any; model: string; opts: any }[] = [];
    textModels.callTextModelStreaming = async (_p: string, maxTokens: any, _c: any, model: string, opts: any) => {
      calls.push({ label: opts?.usageLabel, maxTokens, model, opts });
      const text = opts?.usageLabel === 'arc_create' ? CREATE
        : opts?.usageLabel === 'arc_retell' ? RETELL
          : 'Solution: give the child one failed attempt first.';
      return { text, usage: { output_tokens: 10 }, stop_reason: 'end_turn', modelId: 'mock', truncation: null };
    };
    // Stop the run once the arc machine has finished: the next cancellation
    // check after the re-telling is the one in front of the beats plan.
    const stop = new Error('stop after the arc');
    const checkCancellation = async () => {
      if (calls.some(c => c.label === 'arc_retell')) throw stop;
    };
    const { generateStoryViaBeats } = require('../../server/lib/beatsPipeline.js');
    const inputData = {
      language: 'en', languageLevel: 'standard', ageRange: '4-6', pages: 4, storyType: 'adventure',
      characters: [{ id: 1, name: 'Mila', age: 5, gender: 'female', isMainCharacter: true }],
    };
    await expect(generateStoryViaBeats(inputData, { checkCancellation })).rejects.toBe(stop);

    const create = calls.filter(c => c.label === 'arc_create');
    const retell = calls.filter(c => c.label === 'arc_retell');
    expect(create.length).toBe(1);
    expect(retell.length).toBe(1);
    expect(create[0].opts.effort).toBe(MODEL_DEFAULTS.arcCreateEffort);
    expect(retell[0].opts.effort).toBe(MODEL_DEFAULTS.arcRetellEffort);
    // Same model for both; neither call is capped below the model ceiling.
    expect(create[0].model).toBe(MODEL_DEFAULTS.arcCreatorModel);
    expect(retell[0].model).toBe(MODEL_DEFAULTS.arcCreatorModel);
    expect(create[0].maxTokens).toBeNull();
    expect(retell[0].maxTokens).toBeNull();
    // The panel is not a creator call and gets no effort.
    for (const p of calls.filter(c => c.label === 'arc_panel')) expect(p.opts.effort).toBeUndefined();
  }, 30000);
});
