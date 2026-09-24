import { describe, it, beforeAll, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const {
  characterSourceRule, buildArcCreatePrompt, buildArcRetellPrompt,
  buildArcReviewPrompt, buildBeatsPrompt, buildArcHintsPrompt,
} = require('../../server/lib/promptBuilders');
const { loadPromptTemplates } = require('../../server/services/prompts');

const PROMPTS = join(__dirname, '../..', 'prompts');

const input = () => ({
  pages: 18, language: 'de-CH', languageLevel: '1st-grade',
  storyDetails: 'Zwei fremde Buben — Max und Kiaan. Die vier Buben kennen sich nicht.',
  characters: [
    { id: 'a', name: 'Levin', age: 5, specialDetails: 'Max und Kiaan sind seine guten Freunde' },
    { id: 'b', name: 'Max', age: 3 },
  ],
  mainCharacters: ['a'],
});

/**
 * The 2026-09-19 split reached arc-create and arc-retell and stopped there.
 * story-beats.txt still headed the block "source of truth for who these
 * characters are" and story-arc-review.txt "source of truth for who these
 * children are" — so the arc creator was told the premise outranks a saved
 * profile while its own CRITIC was told the opposite, and the planner dividing
 * the settled arc was told a third thing.
 */
describe('the character-source rule reaches every stage that claims one', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('no prompt claims the saved profile is the source of truth for WHO someone is', () => {
    const offenders = readdirSync(PROMPTS)
      .filter(f => f.endsWith('.txt'))
      .filter(f => /source of truth for who/i.test(readFileSync(join(PROMPTS, f), 'utf-8')));
    expect(offenders).toEqual([]);
  });

  it('the arc stages answer to the PREMISE', () => {
    for (const p of [
      buildArcCreatePrompt(input(), 18, {}),
      buildArcRetellPrompt(input(), 18, 'ARC 1: ...', ''),
      buildArcReviewPrompt(input(), 18, '1. They meet as strangers.'),
    ]) {
      expect(p).toBeTruthy();
      expect(p).toContain('the premise stands');
      expect(p).not.toContain('{CHARACTER_SOURCE_RULE}');
    }
  });

  it('the planner answers to the ARC — it is forbidden to act on the commission', () => {
    const p = buildBeatsPrompt(input(), 18, { finalArc: '1. They meet as strangers.', arcHints: '' });
    expect(p).toContain('The arc above is settled');
    expect(p).toContain('the arc stands');
    expect(p).not.toContain('the premise stands');
    expect(p).not.toContain('{CHARACTER_SOURCE_RULE}');
  });

  /**
   * The fifth stage. arc-hints reads the same two inputs — the saved profile and
   * the story — and got no rule at all: on job_1789853503332_riqncqg1i it emitted
   * "the boys introduce themselves as strangers even though Levin's details
   * already name Max and Kiaan as his good friends -> have them greet one another
   * by name", the hint rode into the planner, and the arc's first meeting was
   * deleted from the book.
   */
  it('the hint pass answers to the ARC — it reads a settled one', () => {
    const p = buildArcHintsPrompt(input(), '1. Four boys meet as strangers at the pond.', 'Want and stakes: find the owner.');
    expect(p).toBeTruthy();
    expect(p).toContain('The arc above is settled');
    expect(p).toContain('the arc stands');
    expect(p).not.toContain('the premise stands');
    expect(p).not.toContain('{CHARACTER_SOURCE_RULE}');
    // "above" is literal: the arc is printed before the rule that cites it.
    expect(p.indexOf('# THE FINAL ARC')).toBeLessThan(p.indexOf('The arc above is settled'));
    expect(p.match(/\{[A-Z_]+\}/g) || []).toEqual([]);
  });

  it('the trait half is identical in both variants — only the SITUATION half moves', () => {
    const premise = characterSourceRule().split('\n');
    const arc = characterSourceRule({ master: 'arc' }).split('\n');
    expect(premise[0]).toBe(arc[0]);
    expect(premise[0]).toContain('Never contradict one, never invent one.');
    expect(premise[1]).not.toBe(arc[1]);
  });

  it('generator and critic agree: the arc creator and its reviewer get the same rule', () => {
    const rule = (p: string) => p.slice(p.indexOf('These details decide'), p.indexOf('not true yet in this book.') + 26);
    expect(rule(buildArcCreatePrompt(input(), 18, {})))
      .toBe(rule(buildArcReviewPrompt(input(), 18, '1. They meet as strangers.')));
  });
});
