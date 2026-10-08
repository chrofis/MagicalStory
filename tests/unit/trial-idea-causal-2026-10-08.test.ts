// Trial idea: effort low, one causal chain (docs/decisions.md 2026-10-08 "Trial ideas: effort low, one chain").
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
const R = path.resolve(__dirname, '../..');
const read = (f: string) => fs.readFileSync(path.join(R, f), 'utf8');
const pb = require('../../server/lib/promptBuilders');
const { MODEL_DEFAULTS } = require('../../server/config/models');

describe('trial idea call effort', () => {
  it('has a low effort default', () => {
    expect(MODEL_DEFAULTS.trialIdeaEffort).toBe('low');
  });
  it('the /try route passes it on the card call and on the rerun', () => {
    const src = read('server/routes/trial.js');
    expect(src.match(/effort: MODEL_DEFAULTS\.trialIdeaEffort/g)?.length).toBe(2);
  });
  it('the Lab variety stage sends the same effort', () => {
    const src = read('server/lib/testlab.js');
    expect(src.match(/effort: MODEL_DEFAULTS\.trialIdeaEffort/g)?.length).toBe(2);
  });
});

describe('trial life-challenge context', () => {
  const ctx = pb.buildTrialLifeChallengeContext('reading-alone', 'wizard');
  it('is one shared builder for the route and the Lab', () => {
    expect(read('server/routes/trial.js')).toContain('buildTrialLifeChallengeContext(storyTopic, storyTheme)');
    expect(read('server/lib/testlab.js')).toContain('buildTrialLifeChallengeContext(storyTopic, storyTheme)');
  });
  it('no longer makes a creature that answers back the obstacle', () => {
    expect(ctx).not.toContain('answers back');
    expect(ctx).toContain('life skills story about "reading-alone"');
  });
  it('presents the guide as background, not a checklist', () => {
    expect(ctx).toContain('Background on this topic');
    expect(ctx).not.toContain('Guidance for this topic');
  });
});

describe('trial-idea.txt slots form one chain', () => {
  const tpl = read('prompts/trial-idea.txt');
  it('sentence 2 works on the event itself and 3 follows from 2', () => {
    expect(tpl).toContain('each one follows from the one before');
    expect(tpl).toContain('what they do about exactly that event');
    expect(tpl).toContain('what that leads to');
  });
  it('names a thing only when the chain needs it', () => {
    expect(tpl).toContain('named only if the event, the act or the result needs it');
  });
  it('stays generic', () => {
    expect(tpl).not.toMatch(/Lukas|raven|Rabe|Ruine|Zauberer|map\b/i);
  });
});
