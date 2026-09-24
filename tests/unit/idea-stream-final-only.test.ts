import { describe, it, expect } from 'vitest';
import path from 'path';

const ROOT = path.resolve(__dirname, '../..');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-unit-tests-only';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { streamIdeaArm, parseIdeaFinal } = require(path.join(ROOT, 'server/routes/storyIdeas'));

// A fake streaming model: feeds the response to onDelta in chunks, then resolves.
const fakeStreaming = (response: string, { fail = false } = {}) =>
  (_prompt: string, _sys: unknown, onDelta: (d: string, full: string) => void) => {
    let full = '';
    for (let i = 0; i < response.length; i += 40) {
      const d = response.slice(i, i + 40);
      full += d;
      onDelta(d, full);
    }
    return fail ? Promise.reject(new Error('boom')) : Promise.resolve({ usage: { input_tokens: 1 }, modelId: 'm' });
  };

const fakeRes = () => {
  const writes: string[] = [];
  return { writes, write: (s: string) => { writes.push(s); return true; } };
};
const dataEvents = (writes: string[]) =>
  writes.filter(w => w.startsWith('data: ')).map(w => JSON.parse(w.slice(6)));

const DRAFT = '[DRAFT]\nA first go at the idea with a lot of words in it. '.repeat(10);
const REVIEW = '[REVIEW]\n1. Language: fine. 2. The contract: the [FINAL] must fix the hook. '.repeat(10);
const FINAL = 'Mia finds a lantern that hums at night.';

describe('idea stream sends only the final idea (2026-09-24)', () => {
  it('never writes draft or review text; one data event with the [FINAL] section', async () => {
    const res = fakeRes();
    const out = await streamIdeaArm({ arm: 0, prompt: 'p', res, callStreaming: fakeStreaming(`${DRAFT}\n${REVIEW}\n[FINAL]\n${FINAL}`), model: 'm' });
    const events = dataEvents(res.writes);
    expect(events).toEqual([{ story1: FINAL, isFinal: true }]);
    expect(res.writes.join('')).not.toMatch(/\[DRAFT\]|\[REVIEW\]|first go/);
    // keep-alive comments were sent while the call ran
    expect(res.writes.some(w => w.startsWith(':'))).toBe(true);
    expect(out.fullText).toContain('[DRAFT]');
    expect(out.usage).toEqual({ input_tokens: 1 });
  });

  it('arm 2 uses the story2 key', async () => {
    const res = fakeRes();
    await streamIdeaArm({ arm: 1, prompt: 'p', res, callStreaming: fakeStreaming(`[FINAL]\n${FINAL}`), model: 'm' });
    expect(dataEvents(res.writes)).toEqual([{ story2: FINAL, isFinal: true }]);
  });

  it('a response without [FINAL] sends an error, never the raw text', async () => {
    const res = fakeRes();
    await streamIdeaArm({ arm: 0, prompt: 'p', res, callStreaming: fakeStreaming(`${DRAFT}\n[REVIEW]\nLanguage fine.`), model: 'm' });
    const events = dataEvents(res.writes);
    expect(events).toHaveLength(1);
    expect(events[0].error).toBeTruthy();
    expect(events[0].story1).toBeUndefined();
  });

  it('a failed call sends an error event and resolves', async () => {
    const res = fakeRes();
    const out = await streamIdeaArm({ arm: 0, prompt: 'p', res, callStreaming: fakeStreaming(DRAFT, { fail: true }), model: 'm' });
    expect(dataEvents(res.writes)).toEqual([{ error: 'Failed to generate story idea 1' }]);
    expect(out.usage).toBeNull();
  });

  it('parseIdeaFinal takes the LAST [FINAL] marker', () => {
    expect(parseIdeaFinal(`${REVIEW}\n[FINAL]\n${FINAL}`)).toBe(FINAL);
    expect(parseIdeaFinal('no marker')).toBeNull();
    expect(parseIdeaFinal('[FINAL]   ')).toBeNull();
  });
});
