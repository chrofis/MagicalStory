/**
 * Idea Jev rubric (2026-10-09, NOT wired): one Jev question per requirement of the
 * trial idea prompt plus the owner's holistic ones, and one card score. Pinned here:
 * the slot phrases are verbatim from prompts/trial-idea.txt and the topic /
 * inserted-act phrases are the generator's own constants (generator <-> critic),
 * the request shape, how each answer mode becomes P(good), the weighted score,
 * the tripwires, and that a Jev outage throws.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-unit-tests-only';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const R = require('../../server/lib/ideaJevRubric');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const co = require('../../server/lib/ideaCoherence');

const ROOT = path.resolve(__dirname, '../..');
const prompt = fs.readFileSync(path.join(ROOT, 'prompts/trial-idea.txt'), 'utf8');
const ctx = { age: 8, topic: 'screen-time', theme: 'superhero' };

/** A Jev reply that answers every asked question as a card Jev likes would (a defect statement gets a low P(yes)); `bad` overrides. */
function reply(rq: any, { good = true, bad = {} as Record<string, number> } = {}) {
  const answers: any = {};
  for (const [k, q] of Object.entries<any>(rq.questions)) {
    const [id, ph] = k.split('__');
    const def = R.RUBRIC[id][ph];
    const want = k in bad ? bad[k] : good ? 0.9 : 0.5;
    if (q.type === 'noul') answers[k] = { type: 'noul', noul: def.invert ? 1 - want : want };
    else if (q.type === 'score') answers[k] = { type: 'score', score: 4 * want };
    else {
      const goodKey = def.good[0]; const other = Object.keys(q.criteria).find(o => !def.good.includes(o))!;
      answers[k] = { type: 'choice', probabilities: { [goodKey]: want, [other]: 1 - want } };
    }
  }
  return { answers, cost: 0.00004 };
}

describe('generator <-> critic wording', () => {
  it('the slot phrases occur verbatim in the trial idea prompt', () => {
    for (const phrase of [R.SLOT1_PHRASE, R.SLOT2_PHRASE, R.SLOT3_PHRASE, R.NAMED_IN_1_PHRASE]) {
      expect(prompt).toContain(phrase);
    }
  });
  it('the topic and inserted-act questions use the coherence module constants', () => {
    expect(R.RUBRIC.TOPIC_ACT.A.q()).toContain(co.COMMISSIONED_ACT_PHRASE);
    expect(R.RUBRIC.FOLLOWS.A.q()).toContain(co.INSERTED_ACT_PHRASE);
    expect(R.RUBRIC.FORCED.A.q()).toContain(co.COMMISSIONED_ACT_PHRASE);
  });
  it('no question asks for resolution, an introduction or one world (owner scope)', () => {
    const rq = R.buildAdoptedRequest('Idee.', ctx);
    for (const q of Object.values<any>(rq.questions)) expect(JSON.stringify(q)).not.toMatch(/introduc|one world|same world|resolve|settle|stays open/i);
    expect(Object.keys(rq.questions).some(k => k.startsWith('SETTLES'))).toBe(false);
  });
});

describe('request', () => {
  it('state names the age, the commissioned thing, the theme and the idea; no topic line for an adventure', () => {
    const s = R.buildRubricState('Idee.', ctx);
    expect(s).toContain('aged 8');
    expect(s).toContain('screen time');
    expect(s).toContain('superhero');
    expect(s).toContain('Idee.');
    expect(R.buildRubricState('Idee.', { age: 5 }).toLowerCase()).not.toContain(co.COMMISSIONED_ACT_PHRASE);
  });
  it('topic and theme questions are asked only when the card has them', () => {
    expect(R.applicableIds({ age: 5 }, ['TOPIC_ACT', 'THEME', 'FOLLOWS'])).toEqual(['FOLLOWS']);
    expect(R.applicableIds(ctx, ['TOPIC_ACT', 'THEME', 'FOLLOWS'])).toEqual(['TOPIC_ACT', 'THEME', 'FOLLOWS']);
  });
  it('the adopted request is one call: scored questions plus tripwires, each key once', () => {
    const rq = R.buildAdoptedRequest('Idee.', ctx);
    const keys = Object.keys(rq.questions);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(expect.arrayContaining(['FORCED__B', 'FOLLOWS__A', 'NO_COMMENTARY__A', 'AGE_FIT__S', 'THEME__B']));
    expect(keys.length).toBeLessThanOrEqual(12);
  });
  it('an adventure card drops the topic and theme questions', () => {
    const keys = Object.keys(R.buildAdoptedRequest('Idee.', { age: 5 }).questions);
    expect(keys).not.toContain('FORCED__B');
    expect(keys).not.toContain('THEME__B');
    expect(keys).toContain('FOLLOWS__A');
  });
  it('asking for a phrasing a question lacks throws', () => {
    expect(() => R.buildRubricRequest('x', ctx, { THEME: 'S' })).toThrow(/no phrasing S/);
  });
});

