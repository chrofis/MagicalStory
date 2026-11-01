import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { createOwnStoryChecker, nextOwnStoryTip, OWN_STORY_DEBOUNCE_MS, OWN_STORY_MIN_CHARS, OWN_STORY_PARTS } from '../../client/src/utils/ownStoryCheck';
// @ts-ignore CommonJS
import server from '../../server/lib/ownStoryAnalysis';

const LONG = 'A girl and her grandfather set out in a rowing boat to look for a lost balloon on the lake.';
const result = { present: { WHO: true, WHERE: true, PROBLEM: false, WANT: true, ENDING: false }, missing: ['PROBLEM', 'ENDING'], thin: [], unsuitable: false, tooManyEvents: false } as any;
const BOOK = { pages: 10, languageLevel: 'standard' };

describe('createOwnStoryChecker (debounce + trigger)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const make = () => {
    const analyse = vi.fn(async (_t: string, _a: any, _s: AbortSignal, _b: any) => result);
    const onResult = vi.fn();
    const onError = vi.fn();
    return { analyse, onResult, onError, c: createOwnStoryChecker({ analyse, onResult, onError }) };
  };

  it('asks once, 5 s after the last keystroke', async () => {
    const { analyse, c } = make();
    c.update(LONG, 5, BOOK);
    await vi.advanceTimersByTimeAsync(OWN_STORY_DEBOUNCE_MS - 1);
    expect(analyse).not.toHaveBeenCalled();
    c.update(LONG + ' And', 5, BOOK);              // keystroke restarts the wait
    await vi.advanceTimersByTimeAsync(OWN_STORY_DEBOUNCE_MS - 1);
    expect(analyse).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(analyse).toHaveBeenCalledTimes(1);
    expect(analyse.mock.calls[0][0]).toBe(LONG + ' And');
    expect(analyse.mock.calls[0][1]).toBe(5);
    expect(analyse.mock.calls[0][3]).toEqual(BOOK);   // the chosen book rides with the text
  });

  it('does not ask for a text under the minimum, and clears a shown result', async () => {
    const { analyse, onResult, c } = make();
    c.update('x'.repeat(OWN_STORY_MIN_CHARS - 1), 5, BOOK);
    await vi.advanceTimersByTimeAsync(OWN_STORY_DEBOUNCE_MS * 2);
    expect(analyse).not.toHaveBeenCalled();
    expect(onResult).toHaveBeenLastCalledWith(null);
  });

  it('does not ask again when text and age are unchanged since the last answer', async () => {
    const { analyse, onResult, c } = make();
    c.update(LONG, 5, BOOK);
    await vi.advanceTimersByTimeAsync(OWN_STORY_DEBOUNCE_MS);
    expect(onResult).toHaveBeenCalledWith(result);
    c.update(LONG, 5, BOOK);
    await vi.advanceTimersByTimeAsync(OWN_STORY_DEBOUNCE_MS * 2);
    expect(analyse).toHaveBeenCalledTimes(1);
    c.update(LONG, 6, BOOK);                        // age changed -> ask again
    await vi.advanceTimersByTimeAsync(OWN_STORY_DEBOUNCE_MS);
    expect(analyse).toHaveBeenCalledTimes(2);
  });

  it('aborts a stale request and ignores its answer when the text moves on', async () => {
    let resolveFirst: (r: any) => void = () => {};
    const signals: AbortSignal[] = [];
    const analyse = vi.fn((_t: string, _a: any, signal: AbortSignal, _b: any) => {
      signals.push(signal);
      return signals.length === 1 ? new Promise<any>(r => { resolveFirst = r; }) : Promise.resolve(result);
    });
    const onResult = vi.fn();
    const c = createOwnStoryChecker({ analyse, onResult });
    c.update(LONG, 5, BOOK);
    await vi.advanceTimersByTimeAsync(OWN_STORY_DEBOUNCE_MS);
    c.update(LONG + ' more', 5, BOOK);             // first request still in flight
    expect(signals[0].aborted).toBe(true);
    resolveFirst({ ...result, missing: [] });
    await vi.advanceTimersByTimeAsync(OWN_STORY_DEBOUNCE_MS);
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith(result);
  });

  it('reports a failed request and cancel() stops a pending one', async () => {
    const analyse = vi.fn(async (): Promise<any> => { throw new Error('boom'); });
    const onError = vi.fn();
    const c = createOwnStoryChecker({ analyse, onResult: vi.fn(), onError });
    c.update(LONG, 5, BOOK);
    await vi.advanceTimersByTimeAsync(OWN_STORY_DEBOUNCE_MS);
    expect(onError).toHaveBeenCalledTimes(1);
    c.update(LONG + ' x', 5, BOOK);
    c.cancel();
    await vi.advanceTimersByTimeAsync(OWN_STORY_DEBOUNCE_MS * 2);
    expect(analyse).toHaveBeenCalledTimes(1);
  });
});

