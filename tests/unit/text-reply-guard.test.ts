import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  assessTextReply, describeTruncation, noteTruncation, getTruncationStats, _resetTruncationStats,
} = require('../../server/lib/textReplyGuard.js');

const fine = (over: any = {}) => ({ text: 'A complete answer.', usage: { output_tokens: 120 }, stop_reason: 'end_turn', ...over });

describe('assessTextReply — one verdict for every provider reply', () => {
  it('clean reply: not suspected, fields carried', () => {
    const t = assessTextReply(fine({ modelId: 'claude-sonnet-4-6', provider: 'anthropic' }), { capInForce: 64000 });
    expect(t).toMatchObject({ suspected: false, reason: null, outputTokens: 120, capInForce: 64000, stopReason: 'end_turn', provider: 'anthropic', model: 'claude-sonnet-4-6' });
  });

  it('empty text is suspected (exp 1109/1121: 0 chars at the cap; #920: 0 chars, no cap hit)', () => {
    expect(assessTextReply({ text: '', usage: { output_tokens: 16000 } }, { capInForce: 16000 })).toMatchObject({ suspected: true, reason: 'empty' });
    expect(assessTextReply({ text: '  \n ', usage: { output_tokens: 3899 } }, { capInForce: 64000 }).reason).toBe('empty');
    expect(assessTextReply(null).reason).toBe('empty');
  });

  it("Anthropic stop_reason 'max_tokens' (non-stream data.stop_reason / stream message_delta.delta.stop_reason)", () => {
    const t = assessTextReply(fine({ stop_reason: 'max_tokens', usage: { output_tokens: 8192 } }), { capInForce: 64000 });
    expect(t).toMatchObject({ suspected: true, reason: 'stop_reason', stopReason: 'max_tokens' });
  });

  it("OpenAI-compatible finish_reason 'length' (xAI choices[0].finish_reason, OpenRouter stream choices[0].finish_reason)", () => {
    expect(assessTextReply(fine({ stop_reason: 'length', usage: { output_tokens: 500 } }), { capInForce: 64000 }).reason).toBe('stop_reason');
  });

  it("Gemini finishReason 'MAX_TOKENS' (candidates[0].finishReason) — thinking can eat the budget so output_tokens stays far below the cap", () => {
    const t = assessTextReply(fine({ stop_reason: 'MAX_TOKENS', usage: { output_tokens: 13, thinking_tokens: 383 } }), { capInForce: 65536 });
    expect(t).toMatchObject({ suspected: true, reason: 'stop_reason', stopReason: 'MAX_TOKENS' });
  });

  it('a normal finish reason on every provider is not suspected', () => {
    for (const stop of ['end_turn', 'stop', 'STOP', 'tool_use']) {
      expect(assessTextReply(fine({ stop_reason: stop }), { capInForce: 64000 }).suspected).toBe(false);
    }
  });

  it('output_tokens >= capInForce is suspected even without a finish reason (exp 1122/1124: cut mid-output at out=16000)', () => {
    const t = assessTextReply(fine({ stop_reason: null, usage: { output_tokens: 16000 } }), { capInForce: 16000 });
    expect(t).toMatchObject({ suspected: true, reason: 'cap_hit', outputTokens: 16000, capInForce: 16000 });
    expect(assessTextReply(fine({ stop_reason: null, usage: { output_tokens: 15999 } }), { capInForce: 16000 }).suspected).toBe(false);
  });

  it('OpenRouter stream with usage.cost but no finish reason: within 1% of the model max is suspected', () => {
    const near = fine({ stop_reason: null, provider: 'BaseTen', usage: { output_tokens: 63500, direct_cost: 0.41 } });
    expect(assessTextReply(near, { capInForce: 64000 })).toMatchObject({ suspected: true, reason: 'near_cap', provider: 'BaseTen' });
    // Same tokens WITH a finish reason of 'stop' is a long, complete reply.
    expect(assessTextReply({ ...near, stop_reason: 'stop' }, { capInForce: 64000 }).suspected).toBe(false);
    // Same tokens, no cost reported (not OpenRouter): plain cap rule applies, below the cap is fine.
    expect(assessTextReply(fine({ stop_reason: null, usage: { output_tokens: 63500 } }), { capInForce: 64000 }).suspected).toBe(false);
  });

  it('a long reply the caller could not parse is suspected; a short unparsed one is not (it may be a "no changes" verdict)', () => {
    expect(assessTextReply(fine({ text: 'x'.repeat(2500) }), { capInForce: 64000, parsedOk: false }).reason).toBe('unparsed');
    expect(assessTextReply(fine({ text: 'No changes needed.' }), { capInForce: 64000, parsedOk: false }).suspected).toBe(false);
    expect(assessTextReply(fine({ text: 'x'.repeat(2500) }), { capInForce: 64000, parsedOk: true }).suspected).toBe(false);
    expect(assessTextReply(fine({ text: 'x'.repeat(2500) }), { capInForce: 64000, parsedOk: false, minMeaningfulChars: 3000 }).suspected).toBe(false);
  });

  it('no capInForce known: only finish reason and emptiness can fire', () => {
    expect(assessTextReply(fine({ stop_reason: null, usage: { output_tokens: 999999 } })).suspected).toBe(false);
    expect(assessTextReply(fine({ stop_reason: 'length' })).suspected).toBe(true);
  });
});

