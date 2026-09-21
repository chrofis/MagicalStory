import { describe, it, expect } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getTeachingGuide, getIdeaGuide } = require('../../server/lib/promptBuilders.js');

/**
 * A teaching guide is injected verbatim into stories written in any supported
 * language. A guide that states a fact of ONE language therefore ships that
 * language's fact into every other one: production job
 * job_1789945743706_8ayo2w19e (Italian, topic `alphabet`) closed on "tutte e
 * ventisei le lettere dell'alfabeto" — 26 is the English count, the Italian
 * alphabet has 21 — traced to `[alphabet]`'s "the 26 letters of the English
 * alphabet (A-Z)".
 *
 * Pinned here is the BEHAVIOUR, not the wording: the guide a literacy topic
 * hands the writer names no natural language and asserts no letter count.
 */
const LITERACY_TOPICS = ['alphabet', 'vowels', 'rhyming', 'spelling-name'];

// Any language this product writes in, plus the adjectives a guide would use.
const LANGUAGE_WORDS = /\b(english|german|french|italian|deutsch|français|italiano)\b/i;

// "the 26 letters", "26 letters", "5 vowels", "the 5 vowels"
const LETTER_COUNT = /\b\d+\s+(letters|vowels|consonants)\b/i;

describe('literacy teaching guides are language-neutral', () => {
  for (const topic of LITERACY_TOPICS) {
    it(`[${topic}] names no natural language (story path)`, () => {
      const guide = getTeachingGuide('educational', topic);
      expect(guide, `${topic} guide must exist`).toBeTruthy();
      expect(guide).not.toMatch(LANGUAGE_WORDS);
    });

    it(`[${topic}] asserts no letter/vowel count (story path)`, () => {
      expect(getTeachingGuide('educational', topic)).not.toMatch(LETTER_COUNT);
    });

    it(`[${topic}] carries neither into the idea call`, () => {
      const idea = getIdeaGuide('educational', topic);
      expect(idea, `${topic} idea guide must exist`).toBeTruthy();
      expect(idea).not.toMatch(LANGUAGE_WORDS);
      expect(idea).not.toMatch(LETTER_COUNT);
    });
  }

  it('[alphabet] tells the writer to use the story language\'s own count', () => {
    // The count is the fact that leaked; the guide must hand the decision to
    // the story's language rather than stating a number.
    expect(getTeachingGuide('educational', 'alphabet')).toMatch(/this language's own count/i);
  });
});