describe('answers -> P(good)', () => {
  it('a statement is P(yes), a defect statement is 1 - P(yes)', () => {
    expect(R.goodProbability({ noul: 0.8 }, R.RUBRIC.FOLLOWS.A)).toBeCloseTo(0.8);
    expect(R.goodProbability({ noul: 0.8 }, R.RUBRIC.FOLLOWS.B)).toBeCloseTo(0.2);
  });
  it('a score is the mean over 0..4', () => {
    expect(R.goodProbability({ score: 3 }, R.RUBRIC.KID_ENJOY.S)).toBeCloseTo(0.75);
  });
  it('a choice is the summed probability of the good options', () => {
    const p = R.goodProbability({ probabilities: { own: 0.5, with_helper: 0.25, chance: 0.25 } }, R.RUBRIC.AGENCY.C);
    expect(p).toBeCloseTo(0.75);
  });
  it('a wrong answer shape throws instead of reading as 0', () => {
    expect(() => R.goodProbability({ score: 2 }, R.RUBRIC.FOLLOWS.A)).toThrow(/not a noul/);
    expect(() => R.goodProbability({ noul: 0.5 }, R.RUBRIC.AGENCY.C)).toThrow(/not a choice/);
    expect(() => R.goodProbability(undefined, R.RUBRIC.FOLLOWS.A)).toThrow(/missing/);
  });
});

describe('card score', () => {
  it('is the weighted mean and renormalises over the questions that were asked', () => {
    expect(R.cardScore({ A: 1, B: 0 }, { A: 1, B: 1 })).toBeCloseTo(0.5);
    expect(R.cardScore({ A: 1 }, { A: 1, B: 1 })).toBeCloseTo(1);
    expect(R.cardScore({ A: 0.2, B: 1 }, { A: 3, B: 1 })).toBeCloseTo(0.4);
  });
  it('throws when nothing weighted was answered', () => {
    expect(() => R.cardScore({}, { A: 1 })).toThrow(/no weighted/);
  });
  it('every scored question has a weight and an existing phrasing', () => {
    for (const [id, ph] of Object.entries<string>(R.SCORE_PHRASINGS)) {
      expect(R.RUBRIC[id][ph]).toBeTruthy();
      expect(R.SCORE_WEIGHTS[id]).toBeGreaterThan(0);
    }
  });
});

describe('judgeIdeaRubric', () => {
  it('a card Jev likes passes with a high score and no tripwire', async () => {
    const j = await R.judgeIdeaRubric('Idee.', ctx, { callImpl: async (rq: any) => reply(rq) });
    expect(j.ok).toBe(true);
    expect(j.failure).toBeNull();
    expect(j.tripped).toEqual([]);
    expect(j.score).toBeGreaterThan(0.8);
  });
  it('a card under the gate score reruns with a stable code', async () => {
    const j = await R.judgeIdeaRubric('Idee.', ctx, { callImpl: async (rq: any) => reply(rq, { good: false }), flagBelow: 0.99 });
    expect(j.ok).toBe(false);
    expect(j.failure).toBe('rubric-low-score');
    expect(R.RUBRIC_FEEDBACK[j.failure]).toBeTruthy();
  });
  it('a spliced-in remark trips the commentary wire whatever the score', async () => {
    const callImpl = async (rq: any) => {
      return reply(rq, { bad: { NO_COMMENTARY__A: 0.01 } });
    };
    const j = await R.judgeIdeaRubric('Idee.', ctx, { callImpl });
    expect(j.ok).toBe(false);
    expect(j.tripped).toEqual(['NO_COMMENTARY']);
    expect(j.failure).toBe('rubric-tripwire-no_commentary');
    expect(R.RUBRIC_FEEDBACK[j.failure]).toBeTruthy();
  });
  it('a Jev failure throws, no unchecked card ships', async () => {
    await expect(R.judgeIdeaRubric('Idee.', ctx, { callImpl: async () => { throw new Error('HTTP 500'); } })).rejects.toThrow(/HTTP 500/);
  });
  it('a reply that lacks a question throws', async () => {
    const callImpl = async (rq: any) => { const r = reply(rq); delete r.answers['FORCED__B']; return r; };
    await expect(R.judgeIdeaRubric('Idee.', ctx, { callImpl })).rejects.toThrow();
  });
});