describe('describeTruncation', () => {
  it('names the reason, tokens and cap', () => {
    expect(describeTruncation(assessTextReply({ text: '', usage: { output_tokens: 16000 } }, { capInForce: 16000 }))).toBe('returned an EMPTY response (16000 output tokens)');
    expect(describeTruncation(assessTextReply(fine({ stop_reason: 'max_tokens', usage: { output_tokens: 8192 } }), { capInForce: 8192 }))).toMatch(/TRUNCATED: stop_reason=max_tokens at 8192 output tokens \(cap 8192\)/);
    expect(describeTruncation(assessTextReply(fine({ stop_reason: null, usage: { output_tokens: 16000 } }), { capInForce: 16000 }))).toBe('TRUNCATED: 16000 output tokens hit the 16000-token ceiling');
    expect(describeTruncation({ suspected: false })).toBe('not truncated');
  });
});

describe('truncation counter (GET /api/health/config → textTruncation)', () => {
  beforeEach(() => _resetTruncationStats());
  it('counts by reason and label and keeps the last event with a 120-char preview', () => {
    noteTruncation(assessTextReply({ text: 'y'.repeat(500), usage: { output_tokens: 64000 }, modelId: 'deepseek/deepseek-v4-pro', provider: 'BaseTen' }, { capInForce: 64000 }), { usageLabel: 'beats_scene_review', preview: 'y'.repeat(500) });
    noteTruncation(assessTextReply({ text: '' }, {}), { usageLabel: 'beats_scene_review' });
    noteTruncation({ suspected: false }, { usageLabel: 'ignored' });
    const s = getTruncationStats();
    expect(s.suspected).toBe(2);
    expect(s.byReason).toEqual({ cap_hit: 1, empty: 1 });
    expect(s.byLabel).toEqual({ beats_scene_review: 2 });
    expect(s.last).toMatchObject({ usageLabel: 'beats_scene_review', reason: 'empty' });
  });
  it('preview is clipped to 120 chars', () => {
    noteTruncation(assessTextReply({ text: 'z'.repeat(500), usage: { output_tokens: 10 } }, { capInForce: 10 }), { usageLabel: 'l', preview: 'z'.repeat(500) });
    expect(getTruncationStats().last.preview.length).toBe(120);
  });
});

describe('textModels.js wiring (source-level) — the guard runs at the chokepoint', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../../server/lib/textModels.js'), 'utf8');
  it('both entry points default maxTokens to null (model max) and return through guardReply', () => {
    expect(src).toMatch(/async function callTextModel\(prompt, maxTokens = null,/);
    expect(src).toMatch(/async function callTextModelStreaming\(prompt, maxTokens = null,/);
    expect(src).toMatch(/async function callClaudeAPI\(prompt, maxTokens = null,/);
    expect((src.match(/return guardReply\(/g) || []).length).toBe(2);
  });
  it('every provider path captures its finish reason as stop_reason', () => {
    expect(src).toMatch(/stop_reason: data\.stop_reason \|\| null/);                      // Anthropic non-stream
    expect(src).toMatch(/if \(event\.delta\?\.stop_reason\) stopReason = event\.delta\.stop_reason;/); // Anthropic stream
    expect(src).toMatch(/stop_reason: data\.candidates\[0\]\.finishReason \|\| null/);   // Gemini non-stream
    expect(src).toMatch(/if \(event\.candidates\?\.\[0\]\?\.finishReason\) finishReason = event\.candidates\[0\]\.finishReason;/); // Gemini stream
    expect(src).toMatch(/stop_reason: data\.choices\?\.\[0\]\?\.finish_reason \|\| null/); // xAI non-stream
    expect((src.match(/if \(event\.choices\?\.\[0\]\?\.finish_reason\) finishReason = event\.choices\[0\]\.finish_reason;/g) || []).length).toBe(2); // xAI + OpenRouter streams
  });
  it('the exported module exposes the guard and the counter', () => {
    const tm = require('../../server/lib/textModels.js');
    expect(typeof tm.assessTextReply).toBe('function');
    expect(typeof tm.describeTruncation).toBe('function');
    expect(typeof tm.getTruncationStats).toBe('function');
  });
});
