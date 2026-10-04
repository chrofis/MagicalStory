/**
 * Review 2026-10-04 A1: when the arc machine throws AFTER the arc was created,
 * the catch ("never block a story on the arc step") cleared the arc text but kept
 * the discarded arc's derived state (central figure, invented-figure list and
 * limit, premise names, challenge tags). The planner was then told a central
 * figure from an arc nobody sees. Every arc-derived variable resets together.
 *
 * Runs the real pipeline with every model call mocked; the planner's prompt is
 * the observable.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const textModels = require('../../server/lib/textModels.js');
const { loadPromptTemplates } = require('../../server/services/prompts.js');

const realStreaming = textModels.callTextModelStreaming;
afterEach(() => { textModels.callTextModelStreaming = realStreaming; });

const CREATE = [
  'STORY LOGIC:',
  'Want and stakes: Mila wants to return the lost zeppelin before night.',
  'Opposition: the cold.',
  'Facts:',
  '- Mila (commissioned) — can carry the zeppelin; cannot climb the wall',
  'Central figure: the zeppelin',
  'Chain:',
  '- because the zeppelin is cold, Mila carries it home',
  '',
  'ARC:',
  '1. The child finds a lost zeppelin.',
  '2. The child returns it.',
  'CRITIQUE:',
  'Logic:',
  '- none',
  'Faults:',
  '1. [MINOR] (s2) the ending is quiet — "The child returns it"',
].join('\n');

describe('arc machine failure after the create', () => {
  it('the planner is not told the discarded arc\'s central figure', async () => {
    await loadPromptTemplates();
    const stop = new Error('stop at the planner');
    let plannerPrompt = '';
    const labels: string[] = [];
    textModels.callTextModelStreaming = async (p: string, _m: any, _c: any, _model: string, opts: any) => {
      labels.push(opts?.usageLabel);
      if (opts?.usageLabel === 'beats_plan') { plannerPrompt = p; throw stop; }
      return { text: CREATE, usage: { output_tokens: 10 }, stop_reason: 'end_turn', modelId: 'mock', truncation: null };
    };
    // The round loop's cancellation check runs inside the arc machine's try, after
    // the create committed: a throw there is a failure AFTER the arc's state was set.
    let boomed = false;
    const checkCancellation = async () => {
      if (labels.includes('arc_create') && !boomed) { boomed = true; throw new Error('boom after create'); }
    };
    const noop = () => {};
    const genLog = { info: noop, warn: noop, error: noop, debug: noop };
    const { generateStoryViaBeats } = require('../../server/lib/beatsPipeline.js');
    const inputData = {
      language: 'en', languageLevel: 'standard', ageRange: '4-6', pages: 4, storyType: 'adventure',
      characters: [{ id: 1, name: 'Mila', age: 5, gender: 'female', isMainCharacter: true }],
    };
    await expect(generateStoryViaBeats(inputData, { checkCancellation, genLog })).rejects.toBe(stop);
    expect(boomed).toBe(true);
    expect(plannerPrompt.length).toBeGreaterThan(100);
    expect(plannerPrompt.toLowerCase()).not.toContain('zeppelin');
  });
});

/**
 * Review 2026-10-04 A2: a page the planner omits used to be a warning, so the
 * book shipped short at full price. It throws now; the job's outer catch fails
 * the job and refunds the credits (settleJobWithRefund).
 */
describe('a planner that omits a page', () => {
  it('fails the run instead of planning a shorter book', async () => {
    await loadPromptTemplates();
    textModels.callTextModelStreaming = async (_p: string, _m: any, _c: any, _model: string, opts: any) => {
      const text = opts?.usageLabel === 'beats_plan'
        ? ['---PAGE PLAN---', 'Page 1: wide — Mila — she finds the zeppelin — alone', 'Page 2: medium — Mila — she carries it — warm'].join(String.fromCharCode(10))
        : CREATE;
      return { text, usage: { output_tokens: 10 }, stop_reason: 'end_turn', modelId: 'mock', truncation: null };
    };
    const noop = () => {};
    const events: string[] = [];
    const genLog = { info: noop, warn: noop, error: (k: string) => events.push(k), debug: noop };
    const { generateStoryViaBeats } = require('../../server/lib/beatsPipeline.js');
    const inputData = {
      language: 'en', languageLevel: 'standard', ageRange: '4-6', pages: 4, storyType: 'adventure',
      characters: [{ id: 1, name: 'Mila', age: 5, gender: 'female', isMainCharacter: true }],
    };
    await expect(generateStoryViaBeats(inputData, { checkCancellation: async () => {}, genLog })).rejects.toThrow(/planner omitted page/i);
    expect(events).toContain('beats_plan_incomplete');
  });
});
