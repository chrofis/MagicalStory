/**
 * Idea coherence (2026-10-09): the two rules (the topic drives the problem; every
 * act follows from the situation) live in ONE module, server/lib/ideaCoherence.js,
 * injected into the trial idea AND the wizard idea. Pinned here: one wording for
 * generator and critic, both prompts carry it. The trial's Jev gate is the rubric
 * (idea-jev-rubric.test.ts, idea-gate-finish.test.ts).
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

describe('one wording for the generator and the critic', () => {
  it('the rule is built from the two shared phrases', () => {
    const rule = co.coherenceRule();
    expect(rule).toContain(co.COMMISSIONED_ACT_PHRASE);
    expect(rule).toContain(co.INSERTED_ACT_PHRASE);
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

describe('ideaCoherenceContext', () => {
  it('commissions a topic only for a life challenge', () => {
    expect(co.ideaCoherenceContext({ storyCategory: 'life-challenge', storyTopic: 'screen-time', storyTheme: 'superhero' })).toEqual({ topic: 'screen-time', theme: 'superhero' });
    expect(co.ideaCoherenceContext({ storyCategory: 'historical', storyTopic: 'romans', storyTheme: 'x' }).topic).toBe('');
  });
});

describe('wizard path: the rule only', () => {
  it('streamIdeaArm makes no Jev call (the gate is not calibrated for premises)', () => {
    expect(wiz.streamIdeaArm.length).toBe(1);
    expect(String(wiz.streamIdeaArm)).not.toMatch(/judgeCoherence|coherence/);
  });
});
