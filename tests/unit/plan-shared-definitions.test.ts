import { describe, it, beforeAll, expect } from 'vitest';

const pb = require('../../server/lib/promptBuilders');
const { loadPromptTemplates } = require('../../server/services/prompts');

const input = () => ({
  pages: 18, language: 'de-CH', languageLevel: '1st-grade', storyDetails: 'x',
  characters: [{ id: 'a', name: 'Levin', age: 5 }], mainCharacters: ['a'],
});
const planner = () => pb.buildBeatsPrompt(input(), 18, { finalArc: '1. A story.', arcHints: '' });
const checker = () => pb.buildPlanCheckPrompt(
  input(), [{ pageNumber: 1, planLine: 'medium — Levin — he waits — nothing' }],
  '1. A story.', 'Page 1: medium — Levin — he waits — nothing');

/**
 * story-beats.txt states each page rule as an imperative and plan-check.txt
 * audits the same rule as a question — the generator/critic pair for page
 * division. The framing is deliberately different; the DEFINITION inside each
 * was written out twice by hand. A definition that drifts between the rule and
 * the audit is a generator that cannot satisfy the judge grading it.
 */
describe('planner and checker share one definition, not two copies', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  for (const name of ['DEED_AND_EFFECT_DEF', 'TWO_HEIGHTS_DEF', 'WHOLE_CAST_DEF', 'NAMING_DEF', 'ENDING_EVENT_DEF', 'EXCITING_START_DEF', 'HAPPY_ENDING_DEF']) {
    it(`${name} reaches BOTH prompts, verbatim`, () => {
      const def = pb[name];
      expect(def, `${name} is not exported`).toBeTruthy();
      expect(planner(), `${name} missing from the planner`).toContain(def);
      expect(checker(), `${name} missing from the checker`).toContain(def);
    });
  }

  /**
   * WANTED_PICTURE_DEF is the one definition that is NOT shared: it is filled
   * into plan-check.txt only, and story-beats.txt hand-states the equivalent as
   * a planning question. The two copies are hand-kept, so they are pinned here
   * clause by clause — editing one twin without the other fails this test.
   */
  it('WANTED_PICTURE_DEF reaches the checker; the planner hand-states the same clauses', () => {
    expect(checker()).toContain(pb.WANTED_PICTURE_DEF);
    const p = planner();
    expect(p).toContain('which picture does a child most want to see there');
    // (a) the ending-event clause, verbatim in both twins
    const endingClause = "The ending's own event — the reunion, the goodbye, the parting — is always one of them.";
    expect(pb.WANTED_PICTURE_DEF, 'the checker copy lost the ending-event clause').toContain(endingClause);
    expect(p, 'the planner copy lost the ending-event clause').toContain(endingClause);
    // (b) the not-staged clause: both halves of what does not count
    for (const half of ['falls between two pages', "only a page's change reports as already done"]) {
      expect(p, `the planner copy lost: ${half}`).toContain(half);
      expect(checker(), `the checker copy lost: ${half}`).toContain(half);
    }
  });

  /**
   * 455704f89 factored TWO_HEIGHTS_DEF out of story-beats.txt and left the
   * hand-written tail sentence behind, so the built prompt stated the whole-cast
   * clause twice, twenty words apart.
   */
  it('the definition is stated once in the built prompt, not once per copy', () => {
    const p = planner();
    for (const sentence of pb.TWO_HEIGHTS_DEF.split(/(?<=\.)\s+/).filter((x: string) => x.length > 25)) {
      expect(p.split(sentence).length - 1, `duplicated: ${sentence}`).toBe(1);
    }
  });

  it('neither prompt ships an unfilled placeholder', () => {
    expect(planner().match(/\{[A-Z_]+\}/g) || []).toEqual([]);
    expect(checker().match(/\{[A-Z_]+\}/g) || []).toEqual([]);
  });

  it('each side keeps its own framing — the rule commands, the audit asks', () => {
    expect(planner()).toContain('- One action per page.');
    expect(checker()).toContain('9. Deed and effect. Name every page');
    // The article differs by site and both wordings are pinned elsewhere.
    expect(planner()).toContain("A character's first page stages their arrival");
    expect(checker()).toContain('That page stages an arrival');
  });
});

