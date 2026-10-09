/**
 * Idea coherence (2026-10-09): the two rules (the topic drives the problem; every
 * act follows from the situation) and their Jev check live in ONE module,
 * server/lib/ideaCoherence.js, injected into the trial idea AND the wizard idea.
 * Pinned here: one wording for generator and critic, both prompts carry it, the
 * Jev answer is parsed against thresholds, a failing idea reruns ONCE, a Jev
 * outage throws.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-unit-tests-only';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const co = require('../../server/lib/ideaCoherence');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const trial = require('../../server/lib/trialIdeaCheck');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pb = require('../../server/lib/promptBuilders');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const wiz = require('../../server/routes/storyIdeas');

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const answers = (forced: number | undefined, follows: number) => ({
  answers: { ...(forced === undefined ? {} : { forced: { noul: forced } }), follows: { noul: follows } },
  cost: 0.00004,
});

describe('one wording for the generator and the critic', () => {
  it('the rule and both Jev questions are built from the same two phrases', () => {
    const rule = co.coherenceRule();
    expect(rule).toContain(co.COMMISSIONED_ACT_PHRASE);
    expect(rule).toContain(co.INSERTED_ACT_PHRASE);
    expect(co.COHERENCE_QUESTIONS.forced.instructions).toContain(co.COMMISSIONED_ACT_PHRASE);
    expect(co.COHERENCE_QUESTIONS.follows.instructions).toContain(co.INSERTED_ACT_PHRASE);
  });

  it('an adventure (no commissioned hard thing) gets the rule without the topic clause', () => {
    expect(co.coherenceRule({ withTopic: false })).not.toContain(co.COMMISSIONED_ACT_PHRASE);
    expect(co.coherenceRule({ withTopic: false })).toContain(co.INSERTED_ACT_PHRASE);
  });

  it('the trial commission rule carries the shared rule, and the trial check re-exports the shared phrase', () => {
    expect(trial.TRIAL_IDEA_COMMISSION_RULE).toContain(co.coherenceRule());
    expect(trial.COMMISSIONED_ACT_PHRASE).toBe(co.COMMISSIONED_ACT_PHRASE);
  });

  it('the rule does not forbid an open ending, a new character or a mixed world (owner, 2026-10-09)', () => {
    const rule = co.coherenceRule();
    expect(rule).not.toMatch(/resolve|settle|introduc|invent|mix/i);
  });
});

describe('both prompts inject the shared rule', () => {
  it('the wizard templates carry the {IDEA_COHERENCE} placeholder once each', () => {
    for (const f of ['prompts/generate-story-idea-single.txt', 'prompts/generate-story-ideas.txt']) {
      expect(read(f).split('{IDEA_COHERENCE}').length - 1).toBe(1);
    }
  });

  it('the built trial prompts carry the rule in both arms', () => {
    const { local, fantasy } = pb.buildTrialIdeaPrompts({
      template: read('prompts/trial-idea.txt'),
      characters: [{ name: 'Mia', age: 5, gender: 'female' }],
      charDesc: 'Mia, 5 years old, female',
      categoryContext: 'This is a life skills story about "screen-time".',
    });
    for (const p of [local, fantasy]) expect(p).toContain(co.coherenceRule());
  });
});

describe('judgeCoherence', () => {
  it('asks both questions for a life challenge and passes when both clear the thresholds', async () => {
    let seen: any;
    const r = await co.judgeCoherence('idea', { topic: 'screen-time', theme: 'superhero' }, { callImpl: async (rq: any) => { seen = rq; return answers(0.9, 0.8); } });
    expect(Object.keys(seen.questions)).toEqual(['forced', 'follows']);
    expect(seen.state).toContain('screen time');
    expect(r.ok).toBe(true);
    expect(r.failure).toBeNull();
  });

  it('asks only "follows" when nothing was commissioned (an adventure)', async () => {
    let seen: any;
    const r = await co.judgeCoherence('idea', { topic: '', theme: 'pirate' }, { callImpl: async (rq: any) => { seen = rq; return answers(undefined, 0.8); } });
    expect(Object.keys(seen.questions)).toEqual(['follows']);
    expect(r.ok).toBe(true);
  });

  it('fails a bolted-on topic as incoherent-forced and a non-sequitur as incoherent-follows', async () => {
    const forced = await co.judgeCoherence('idea', { topic: 'screen-time' }, { callImpl: async () => answers(0.1, 0.9) });
    expect(forced.ok).toBe(false);
    expect(forced.failure).toBe('incoherent-forced');
    const follows = await co.judgeCoherence('idea', { topic: 'screen-time' }, { callImpl: async () => answers(0.9, 0.2) });
    expect(follows.failure).toBe('incoherent-follows');
  });

  it('throws when Jev fails: no unchecked idea ships', async () => {
    await expect(co.judgeCoherence('idea', {}, { callImpl: async () => { throw new Error('HTTP 500'); } })).rejects.toThrow(/500/);
  });

  it('throws on a reply that is not a noul answer', async () => {
    await expect(co.judgeCoherence('idea', {}, { callImpl: async () => ({ answers: { follows: { choice: 'x' } } }) })).rejects.toThrow(/not a noul/);
  });
});

describe('ideaCoherenceContext', () => {
  it('commissions a topic only for a life challenge', () => {
    expect(co.ideaCoherenceContext({ storyCategory: 'life-challenge', storyTopic: 'screen-time', storyTheme: 'superhero' })).toEqual({ topic: 'screen-time', theme: 'superhero' });
    expect(co.ideaCoherenceContext({ storyCategory: 'historical', storyTopic: 'romans', storyTheme: 'x' }).topic).toBe('');
  });
});

describe('trial path: judgeIdeaCard', () => {
  const okCard = { ok: true, failure: null, idea: 'Drei Sätze.' };
  it('turns a failed coherence into a failed card the existing one-rerun path handles', async () => {
    const out = await trial.judgeIdeaCard(okCard, { topic: 'screen-time' }, { callImpl: async () => answers(0.1, 0.9) });
    expect(out.ok).toBe(false);
    expect(out.failure).toBe('incoherent-forced');
    expect(trial.buildIdeaRerunPrompt('BASE', out)).toContain(co.COHERENCE_FEEDBACK['incoherent-forced']);
  });
  it('leaves a card that already failed its self-check alone (it reruns anyway; Jev adds nothing)', async () => {
    const failed = { ok: false, failure: 'no-act', idea: 'x' };
    let called = false;
    const out = await trial.judgeIdeaCard(failed, {}, { callImpl: async () => { called = true; return answers(1, 1); } });
    expect(out).toBe(failed);
    expect(called).toBe(false);
  });
});

describe('wizard path: the rule only', () => {
  it('streamIdeaArm makes no Jev call (the gate is not calibrated for premises)', () => {
    expect(wiz.streamIdeaArm.length).toBe(1);
    expect(String(wiz.streamIdeaArm)).not.toMatch(/judgeCoherence|coherence/);
  });
});
