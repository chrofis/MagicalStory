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
  it('no fault may cite a page number — and both templates are told so', () => {
    const line = 'The arc has no pages: no fault names a page number or a position in pages.';
    expect(arcCritiqueSpec()).toContain(line);
    expect(arcCritiqueSpec({ retell: true })).toContain(line);
    expect(buildArcCreatePrompt(input(), 18, {})).toContain(line);
    expect(buildArcRetellPrompt(input(), 18, 'ARC 1: ...', '')).toContain(line);
  });

  it('both templates fill from the same builder, with no placeholder left', () => {
    const create = buildArcCreatePrompt(input(), 18, {});
    const retell = buildArcRetellPrompt(input(), 18, 'ARC 1: ...', '');
    expect(create).not.toContain('{ARC_CRITIQUE_SPEC}');
    expect(retell).not.toContain('{ARC_CRITIQUE_SPEC}');
    expect(create).toContain(arcCritiqueSpec());
    expect(retell).toContain(arcCritiqueSpec({ retell: true }));
  });

  it('the questions are numbered and the count is honest', () => {
    const spec = arcCritiqueSpec();
    expect(spec).toContain('numbered 1 to 6');
    for (const n of [1, 2, 3, 4, 5, 6]) expect(spec).toMatch(new RegExp(`^${n}\. `, 'm'));
    expect(spec).not.toContain('ten questions');
  });

  it('mechanical verdicts report outside the 3-6 fault budget', () => {
    const spec = arcCritiqueSpec();
    expect(spec).toContain('"Checks:"');
    expect(spec).toContain('they never take a place in the numbered list below');
    for (const check of ['- Events:', '- Surplus facts:', '- Invented figures:', '- Central figure:', '- Commission honored:']) {
      expect(spec).toContain(check);
    }
    expect(spec).toContain('3 to 6 numbered story-level faults');
  });

  it('the per-page questions are gone — the arc has sentences, not pages', () => {
    const spec = arcCritiqueSpec();
    expect(spec).not.toContain('action load per page');
    expect(spec).not.toContain('name the page each surplus fact belongs on');
    // The event half of the surplus-facts check survives.
    expect(spec).toContain('one figure tells more than one thing the reader did not already know');
  });

  it('keeps the parser contract: the figure lists open the create critique, and are not repeated in the re-tell', () => {
    expect(arcCritiqueSpec()).toContain('"Premise figures:"');
    expect(arcCritiqueSpec()).toContain('"Invented figures:"');
    expect(arcCritiqueSpec()).toContain('"Allowed: <N>. Written: <M>."');
    // arc-retell.txt declares both as its own top-level output bullets.
    expect(arcCritiqueSpec({ retell: true })).not.toContain('"Premise figures:"');
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