/**
 * "A character in frame on a page is in frame on the next one unless a plan line
 * says where they went" contradicted "the others come and go in different
 * combinations". Measured on job_1789759147125_p08djwhbl: 10 of 17 transitions
 * drop a named character and no plan line says where anyone went — the planner
 * obeyed the variety rule and ignored this one. Owner, 2026-09-19: delete it.
 */
describe('the dead-letter continuity sentence is gone', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('no longer demands a departure clause on every page turn', () => {
    expect(planner()).not.toContain('is in frame on the next one unless a plan line says where they went');
  });

  it('keeps the THING-continuity half, which nothing contradicted', () => {
    expect(planner()).toContain('What a page establishes about a thing — stuck, heavy, hidden, out of reach — stays true');
  });

  it('keeps the variety rule it was fighting', () => {
    expect(planner()).toContain('come and go in different combinations');
  });
});


/**
 * THE PEOPLELESS PAGE IS NOMINATED BY THE CHECKER (2026-09-20).
 *
 * `NO_PEOPLELESS_PAGE` is must-fix and named no page. A code heuristic for the
 * pick was built and rejected on measurement (docs/decisions.md): on
 * job_1789853503332_riqncqg1i it leaves candidates {2,4,10,13,17} and every
 * defensible tie-break ranks the hatching climax (p17) or the rescue (p10)
 * above the right page (p13). Classification belongs to the prompt, so Q6
 * nominates the page and code only consumes the field.
 *
 * The nomination criterion is a hand-kept pair, like WANTED_PICTURE_DEF: the
 * checker asks it, the planner is told it, and it is pinned here clause by
 * clause rather than shared as a constant, because the two sides state it in
 * the two framings this pair exists to keep apart.
 */
describe('plan-check Q6 nominates the peopleless page, and the planner is told', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('the checker is asked for the nomination only when the book has none', () => {
    const c = checker();
    expect(c).toContain('When no page is people-free, nominate the one page best suited to give up its cast');
    expect(c).toContain('a page whose subject is already a thing or a place seen alone');
    expect(c).toContain('never a moment between people');
    // Q4's pictures are the ones that may NOT be emptied.
    expect(c).toContain('never one of the most wanted pictures question 4 names');
  });

  it('the nomination is emitted in the ROSTER/OBSTACLES shape, not a new syntax', () => {
    const c = checker();
    expect(c).toContain('PEOPLELESS <page>: ');
    expect(c).toContain('only when no page is people-free, one line naming the page best suited to give up its cast');
    // The all-clear still enumerates every block the reply owes.
    expect(c).toContain('the peopleless line if one is owed');
  });

  it('the planner is told the same criterion — the critic asks, the generator is told', () => {
    const g = planner();
    expect(g).toContain('At least one page in the book earns this');
    expect(g).toContain('never a page whose drama is between people');
    // The clause the checker grades and the planner previously lacked.
    expect(g).toContain('so does every picture question 5 names as most wanted');
  });

  it('the re-plan tells the planner a named page is a candidate it may refuse', () => {
    const section = pb.buildReplanSection(
      'Page 1: wide — Levin — he runs — he is out',
      [{ kind: 'counter', code: 'NO_PEOPLELESS_PAGE', line: 'PLAN[NO_PEOPLELESS_PAGE]: x' }],
      { pageCount: 18 });
    expect(section).toContain('names a candidate, not an order');
    // The two refusals it may invoke are still stated right above it.
    expect(section).toContain('Two figures stay wherever they are');
  });
});

/**
 * THE RE-PLAN IS THE THIRD READER OF WHOLE_CAST_DEF (2026-09-26, Lab #1537).
 * A CHECK[17] line reached MUST FIX with no definition beside it, and the round
 * answered it with one figure's deed while the rest looked on; the recheck filed
 * Q17 again. The re-plan block now carries the same constant the checker's
 * question 17 reads, whatever findings it lists — a whole-cast page rewritten
 * for another finding (p6 there) must keep its shared action too.
 */
