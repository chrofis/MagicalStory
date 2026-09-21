/**
 * The buy criterion is ONE constant, given to the writer and to its own review.
 *
 * Mirrors tests/unit/trial-idea-self-check.test.ts: the rule and the check that
 * grades it are the same string, filled into both sibling templates exactly
 * twice, so they cannot drift into differently-worded copies
 * (`axis: generator-vs-critic`, registry set `story-idea-templates`).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { IDEA_BUY_QUESTIONS, IDEA_BUY_QUESTIONS_TODDLER } = require('../../server/lib/ideaBuyCriterion');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { fillTemplate } = require('../../server/services/prompts');

const ROOT = path.resolve(__dirname, '../..');
const TEMPLATES = ['prompts/generate-story-idea-single.txt', 'prompts/generate-story-ideas.txt'];
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('IDEA_BUY_QUESTIONS — the parent asks, the review answers with quotes', () => {
  it('is the parent\'s own questions and names no story, place or character', () => {
    expect(IDEA_BUY_QUESTIONS).toMatch(/cannot do at home/);
    expect(IDEA_BUY_QUESTIONS).toMatch(/laugh at|gasp at/);
    expect(IDEA_BUY_QUESTIONS).toMatch(/frighten/i);
    expect(IDEA_BUY_QUESTIONS).toMatch(/again tomorrow/);
    // Generic by construction — a name or a real place here would leak into
    // every story the template writes.
    expect(IDEA_BUY_QUESTIONS).not.toMatch(/Baden|Limmat|Holzbrücke|Mia|Noah|Emma/);
  });

  it('each template carries the {BUY_CRITERION} placeholder exactly twice', () => {
    for (const t of TEMPLATES) {
      expect(read(t).split('{BUY_CRITERION}').length - 1).toBe(2);
    }
  });

  it('the BUILT prompt carries the constant exactly twice: the draft rule and the last review check', () => {
    for (const t of TEMPLATES) {
      // Both constants, injected identically: the toddler cast swaps the
      // questions and nothing else about how they reach the model.
      for (const questions of [IDEA_BUY_QUESTIONS, IDEA_BUY_QUESTIONS_TODDLER]) {
        const built = fillTemplate(read(t), { BUY_CRITERION: questions });
        expect(built.split(questions).length - 1).toBe(2);
        // The rule comes first, the check that grades it last.
        const first = built.indexOf(questions);
        const second = built.lastIndexOf(questions);
        expect(built.slice(0, first)).toMatch(/answers these/);
        expect(built.slice(second - 400, second)).toMatch(/answer each of these with a quote/);
      }
    }
  });

  it('the toddler questions ask what the two of them do with the book', () => {
    expect(IDEA_BUY_QUESTIONS_TODDLER).toMatch(/say along/);
    expect(IDEA_BUY_QUESTIONS_TODDLER).toMatch(/point at/);
    expect(IDEA_BUY_QUESTIONS_TODDLER).toMatch(/game do the parent and the child play/);
    expect(IDEA_BUY_QUESTIONS_TODDLER).toMatch(/want again/);
    expect(IDEA_BUY_QUESTIONS_TODDLER).not.toMatch(/Baden|Limmat|Holzbrücke|Mia|Noah|Emma|Lena|Emil/);
  });

  it('the route declares BUY_CRITERION, so no call site can ship the placeholder unfilled', () => {
    const src = read('server/routes/storyIdeas.js');
    // Both constants reach the template through buildIdeaContract, spread into
    // the replacement map — so BUY_CRITERION is declared for every cast.
    expect(src).toContain("require('../lib/ideaContract')");
    expect(src).toContain('...ideaContract,');
  });
});