describe('server flags (ownStoryAnalysis)', () => {
  const answers = (p: Record<string, number>) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, { noul: v }]));

  it('turns probabilities into typed present/missing flags at 0.5', () => {
    const f = server.flagsFromAnswers(answers({ WHO: 0.9, WHERE: 0.2, PROBLEM: 0.5, WANT: 0.49, ENDING: 0.1, UNSUITABLE: 0.7, TOO_MANY_EVENTS: 0.5 }));
    expect(f.present).toEqual({ WHO: true, WHERE: false, PROBLEM: true, WANT: false, ENDING: false });
    expect(f.missing).toEqual(['WHERE', 'WANT', 'ENDING']);
    expect(f.unsuitable).toBe(true);
    expect(f.tooManyEvents).toBe(true);
    expect(f.missing).not.toContain('TOO_MANY_EVENTS');   // a hint, not a missing part
    expect(server.flagsFromAnswers(answers({ WHO: 1, WHERE: 1, PROBLEM: 1, WANT: 1, ENDING: 1, UNSUITABLE: 0, TOO_MANY_EVENTS: 0.49 })).tooManyEvents).toBe(false);
  });

  it('client and server agree on the closed list of parts and the minimum length', () => {
    expect([...OWN_STORY_PARTS]).toEqual(server.OWN_STORY_PARTS);
    expect(OWN_STORY_MIN_CHARS).toBe(server.OWN_STORY_MIN_CHARS);
  });

  it('asks every question of the prompt file, with the age filled in, and refuses short texts', async () => {
    const q = server.questionSet(7, { pages: 10, languageLevel: 'standard' });
    expect(Object.keys(q)).toEqual([...server.OWN_STORY_PARTS, 'WHO_DEPTH', 'WHERE_DEPTH', 'UNSUITABLE', 'TOO_MANY_EVENTS']);   // 10 pages: one problem is enough, PROBLEM_DEPTH is not asked
    expect(q.UNSUITABLE.instructions).toContain('aged 7');
    const callImpl = vi.fn(async () => ({ answers: answers({ WHO: 1, WHERE: 1, PROBLEM: 1, WANT: 1, ENDING: 1, UNSUITABLE: 0, TOO_MANY_EVENTS: 0 }), cost: 0.0001, usage: {}, model: 'm' }));
    const r = await server.analyseOwnStory(LONG, 7, { pages: 10, languageLevel: 'standard' }, { callImpl });
    expect(r.missing).toEqual([]);
    expect(r.costUsd).toBe(0.0001);
    await expect(server.analyseOwnStory('too short', 7, { pages: 10 }, { callImpl })).rejects.toThrow();
    expect(callImpl).toHaveBeenCalledTimes(1);
  });

  it('the TOO_MANY_EVENTS question names the arc own event budget for that page count and age (one source)', () => {
    // @ts-ignore CommonJS
    const PB = require('../../server/lib/promptBuilders');
    for (const [age, pages, level] of [[5, 10, 'standard'], [5, 18, 'standard'], [8, 10, 'standard'], [8, 18, '1st-grade'], [10, 24, 'advanced'], [3, 12, 'standard']] as const) {
      const hi = PB.arcEventRange({ languageLevel: level, characters: [{ age, isMain: true }] }, pages).hi;
      const text = server.questionSet(age, { pages, languageLevel: level }).TOO_MANY_EVENTS.instructions;
      expect(text, `${age}/${pages}/${level}`).toContain(`more than ${hi} separate events`);
      expect(text).toContain(`${pages} pages`);
      expect(text).not.toMatch(/\{[A-Z]+\}/);          // no placeholder left unfilled
    }
    expect(() => server.questionSet(7, {})).toThrow(/pages/);
  });
});