describe('the re-plan block carries the whole-cast definition the check grades by', () => {
  beforeAll(async () => { await loadPromptTemplates(); });
  const plan = 'Page 1: wide — Levin — he runs — he is out';

  it('a whole-cast finding in MUST FIX is answered next to the checker\'s own definition', () => {
    const section = pb.buildReplanSection(plan,
      [{ check: 17, line: 'CHECK[17]: page 1 holds the whole commissioned cast, but they only stand.' }],
      { pageCount: 1 });
    expect(section).toContain(pb.WHOLE_CAST_DEF);
    expect(checker()).toContain(pb.WHOLE_CAST_DEF);
    expect(section.indexOf(pb.WHOLE_CAST_DEF)).toBeLessThan(section.indexOf('## MUST FIX'));
  });

  it('it is there for a round with no whole-cast finding, which may still rewrite a whole-cast page', () => {
    const section = pb.buildReplanSection(plan,
      [{ code: 'CENTRAL_FIGURE_ABSENT_THIRD', pages: [1], line: 'PLAN[CENTRAL_FIGURE_ABSENT_THIRD] page 1: x' }],
      { pageCount: 1 });
    expect(section).toContain(pb.WHOLE_CAST_DEF);
  });

  // Owner ruling 2026-09-27 (Lab #1550): the group watching one thing counts only
  // seen from behind or over the shoulder. The same condition must reach every
  // reader — planner, re-plan, checker — through the one constant.
  it('watching together counts only from behind or over the shoulder, on every side', () => {
    const clause = 'watching one thing is a shared action only when they are seen from behind or over the shoulder';
    expect(pb.WHOLE_CAST_DEF).toContain(clause);
    expect(pb.WHOLE_CAST_DEF).toContain('facing the viewer it never is');
    expect(pb.WHOLE_CAST_DEF).not.toContain('all turned toward one thing ahead of them');
    const section = pb.buildReplanSection(plan, [{ check: 17, line: 'CHECK[17]: page 1 x' }], { pageCount: 1 });
    for (const text of [planner(), checker(), section]) expect(text).toContain(clause);
  });

  it('it is stated once in the block', () => {
    const section = pb.buildReplanSection(plan, [{ check: 17, line: 'CHECK[17]: page 1 x' }], { pageCount: 1 });
    expect(section.split(pb.WHOLE_CAST_DEF).length - 1).toBe(1);
  });
});

/**
 * The over-the-shoulder contact rule (shotVocabulary.OTS_NO_CONTACT_RULE) is one
 * constant filled into both sides: the planner's {OTS_NO_CONTACT} and the
 * checker's question 14. Before 2026-09-24 only the planner had it, and an OTS
 * page on a contact beat passed the check (job_1790277448294_5herh01j7 p12).
 */
// RETIRED from planner and checker 2026-09-27: no plan line carries a shot while
// the plan is written and checked; the rule rides in the Jev over-the-shoulder
// question (jevDecisions.shotFitQuestions) and the Art Director templates.
describe('the over-the-shoulder contact rule left the planner and the checker with the shot word', () => {
  beforeAll(async () => { await loadPromptTemplates(); });
  const { OTS_NO_CONTACT_RULE } = require('../../server/lib/shotVocabulary');

  it('the built plan check carries it nowhere, with no unfilled placeholder', () => {
    const p = String(checker());
    expect(p).not.toContain(OTS_NO_CONTACT_RULE);
    expect(p).not.toMatch(/\{[A-Z_]{3,}\}/);
  });

  it('the built planner carries it nowhere', () => {
    expect(String(planner())).not.toContain(OTS_NO_CONTACT_RULE);
  });
});

describe('parsePlanCheckPeoplelessPick reads the line as data', () => {
  const parse = pb.parsePlanCheckPeoplelessPick;

  it('reads page and subject', () => {
    expect(parse('ROSTER 1: people = Levin\nPEOPLELESS 13: the silent egg on the ground'))
      .toEqual({ page: 13, subject: 'the silent egg on the ground' });
  });

  it('tolerates the markdown bolding and a "page" word the checker sometimes adds', () => {
    expect(parse('**PEOPLELESS page 4: the empty clearing**').page).toBe(4);
  });

  it('returns null when no line was emitted — never a guessed page', () => {
    expect(parse('ROSTER 1: people = Levin\nOBSTACLES 7: Silvan\nNONE')).toBeNull();
    expect(parse('')).toBeNull();
  });
});
