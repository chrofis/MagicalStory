/**
 * A styled sheet that hard-fails an axis gets ONE extra attempt whose prompt names
 * that axis with the judge's own reading (2026-10-09). Stored evidence: staging
 * job_1791531449494_o0kaatvmq - Julian background 3/10 (two adult strangers painted
 * behind the head cells; attempt 2 failed hair 1/10) and Levin hair 1/10 on both
 * attempts (light blonde declared, ginger-brown painted); both shipped best-of-2.
 * Measured over 442 judged styled sheets (60 days): 11 shipped at or below 3/10.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const sheetMod = require('../../server/lib/character2x4Sheet');
const { hardFailFeedback, buildFedBackPrompt, stampVerdict, SHEET_HARD_FAIL_MAX } = sheetMod._internal;
const SRC = fs.readFileSync(path.join(__dirname, '../../server/lib/character2x4Sheet.js'), 'utf8');

function extractFunction(src: string, name: string): string {
  const start = src.indexOf(`async function ${name}(`);
  let p = src.indexOf('(', start);
  let d = 0;
  for (; p < src.length; p++) {
    if (src[p] === '(') d++;
    else if (src[p] === ')') { d--; if (d === 0) { p++; break; } }
  }
  let i = src.indexOf('{', p);
  d = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') d++;
    else if (src[i] === '}') { d--; if (d === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

// Stored verdict shapes (reasons copied from the story).
const JULIAN = {
  backgroundScore: 3, hairScore: 10, soloScore: 9, identityScore: 9, styleScore: 9,
  background: { score: 3, reason: 'The top row of Image 3 has two adult figures painted in the background behind the child, which is a defect.' },
  hair: { score: 10, perCell: { cell1: 'match' } }, valid: false, finalScore: 3, failureReasons: ['backgroundScore'],
};
const LEVIN = {
  hairScore: 1, backgroundScore: 10, identityScore: 9,
  hair: { score: 1, reason: 'heads: cell1: ... | bodies: ...', perCell: { cell1: 'differs', cell2: 'differs', cell3: 'differs', cell4: 'differs', cell5: 'match' } },
  valid: false, finalScore: 1,
};

describe('hardFailFeedback', () => {
  it('names the failed axis with the judge reading (Julian background)', () => {
    const lines = hardFailFeedback(JULIAN, {});
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('background:');
    expect(lines[0]).toContain('plain blank paper');
    expect(lines[0]).toContain('two adult figures painted in the background');
  });
  it('states the DECLARED hair and the flagged cells (Levin hair)', () => {
    const lines = hardFailFeedback(LEVIN, { hair: 'Hair color: light blonde.' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Cells 1, 2, 3, 4 showed other hair');
    expect(lines[0]).toContain('Hair color: light blonde.');
  });
  it('is empty when no axis is at or below the hard-fail line', () => {
    expect(hardFailFeedback({ ...JULIAN, backgroundScore: SHEET_HARD_FAIL_MAX + 1, background: { score: 4, reason: 'x' } }, {})).toEqual([]);
    expect(hardFailFeedback(null, {})).toEqual([]);
  });
  it('appends the lines to the base prompt, and leaves it alone without them', () => {
    expect(buildFedBackPrompt('BASE', [])).toBe('BASE');
    expect(buildFedBackPrompt('BASE', ['a: b'])).toMatch(/^BASE\n\nTHE PREVIOUS ATTEMPT WAS REJECTED[\s\S]*- a: b$/);
  });
});

describe('stampVerdict keeps the axis reason when the judge wrote only a field name', () => {
  it('Julian: failureReasons ["backgroundScore"] gains "background: <reason>"', () => {
    const report: any = { ...JULIAN, failureReasons: ['backgroundScore'] };
    stampVerdict(report, { final: 3, failing: ['background'] });
    expect(report.failureReasons).toContain(`background: ${JULIAN.background.reason}`);
  });
  it('does not duplicate a reason that already names the axis', () => {
    const report: any = { failureReasons: ['hair: cell1 differs'] };
    stampVerdict(report, { final: 1, failing: ['hair'] });
    expect(report.failureReasons).toEqual(['hair: cell1 differs']);
  });
});

async function runPass2(verdicts: any[], { promptOverride = null }: { promptOverride?: string | null } = {}) {
  const prompts: string[] = [];
  let i = 0;
  const ctx: any = {
    module: { exports: {} },
    log: { info() {}, warn() {}, debug() {}, error() {} },
    MAX_SHEET_RETRIES: 1, SHEET_VALID_MIN: 6, STYLED_IDENTITY_AXES: ['identity', 'solo'],
    SHEET_HARD_FAIL_MAX, hardFailFeedback, buildFedBackPrompt,
    MODEL_DEFAULTS: { avatarStyleTransferBackend: 'grok' },
    process: { env: { GEMINI_API_KEY: 'k' } },
    loadStyleAnchor: () => 'ANCHOR',
    buildStyleTransferPrompt: () => 'BASE PROMPT',
    styleTransferGenerate: async (prompt: string) => {
      prompts.push(prompt);
      return { imageData: `IMG${prompts.length}`, provider: 'grok', modelId: 'm', usage: null };
    },
    quickLayoutCheck: async () => ({ valid: true }),
    evaluateAvatarSheet: async () => ({ verdict: verdicts[Math.min(i++, verdicts.length - 1)] }),
    require: () => ({ MODEL_PRICING: {} }),
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(`${extractFunction(SRC, 'runStyleTransferPass')}\nmodule.exports = runStyleTransferPass;`, ctx);
  const out = await ctx.module.exports({
    pass1ImageData: 'P1', facePhoto: 'F', artStyle: 'watercolor', characterName: 'T', hair: 'Hair color: light blonde.',
    usageTracker: null, skipQualityEval: false, promptOverride,
  });
  return { out, prompts };
}

const BAD2 = { ...JULIAN, finalScore: 1, hairScore: 1, backgroundScore: 9, background: { score: 9, reason: 'plain' }, hair: LEVIN.hair, failureReasons: [] };
const OK = { finalScore: 9, valid: true, failureReasons: [] };

describe('runStyleTransferPass extra fed-back attempt', () => {
  it('Julian: two rejected attempts, the best hard-fails background -> exactly ONE third attempt carrying the axis', async () => {
    const { out, prompts } = await runPass2([JULIAN, BAD2, OK]);
    expect(prompts).toHaveLength(3);
    expect(prompts[0]).toBe('BASE PROMPT');
    expect(prompts[1]).toBe('BASE PROMPT');
    expect(prompts[2]).toContain('THE PREVIOUS ATTEMPT WAS REJECTED');
    expect(prompts[2]).toContain('two adult figures painted in the background');
    expect(out.valid).toBe(true);
    expect(out.attempts[2].extraAttempt).toBe(true);
  });
  it('never a fourth attempt: a still-failing sheet ships best-of with hardFailAxes set', async () => {
    const { out, prompts } = await runPass2([JULIAN, BAD2, JULIAN, JULIAN]);
    expect(prompts).toHaveLength(3);
    expect(out.valid).toBe(false);
    expect(out.hardFailAxes).toEqual(['background']);
  });
  it('no extra attempt when the rejection is above the hard-fail line', async () => {
    const soft = { finalScore: 5, valid: false, backgroundScore: 5, background: { score: 5, reason: 'wash' }, failureReasons: ['background: wash'] };
    const { prompts, out } = await runPass2([soft, soft]);
    expect(prompts).toHaveLength(2);
    expect(out.hardFailAxes).toEqual([]);
  });
  it('no extra attempt on a Test Lab prompt override (that run measures one exact prompt)', async () => {
    const { prompts } = await runPass2([JULIAN, BAD2], { promptOverride: 'LAB PROMPT' });
    expect(prompts).toHaveLength(2);
  });
  it('a first valid attempt costs nothing extra', async () => {
    const { prompts } = await runPass2([OK]);
    expect(prompts).toHaveLength(1);
  });
});

describe('generateCharacter2x4Sheet ships hard-failed sheets loudly', () => {
  it('logs an ERROR and counts avatar_sheet_shipped_hard_fail', () => {
    expect(SRC).toContain('styled sheet SHIPPED BELOW THE BAR');
    expect(SRC).toContain("metrics.count('avatar_sheet_shipped_hard_fail')");
  });
});
