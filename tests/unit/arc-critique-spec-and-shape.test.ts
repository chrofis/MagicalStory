import { describe, it, beforeAll, expect } from 'vitest';

const {
  arcCritiqueSpec, buildArcCreatePrompt, buildArcRetellPrompt,
  buildStoryShapeSection, buildAgeModeSection,
} = require('../../server/lib/promptBuilders');
const { loadPromptTemplates } = require('../../server/services/prompts');

const input = (age = 5, extra: any = {}) => ({
  pages: 18, language: 'de-CH', languageLevel: '1st-grade', storyDetails: 'Vier Buben finden ein Ei.',
  characters: [{ id: 'a', name: 'Levin', age }], mainCharacters: ['a'], ...extra,
});

/**
 * The critique spec was a 3,145-char paragraph pasted into arc-create.txt and
 * arc-retell.txt, already differing by the words " that remain". It claimed ten
 * questions and asked twelve, unnumbered; five carried a mandatory MAJOR while
 * the output budget was "3 to 6 numbered faults", so mechanical verdicts crowded
 * out the story faults the stage exists to find.
 */
describe('the arc critique spec is one source', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  /**
   * 6e3b476b0 removed the two per-PAGE questions on the grounds that the arc has
   * no pages, but the spec never STATED the prohibition, so faults kept citing
   * them: the arc-2 critique on a staging run cites "Page 9", "After page 11",
   * "page 13", "page 18" and "page 6". The division happens two stages later.
   */
  it('no fault may cite a page number or a count — and both templates are told so', () => {
    for (const spec of [arcCritiqueSpec(), arcCritiqueSpec({ retell: true })]) {
      expect(spec).toMatch(/never a count, a page number/);
    }
    expect(buildArcCreatePrompt(input(), 18, {})).toContain(arcCritiqueSpec());
    expect(buildArcRetellPrompt(input(), 18, 'ARC 1: ...', '')).toContain(arcCritiqueSpec({ retell: true }));
  });

  it('both templates fill from the same builder, with no placeholder left', () => {
    const create = buildArcCreatePrompt(input(), 18, {});
    const retell = buildArcRetellPrompt(input(), 18, 'ARC 1: ...', '');
    expect(create).not.toContain('{ARC_CRITIQUE_SPEC}');
    expect(retell).not.toContain('{ARC_CRITIQUE_SPEC}');
    expect(create).toContain(arcCritiqueSpec());
    expect(retell).toContain(arcCritiqueSpec({ retell: true }));
  });

  // ONE ANCHORED CHECK (owner, 2026-09-25): the reader questions and the
  // sentence-by-sentence "Logic:" pass left; each fault quotes the conflict.
  it('one anchored check: faults name a logic shape and quote the conflict, and nothing is counted', () => {
    const spec = arcCritiqueSpec();
    const { ARC_LOGIC_CHECK, ARC_FINDING_RULE } = require('../../server/lib/promptBuilders');
    expect(spec.indexOf('"Faults:"')).toBe(0);
    expect(spec).toContain(ARC_LOGIC_CHECK);
    expect(spec).toContain(ARC_FINDING_RULE);
    expect(spec).toContain('"Commission honored:"');
    expect(spec).not.toContain('"Questions:"');
    expect(spec).not.toContain('"Logic:"');
    expect(spec).not.toContain('"Checks:"');
    expect(spec).not.toMatch(/Allowed: <N>|in each third|Invented figures/);
  });

  it('a quoted fault line still carries its severity to the parser; "none" carries none', () => {
    const { critiqueMaxSeverity } = require('../../server/lib/promptBuilders');
    const critique = ['Faults:', '1. [MINOR] s4 "the dog digs" against "nothing was buried there" — the dig finds nothing.', 'Commission honored: yes'].join('\n');
    expect(critiqueMaxSeverity(critique)).toBe('MINOR');
    expect(critiqueMaxSeverity('Faults:\nnone\nCommission honored: yes')).toBeNull();
  });

  it('the per-page questions are gone — the arc has sentences, not pages', () => {
    const spec = arcCritiqueSpec();
    expect(spec).not.toContain('action load per page');
    expect(spec).not.toContain('name the page each surplus fact belongs on');
  });

  it('the figure lists are gone from both variants: the STORY LOGIC carries the figures', () => {
    for (const spec of [arcCritiqueSpec(), arcCritiqueSpec({ retell: true })]) {
      expect(spec).not.toContain('"Premise figures:"');
      expect(spec).not.toContain('"Invented figures:"');
    }
  });

  it('the re-tell variant judges what remains', () => {
    expect(arcCritiqueSpec({ retell: true })).toContain('faults that remain');
    expect(arcCritiqueSpec()).not.toContain('faults that remain');
  });
});

/**
 * STORY SHAPE carried a SHORTENED COPY of rules the age-band file states in
 * full, and on the arc path both land in the same prompt.
 */
describe('one statement per shape rule', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('the arc STORY SHAPE no longer restates the band file', () => {
    const shape = buildStoryShapeSection(input(5), 18, { arc: true });
    expect(shape).not.toContain('A real low point before the end is required');
    expect(shape).not.toContain("The main character's own idea turns it");
  });

  it('the band file still states it, in full', () => {
    const mode = buildAgeModeSection(input(5));
    expect(mode).toContain('A real low point is required');
    expect(mode).toContain('own idea turns it');
    expect(mode).toContain('never a power handed over at the last moment');
  });

  it('the fear-choice band keeps the ONE clause the band file does not carry', () => {
    const shape = buildStoryShapeSection(input(4), 18, { arc: true });
    expect(shape).toContain('Nothing frightening beyond the fear the story is about');
    // ...and drops the two the band file does carry.
    expect(shape).not.toContain('beaten by wit or kindness');
    expect(shape).not.toContain("Challenges resolve through the main character's own choice");
    expect(buildAgeModeSection(input(4))).toContain('beaten by wit, by kindness');
  });

  it('STORY SHAPE keeps everything that is its OWN', () => {
    const shape = buildStoryShapeSection(input(5), 18, { arc: true });
    expect(shape).toContain('Main character: Levin (5)');
    expect(shape).toContain('Build the story on three or four challenges');
    expect(shape).toContain('every challenge is one a small child solves by trying');
    expect(shape).toContain('Cause: what the main character does');
  });

  it('the NON-arc path keeps the band rule — its consumer has no band file', () => {
    // storyScorecard.js pushes buildAgeModeSection only when arc is true, so a
    // non-arc judge reading STORY SHAPE alone must still be told the rule.
    expect(buildStoryShapeSection(input(5), 18)).toContain('A real low point before the end is required');
    expect(buildStoryShapeSection(input(4), 18)).toContain('beaten by wit or kindness');
  });

  it('no age where the arc drops a rule leaves it unstated anywhere', () => {
    for (const age of [0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 17, 40, 68]) {
      const mode = buildAgeModeSection(input(age)) || '';
      expect(mode.trim()).not.toBe('');
    }
  });
});