describe('depth flags (own story, 2026-11-01)', () => {
  const answers = (p: Record<string, number>) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, { noul: v }]));
  const ALL = { WHO: 1, WHERE: 1, PROBLEM: 1, WANT: 1, ENDING: 1, UNSUITABLE: 0, TOO_MANY_EVENTS: 0 };

  it('a named part whose depth is missing counts as not done and is listed as thin', () => {
    const f = server.flagsFromAnswers(answers({ ...ALL, WHO_DEPTH: 0.2, WHERE_DEPTH: 0.5, PROBLEM_DEPTH: 0.49 }));
    expect(f.present).toEqual({ WHO: false, WHERE: true, PROBLEM: false, WANT: true, ENDING: true });
    expect(f.missing).toEqual(['WHO', 'PROBLEM']);
    expect(f.thin).toEqual(['WHO', 'PROBLEM']);
  });

  it('a part that is not named at all is missing but not thin; its depth answer is ignored', () => {
    const f = server.flagsFromAnswers(answers({ ...ALL, WHERE: 0.1, WHERE_DEPTH: 0.9, WHO_DEPTH: 1, PROBLEM_DEPTH: 1 }));
    expect(f.missing).toEqual(['WHERE']);
    expect(f.thin).toEqual([]);
    const g = server.flagsFromAnswers(answers({ ...ALL, WHERE: 0.1, WHERE_DEPTH: 0.1, WHO_DEPTH: 1, PROBLEM_DEPTH: 1 }));
    expect(g.thin).toEqual([]);                      // absent beats thin: the "say it" tip comes first
  });

  it('a depth question that was not asked (short book) leaves the part satisfied', () => {
    const f = server.flagsFromAnswers(answers({ ...ALL, WHO_DEPTH: 1, WHERE_DEPTH: 1 }));
    expect(f.missing).toEqual([]);
    expect(f.thin).toEqual([]);
  });

  it('PROBLEM_DEPTH is asked only when the page count wants two or more problems, with the number filled in', () => {
    expect(server.problemsWanted(10)).toBe(1);
    expect(server.problemsWanted(13)).toBe(1);
    expect(server.problemsWanted(14)).toBe(2);
    expect(server.problemsWanted(20)).toBe(2);
    expect(server.problemsWanted(28)).toBe(3);
    expect(() => server.problemsWanted(0)).toThrow(/pages/);
    expect(server.questionSet(7, { pages: 10 })).not.toHaveProperty('PROBLEM_DEPTH');
    const q = server.questionSet(7, { pages: 20 });
    expect(q.PROBLEM_DEPTH.instructions).toContain('at least 2 separate problems');
    expect(server.questionSet(7, { pages: 30 }).PROBLEM_DEPTH.instructions).toContain('at least 3 separate problems');
    for (const id of Object.keys(q)) expect(q[id].instructions, id).not.toMatch(/\{[A-Z]+\}/);
  });

  it('each depth flag belongs to one of the five parts and has a question in the prompt file', () => {
    expect(Object.keys(server.DEPTH_FLAGS).every((p: string) => server.OWN_STORY_PARTS.includes(p))).toBe(true);
    const q = server.questionSet(7, { pages: 20 });
    for (const flag of Object.values(server.DEPTH_FLAGS)) expect(q).toHaveProperty(flag as string);
  });

  it('tip choice: the first missing part, depth tip only when that part is thin', () => {
    expect(nextOwnStoryTip({ missing: [], thin: [] })).toBeNull();
    expect(nextOwnStoryTip({ missing: ['WHERE', 'ENDING'], thin: [] })).toEqual({ part: 'WHERE', kind: 'say' });
    expect(nextOwnStoryTip({ missing: ['WHO', 'ENDING'], thin: ['WHO'] })).toEqual({ part: 'WHO', kind: 'depth' });
    expect(nextOwnStoryTip({ missing: ['WHERE', 'PROBLEM'], thin: ['PROBLEM'] })).toEqual({ part: 'WHERE', kind: 'say' });
  });

  it('every depth tip exists in de, fr, it and en, and Swiss German never uses the eszett', () => {
    const src = readFileSync('client/src/pages/wizard/OwnStoryCard.tsx', 'utf-8');
    const block = src.slice(src.indexOf('const DEPTH_TIPS'), src.indexOf('/** Fixed hint when the text holds more'));
    const sections = block.split(/\n  (?=WHO:|WHERE:|PROBLEM:)/).slice(1);
    expect(sections.map(x => x.split(':')[0])).toEqual(['WHO', 'WHERE', 'PROBLEM']);
    for (const sec of sections) for (const lang of ['de', 'fr', 'it', 'en']) expect(sec, `${sec.slice(0, 8)}/${lang}`).toMatch(new RegExp(`\n    ${lang}: '`));
    expect(block).not.toContain('ß');
  });
});
