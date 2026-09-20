import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const {
  PLAN_LINE_CAST_RULE,
  PLAN_LINE_FIELD_CONTRACT,
} = require('../../server/lib/promptBuilders');

// The plan line is "<shot> — <who is in frame> — <the instant> — <what is true
// after>" (story-beats.txt). Field 2 is the cast. Three stages must agree on
// that, and until 2026-09-20 only one of them said so:
//
//   plan-check.txt  (critic)   "Read the WHO COLUMN ALONE: a figure named only
//                               in the instant or in what is true after is not
//                               in frame"          <- already had it
//   story-beats.txt (producer)  nothing             <- PLAN_LINE_FIELD_CONTRACT
//   scene-expansion (consumer)  "the plan line defines who is visible", with an
//                               explicit channel list for ANIMALS and none for
//                               people              <- PLAN_LINE_CAST_RULE
//
// Measured over 34 staging stories / 487 stored plan lines: 51 lines (10.5%)
// name a person in the instant whom the cast field omits, and the Art Director
// promoted them to a declared character in 43 of 51 (84%). Those pages score
// 15.0 points below their own book's other pages, and score worse in 15 of the
// 20 books that have one.
//
// These pin the CONTRACT — that each side carries a rule about the cast field,
// and that the templates consume it — never the wording of any clause.

const P = (f: string) => path.join(__dirname, '..', '..', 'prompts', f);
const read = (f: string) => fs.readFileSync(P(f), 'utf8');

describe('the plan line cast field is one contract across three stages', () => {
  it('the producer is told the cast field is the complete cast', () => {
    expect(PLAN_LINE_FIELD_CONTRACT).toMatch(/second field/i);
    expect(PLAN_LINE_FIELD_CONTRACT).toMatch(/complete cast/i);
  });

  it('the producer is told not to write a non-cast person into the instant', () => {
    expect(PLAN_LINE_FIELD_CONTRACT).toMatch(/instant/i);
    expect(PLAN_LINE_FIELD_CONTRACT).toMatch(/not written into the instant at all/i);
  });

  it('the consumer is told the second field is the complete cast', () => {
    expect(PLAN_LINE_CAST_RULE).toMatch(/second field/i);
    expect(PLAN_LINE_CAST_RULE).toMatch(/complete cast/i);
  });

  it('the consumer is told a person named elsewhere in the line is not a character', () => {
    expect(PLAN_LINE_CAST_RULE).toMatch(/never becomes a character/i);
    expect(PLAN_LINE_CAST_RULE).toMatch(/characters\[\]/);
  });

  it('keeps the tracked-animal channel list the rule already carried', () => {
    expect(PLAN_LINE_CAST_RULE).toMatch(/tracked animal/i);
    expect(PLAN_LINE_CAST_RULE).toMatch(/whichever way it enters/i);
    expect(PLAN_LINE_CAST_RULE).toMatch(/objects\[\]/);
  });

  it('the critic already states it, and still does', () => {
    // plan-check.txt is the one stage that had the rule before this change; if
    // this line ever goes, the other two are enforcing something nobody audits.
    expect(read('plan-check.txt')).toMatch(/named only in the instant or in what is true after is not in frame/i);
  });
});

describe('both templates actually consume their half', () => {
  it('story-beats.txt carries the producer placeholder', () => {
    // fillTemplate drops undeclared keys silently, so a placeholder with no
    // matching key ships the literal brace text to the model.
    expect(read('story-beats.txt')).toContain('{PLAN_LINE_FIELDS}');
  });

  it('the Art Director templates carry the consumer placeholder', () => {
    expect(read('scene-expansion-all.txt')).toContain('{PLAN_LINE_CAST}');
    expect(read('scene-expansion.txt')).toContain('{PLAN_LINE_CAST}');
  });

  it('neither clause names a story, character or plot', () => {
    // prompts stay generic — a clause that reveals the story it came from would
    // leak into every unrelated book.
    for (const clause of [PLAN_LINE_CAST_RULE, PLAN_LINE_FIELD_CONTRACT]) {
      expect(clause).not.toMatch(/Silvan|Julian|Levin|Kiaan|Lindenhof|Zippi|dragon|egg/i);
    }
  });

  it('states the rule without banners or justification', () => {
    for (const clause of [PLAN_LINE_CAST_RULE, PLAN_LINE_FIELD_CONTRACT]) {
      expect(clause).not.toMatch(/CRITICAL|MUST NEVER|LOCKED|IMPORTANT:/);
      expect(clause).not.toMatch(/\bbecause\b/i);
    }
  });
});

/**
 * ONE BULLET, NOT TWO (2026-09-20).
 *
 * `81115d30a` added PLAN_LINE_FIELD_CONTRACT to story-beats.txt while the
 * template already carried a narrower hand-written bullet making the same
 * point ("The who column names every figure the picture shows. A figure that
 * appears only in the instant or in what is true after is not in the
 * picture…"). Owner's call: keep the broader constant, drop the narrower
 * duplicate, and fold the one clause the broader one did not cover — the
 * FOURTH field, "what is true after" — into it rather than losing it.
 *
 * Two statements of one contract in one prompt is the same disease the
 * constant exists to cure; this pins that the built prompt states it once.
 */
describe('the planner states the who-column contract exactly once', () => {
  const beats = () => read('story-beats.txt');

  it('the narrower hand-written bullet is gone', () => {
    expect(beats()).not.toContain('The who column names every figure the picture shows');
  });

  it('and its fourth-field clause survives in the constant that replaced it', () => {
    expect(PLAN_LINE_FIELD_CONTRACT).toMatch(/what is true after/i);
    expect(PLAN_LINE_FIELD_CONTRACT).toMatch(/not in the picture either/i);
  });

  it('the contract is stated once in the BUILT planner prompt, not once per copy', async () => {
    const pb = require('../../server/lib/promptBuilders');
    const { loadPromptTemplates } = require('../../server/services/prompts');
    await loadPromptTemplates();
    const built = pb.buildBeatsPrompt(
      { pages: 18, language: 'de-CH', characters: [{ id: 'a', name: 'Levin', age: 5 }], mainCharacters: ['a'] },
      18, { finalArc: '1. A story.' });
    expect(built).toContain(PLAN_LINE_FIELD_CONTRACT);
    expect(built.split('complete cast of that picture').length - 1).toBe(1);
    expect(built.split('not in the picture').length - 1).toBe(1);
  });
});
