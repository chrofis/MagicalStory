/**
 * "The idea is now too long". Stored trial ideas (staging stories.data.storyDetails,
 * job id epoch -> CH time): 11 of 11 before the causal-chain rule (fd5c7d00e,
 * 2026-10-08 22:30 CH) were 47-50 words; the 16 after it ran 61-110 (median ~75).
 * "Maximum 50 words" was one clause at the end of the chain rule. The limit is
 * now a stated per-sentence budget from one constant. Raised 50 -> 75 on 2026-10-09 (owner: "75 or so
 * is OK, but the box must fit it"); the card textarea auto-grows.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
const check = require('../../server/lib/trialIdeaCheck');
const pb = require('../../server/lib/promptBuilders');
const tpl = fs.readFileSync(path.resolve(__dirname, '../../prompts/trial-idea.txt'), 'utf8');

describe('trial idea length limit in the built prompt', () => {
  const { local, fantasy } = pb.buildTrialIdeaPrompts({ template: tpl, charDesc: 'Mia, 7', townName: 'Baden' });
  it('is one constant, 75 words in all and 25 per sentence', () => {
    expect(check.TRIAL_IDEA_MAX_WORDS).toBe(75);
    expect(check.TRIAL_IDEA_SENTENCE_WORDS).toBe(25);
  });
  for (const [name, p] of [['local', local], ['fantasy', fantasy]] as const) {
    it(`${name} arm states the limits, no placeholder left, chain rule kept`, () => {
      expect(p).toContain('no sentence is longer than 25 words and the whole idea is at most 75 words');
      expect(p).toContain('an idea over 75 words is a fault');
      expect(p).not.toMatch(/\{(MAX_WORDS|SENTENCE_WORDS)\}/);
      expect(p).toContain('Sentence 3 settles exactly the want from sentence 1.');
    });
  }
});
