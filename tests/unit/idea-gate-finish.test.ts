/**
 * The trial idea's Jev gate and its one rerun (trialIdeaCheck.finishIdeaCard,
 * docs/decisions.md 2026-10-10): a tripwire or a score under the 15%-budget
 * threshold sends the card back ONCE with the reason fed to the generator; a card
 * above passes untouched; a Jev outage logs an error and ships the card un-gated;
 * a card failing its own CHECK reruns without a Jev call; never a second rerun.
 */
import { describe, it, expect } from 'vitest';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-unit-tests-only';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const T = require('../../server/lib/trialIdeaCheck');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const R = require('../../server/lib/ideaJevRubric');

const card = (s1: string, s2: string, s3: string) =>
  `${s1} ${s2} ${s3}\nCHECK\nWANT: ${s1}\nEVENT: ${s1}\nUSES: NONE\nACT: ${s2}\nRESULT: ${s3}`;
const GOOD = card('Mia will hike.', 'Mia climbs the hill.', 'Mia arrives.');
const GOOD2 = card('Ben will swim.', 'Ben crosses the lake.', 'Ben arrives.');
const ctx = { age: 8, topic: 'screen-time', theme: 'superhero' };

/** A Jev reply for the adopted request: every question at `want`, individual ids overridden. */
function reply(rq: any, want: number, over: Record<string, number> = {}) {
  const answers: any = {};
  for (const [k, q] of Object.entries<any>(rq.questions)) {
    const [id, ph] = k.split('__');
    const def = R.RUBRIC[id][ph];
    const w = id in over ? over[id] : want;
    if (q.type === 'noul') answers[k] = { type: 'noul', noul: def.invert ? 1 - w : w };
    else if (q.type === 'score') answers[k] = { type: 'score', score: 4 * w };
    else answers[k] = { type: 'choice', probabilities: { [def.good[0]]: w } };
  }
  return { answers, cost: 0.00004 };
}
const judgeWith = (want: number, over: Record<string, number> = {}) => (idea: string, c: any) =>
  R.judgeIdeaRubric(idea, c, { callImpl: async (rq: any) => reply(rq, want, over) });

function harness(opts: { first: string; second?: string; judges: Array<(i: string, c: any) => Promise<any>> }) {
  const prompts: string[] = []; const errors: string[] = []; let j = 0;
  const run = () => T.finishIdeaCard({
    firstText: opts.first, basePrompt: 'BASE', ctx,
    rerunCall: async (p: string) => { prompts.push(p); return opts.second ?? GOOD2; },
    judgeImpl: (i: string, c: any) => opts.judges[Math.min(j++, opts.judges.length - 1)](i, c),
    log: { warn: () => {}, info: () => {}, error: (m: string) => errors.push(m) },
  });
  return { run, prompts, errors };
}

describe('finishIdeaCard', () => {
  it('a card above the threshold with no tripwire is not rerun', async () => {
    const h = harness({ first: GOOD, judges: [judgeWith(0.95)] });
    const r = await h.run();
    expect(r.rerun).toBe(false);
    expect(r.parsed.idea).toContain('Mia');
    expect(r.finalGate.ok).toBe(true);
    expect(h.prompts).toHaveLength(0);
  });

  it.each([
    ['NO_COMMENTARY', 'rubric-tripwire-no_commentary'],
    ['AGE_FIT', 'rubric-tripwire-age_fit'],
    ['THEME', 'rubric-tripwire-theme'],
  ])('tripwire %s reruns once with the reason fed back', async (id, failure) => {
    const h = harness({ first: GOOD, judges: [judgeWith(0.95, { [id]: 0.1 }), judgeWith(0.95)] });
    const r = await h.run();
    expect(r.rerun).toBe(true);
    expect(r.rerunReason).toBe(failure);
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]).toContain(R.RUBRIC_FEEDBACK[failure]);
    expect(h.prompts[0]).toContain('Mia will hike');
    expect(r.parsed.idea).toContain('Ben');
  });

  it('a score below the gate reruns once with the low-score reason', async () => {
    const h = harness({ first: GOOD, judges: [judgeWith(0.55), judgeWith(0.95)] });
    const r = await h.run();
    expect(r.firstGate.failure).toBe('rubric-low-score');
    expect(r.firstGate.score).toBeLessThan(R.RUBRIC_GATE.flagBelow);
    expect(r.rerun).toBe(true);
    expect(h.prompts[0]).toContain(R.RUBRIC_FEEDBACK['rubric-low-score']);
  });

  it('never a second rerun: a rerun that scores low again is the answer', async () => {
    const h = harness({ first: GOOD, judges: [judgeWith(0.55)] });
    const r = await h.run();
    expect(h.prompts).toHaveLength(1);
    expect(r.finalGate.ok).toBe(false);
    expect(r.parsed.idea).toContain('Ben');
  });

  it('a Jev error logs an error and ships the card un-gated, no rerun', async () => {
    const h = harness({ first: GOOD, judges: [async () => { throw new Error('HTTP 500'); }] });
    const r = await h.run();
    expect(r.rerun).toBe(false);
    expect(r.firstGate.error).toBe('HTTP 500');
    expect(r.parsed.idea).toContain('Mia');
    expect(h.errors.join()).toMatch(/ships un-gated: HTTP 500/);
  });

  it('a missing age is a logged error and an un-gated card, never a Jev call', async () => {
    const errors: string[] = [];
    const r = await T.finishIdeaCard({
      firstText: GOOD, basePrompt: 'B', ctx: { age: NaN }, rerunCall: async () => GOOD2,
      judgeImpl: () => { throw new Error('called'); }, log: { warn() {}, info() {}, error: (m: string) => errors.push(m) },
    });
    expect(r.rerun).toBe(false);
    expect(errors.join()).toMatch(/no age/);
  });

  it('a card failing its own CHECK reruns without a Jev call on the first card', async () => {
    const bad = 'Mia will hike. Mia climbs the hill. Mia arrives.\nCHECK\nWANT: Mia will hike\nEVENT: Mia will hike\nUSES: NONE\nACT: NONE\nRESULT: Mia arrives';
    let calls = 0;
    const h = harness({ first: bad, judges: [async (i, c) => { calls++; return judgeWith(0.95)(i, c); }] });
    const r = await h.run();
    expect(r.rerun).toBe(true);
    expect(r.rerunReason).toBe('no-act');
    expect(r.firstGate).toBeNull();
    expect(calls).toBe(1); // only the rerun card is scored, for the record
  });

  it('a malformed rerun throws, as the self-check rerun always did', async () => {
    const h = harness({ first: GOOD, second: 'no check block', judges: [judgeWith(0.55)] });
    await expect(h.run()).rejects.toThrow(/no CHECK block/);
  });
});

describe('ideaGateContext', () => {
  it('topic only for a life challenge; age parsed', () => {
    expect(T.ideaGateContext({ storyCategory: 'life-challenge', storyTopic: 'screen-time', storyTheme: 'pirate', age: '7' })).toEqual({ age: 7, topic: 'screen-time', theme: 'pirate' });
    expect(T.ideaGateContext({ storyCategory: 'adventure', storyTopic: 'x', storyTheme: 'pirate', age: 7 }).topic).toBe('');
  });
});
