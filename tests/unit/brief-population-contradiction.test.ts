/**
 * A BRIEF MAY NOT PEOPLE A SETTING ITS OWN METADATA DECLARES EMPTY
 * (staging job_1789853503332_riqncqg1i p1, 2026-09-20).
 *
 * `population` is the one field the evaluator's SETTING POPULATION line and the
 * presence arithmetic both read, and neither ever infers it from prose. That
 * page declared `cast_only` for a cast of two while its own prose ordered three
 * boys on scooters through the midground and unnamed adults at the chess boards
 * in the background. The renderer drew them, the arithmetic counted five surplus
 * figures and billed a CRITICAL `extra_character`, the consolidator refused the
 * "remove five figures" fix as un-inpaintable, and the semantic judge scored the
 * same page 100 with those figures in `expected.characters`. The page shipped at
 * 45.
 *
 * What is pinned: the contradiction is DETECTED as a brief fault, it reaches the
 * scene review's findings block, and the prose that legitimately refers to the
 * cast collectively is not mistaken for strangers. Never the wording.
 */
import { describe, it, expect } from 'vitest';

const {
  checkPopulationContradiction, checkPage, renderFindingsBlock, REVIEWABLE,
} = require('../../server/lib/sceneBriefCheck');
const { INTRODUCED_TYPES } = require('../../server/lib/iterateBeat');
const fs = require('fs');
const path = require('path');

const CAST = ['Levin', 'Julian', 'Max', 'Kiaan'];

/** Verbatim from that page's stored `sceneMetadata.fullData`. */
const P1_META = {
  fullData: {
    population: 'cast_only',
    sceneIntent:
      'Levin kneels on the paved Lindenhof and digs with his right hand into a thick layer of red and yellow autumn leaves. '
      + 'The midground scooter riders blur past the stone wall, and background adults pack chess pieces beneath autumn trees; '
      + 'the afternoon is cool and bright under a windy sky.',
    imageSummary:
      'In the midground, three older boys on metal scooters blur past the stone wall, seen from behind. '
      + 'In the background, unnamed adults pack wooden chess pieces at outdoor chess boards beneath large mature trees.',
  },
};

describe('population_contradicted', () => {
  it('fires on a cast_only page whose prose stages background people', () => {
    const f = checkPopulationContradiction({ pageNumber: 1, brief: 'prose' }, P1_META, CAST);
    expect(f, 'the stored p1 brief is faulted').toBeTruthy();
    expect(f.type).toBe('population_contradicted');
    expect(f.clauses.length).toBeGreaterThan(0);
    // The finding must name the two states that resolve it, or the reviewer has
    // no fix to apply.
    expect(f.detail).toMatch(/ambient/);
    expect(f.detail).toMatch(/crowd/);
  });

  it('is silent once the page declares the population its prose describes', () => {
    for (const population of ['ambient', 'crowd']) {
      const meta = { fullData: { ...P1_META.fullData, population } };
      expect(checkPopulationContradiction({ pageNumber: 1, brief: '' }, meta, CAST),
        `${population} pages are not faulted`).toBeNull();
    }
  });

  it('does not mistake the cast for strangers', () => {
    // Every one of these is verbatim prose from a stored cast_only brief that
    // the first, looser version of this check faulted.
    const castProse = [
      'Medium shot framed on the two boys and the egg, the natural root hollow visible below them.',
      'The four boys kneel around the root hollow in the dark, looking down at the egg.',
      'All four boys crowd around the egg, each pressing one hand against its smooth shell.',
      'The three boys move across the gravel toward the fountain together in one restless line.',
      'The medium wide shot captures the two boys crossing the open gravel area, while far in the background behind them, the tower rises.',
    ];
    for (const prose of castProse) {
      const meta = { fullData: { population: 'cast_only', sceneIntent: prose, imageSummary: prose } };
      expect(checkPopulationContradiction({ pageNumber: 4, brief: prose }, meta, CAST),
        `not a fault: ${prose.slice(0, 40)}`).toBeNull();
    }
  });

  it('reads a page that says the place is empty as agreeing with cast_only', () => {
    const prose = 'No other people are present in the background of the quiet courtyard.';
    const meta = { fullData: { population: 'cast_only', sceneIntent: prose, imageSummary: prose } };
    expect(checkPopulationContradiction({ pageNumber: 4, brief: prose }, meta, CAST)).toBeNull();
  });

  it('reaches the scene review and the iterate re-ask', () => {
    expect(REVIEWABLE.has('population_contradicted'), 'sent to the scene review').toBe(true);
    expect(INTRODUCED_TYPES.has('population_contradicted'), 'checked on an iterate rewrite').toBe(true);
    const byPage = new Map([[1, [{ pageNumber: 1, type: 'population_contradicted', detail: 'D' }]]]);
    expect(renderFindingsBlock(byPage)).toContain('[population_contradicted]');
  });

  it('checkPage produces it, so every caller of the brief checks gets it', () => {
    const brief = `${P1_META.fullData.imageSummary}\n---METADATA---\n${JSON.stringify({ population: 'cast_only', characters: [] })}`;
    const findings = checkPage({ pageNumber: 1, brief }, CAST, null, {});
    expect(findings.some((f: any) => f.type === 'population_contradicted')).toBe(true);
  });

  it('the scene review answers the tag', () => {
    const tpl = fs.readFileSync(path.join(__dirname, '../../prompts/scene-review.txt'), 'utf8');
    expect(tpl).toContain('[population_contradicted]');
  });
});
