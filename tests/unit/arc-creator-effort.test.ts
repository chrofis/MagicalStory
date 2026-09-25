/**
 * The arc creator's two calls carry their own thinking effort (owner,
 * 2026-09-23, staging trial): arc_create at MODEL_DEFAULTS.arcCreateEffort,
 * arc_retell at MODEL_DEFAULTS.arcRetellEffort, both uncapped (null max_tokens
 * = the model's ceiling). Runs the real arc machine with the model call mocked
 * and reads the options each call was built with.
 *
 * THE RE-TELL GATE (owner, 2026-09-25): the same run pins that the re-telling
 * runs only on a quoted MAJOR/CRITICAL finding and is handed only those.
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

// A quoted MAJOR (s2 of CREATE) and a quoted MINOR, one panel reply.
const PANEL_MAJOR = [
  '1. ISSUE [MAJOR] s2 "The child returns it" — CAUSE: nothing says where the nest is. Smallest change: move the nest fact earlier.',
  '2. ISSUE [MINOR] s1 "The child finds a lost egg" — SENSE: a blemish.',
].join('\n');
const PANEL_MINOR = '1. ISSUE [MINOR] s1 "The child finds a lost egg" — SENSE: a blemish.';

/** Run the arc machine with every model call mocked; stop at the beats plan. */
async function runArc(panelReply: string) {
  await loadPromptTemplates();
  const calls: { label: string; maxTokens: any; model: string; opts: any }[] = [];
  const prompts: Record<string, string> = {};
  textModels.callTextModelStreaming = async (_p: string, maxTokens: any, _c: any, model: string, opts: any) => {
    calls.push({ label: opts?.usageLabel, maxTokens, model, opts });
    prompts[opts?.usageLabel] = _p;
    const text = opts?.usageLabel === 'arc_create' ? CREATE
      : opts?.usageLabel === 'arc_retell' ? RETELL
        : opts?.usageLabel === 'arc_panel' ? panelReply
          : 'ISSUE: x → CHANGE: y';
    return { text, usage: { output_tokens: 10 }, stop_reason: 'end_turn', modelId: 'mock', truncation: null };
  };
  // The hint pass runs once the round loop is done, re-told or not; the next
  // cancellation check is the one in front of the beats plan.
  const stop = new Error('stop after the arc');
  const checkCancellation = async () => {
    if (calls.some(c => c.label === 'arc_hints')) throw stop;
  };
  const events: { level: string; key: string; msg: string; data: any }[] = [];
  const genLog = {
    info: (key: string, msg: string, _x: any, data: any) => events.push({ level: 'info', key, msg, data }),
    warn: (key: string, msg: string, _x: any, data: any) => events.push({ level: 'warn', key, msg, data }),
    error: (key: string, msg: string, _x: any, data: any) => events.push({ level: 'error', key, msg, data }),
    debug: () => {},
  };
  const { generateStoryViaBeats } = require('../../server/lib/beatsPipeline.js');
  const inputData = {
    language: 'en', languageLevel: 'standard', ageRange: '4-6', pages: 4, storyType: 'adventure',
    characters: [{ id: 1, name: 'Mila', age: 5, gender: 'female', isMainCharacter: true }],
  };
  await expect(generateStoryViaBeats(inputData, { checkCancellation, genLog })).rejects.toBe(stop);
  return { calls, prompts, events };
}

describe('arc machine — create and retell effort', () => {
  it('pins the owner decision: create max, retell medium', () => {
    expect(MODEL_DEFAULTS.arcCreateEffort).toBe('high');
    expect(MODEL_DEFAULTS.arcRetellEffort).toBe('medium');
  });

  it('sends arcCreateEffort on arc_create and arcRetellEffort on arc_retell, uncapped', async () => {
    const { calls, prompts } = await runArc(PANEL_MAJOR);

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

describe('arc machine — the re-tell gate (owner, 2026-09-25)', () => {
  it('no quoted MAJOR or CRITICAL: the panel runs, the re-telling does not, and the log says why', async () => {
    const { calls, events } = await runArc(PANEL_MINOR);
    expect(calls.filter(c => c.label === 'arc_panel').length).toBeGreaterThan(0);
    expect(calls.filter(c => c.label === 'arc_retell')).toHaveLength(0);
    const skipped = events.find(e => e.key === 'arc_retell_skipped');
    expect(skipped?.data?.reason).toBe('no MAJOR');
    expect(events.find(e => e.key === 'beats_arc')?.msg).toMatch(/re-telling skipped: no MAJOR/);
  }, 30000);

  it('a quoted MAJOR: the re-telling runs and is handed that finding alone — no MINOR, no critique MINOR', async () => {
    const { calls, prompts } = await runArc(PANEL_MAJOR);
    expect(calls.filter(c => c.label === 'arc_retell')).toHaveLength(1);
    const retell = prompts.arc_retell;
    expect(retell).toContain('ISSUE [MAJOR] s2 "The child returns it"');
    expect(retell).not.toContain('ISSUE [MINOR]');
    // The create critique's MINOR fault is not handed over either.
    expect(retell).not.toContain('the ending is quiet');
    // The arc arrives without its critique.
    expect(retell).toContain('2. The child returns it.');
  }, 30000);

  it('a panel finding without a severity tag is dropped as a parse error and logged', async () => {
    const { calls, events } = await runArc('1. ISSUE s2 "The child returns it" — CAUSE: untagged.');
    expect(calls.filter(c => c.label === 'arc_retell')).toHaveLength(0);
    const w = events.find(e => e.key === 'arc_panel_untagged');
    expect(w?.level).toBe('warn');
    expect(w?.data?.untagged).toEqual(['1. ISSUE s2 "The child returns it" — CAUSE: untagged.']);
  }, 30000);
});
