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

const LOGIC = (want: string) => [
  'STORY LOGIC:',
  `Want and stakes: ${want}`,
  'Opposition: the cold.',
  'Facts:',
  '- Mila (commissioned) — can carry the egg; cannot climb the wall',
  '- An egg left cold does not hatch.',
  'Central figure: the egg',
  'Chain:',
  '- because the egg is cold, Mila carries it home',
  '- but the door is shut, so she warms it in her coat',
].join('\n');

const CREATE = [
  LOGIC('Mila wants to return the egg before night.'),
  '',
  'ARC:',
  '1. The child finds a lost egg.',
  '2. The child returns it.',
  'CRITIQUE:',
  'Logic:',
  '- none',
  'Faults:',
  '1. [MINOR] the ending is quiet.',
].join('\n');

const RETELL = [
  LOGIC('Mila wants to return the egg to its mother before night.'),
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
    const prompts: Record<string, string> = {};
    textModels.callTextModelStreaming = async (_p: string, maxTokens: any, _c: any, model: string, opts: any) => {
      calls.push({ label: opts?.usageLabel, maxTokens, model, opts });
      prompts[opts?.usageLabel] = _p;
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
    // One arc, logic first (2026-09-24): the panel and the re-telling read the
    // create's STORY LOGIC with its arc and critique.
    expect(prompts.arc_panel).toContain('Want and stakes: Mila wants to return the egg before night.');
    expect(prompts.arc_retell).toContain('Want and stakes: Mila wants to return the egg before night.');
    expect(prompts.arc_panel).not.toMatch(/Stronger:|ARC 2/);
  }, 30000);
});
