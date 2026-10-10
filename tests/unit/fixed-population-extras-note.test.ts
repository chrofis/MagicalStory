/**
 * An ambient or crowd page's FIXED line asks for dressed extras where the author reads it.
 * Staging job_1791497309909_6quecrr9t: four `ambient` pages, no extras named in any brief,
 * extras drawn in the cast's colours.
 */
import { describe, it, expect } from 'vitest';
import { trialWriterPrompt } from './helpers/trialWriterPrompt';
const PB = require('../../server/lib/promptBuilders');

const page = (population: string, n = 1) => ({
  pageNumber: n, planLine: 'wide — A — x — y',
  jevFixed: { shot: 'wide', timeOfDay: 'dusk', indoor: false, location: 'LOC001', cites: [], aboard: null, population, looksAt: {}, labels: {} },
});

describe('FIXED population line', () => {
  it.each(['ambient', 'crowd'])('%s asks for garment kind and a colour no cast member wears', (pop) => {
    const b = PB.planBlocks([page(pop)]);
    expect(b).toMatch(new RegExp(`- population: ${pop} — .*garment kind and a colour no cast member wears`));
  });
  it.each(['cast_only', 'sparse', 'wildlife'])('%s adds nothing', (pop) => {
    const b = PB.planBlocks([page(pop)]);
    expect(b).toContain(`- population: ${pop}\n`.trimEnd());
    expect(b).not.toContain('no cast member wears');
  });
});

describe('POPULATION_FIELD_RULE (trial writer and Jev-outage backup)', () => {
  it('tells the author to dress unnamed people apart from the cast', async () => {
    const { loadPromptTemplates } = require('../../server/services/prompts');
    await loadPromptTemplates();
    const t = trialWriterPrompt({ characters: [{ id: 'c1', name: 'Mia', age: 7, gender: 'girl' }], mainCharacters: ['c1'], language: 'de-ch', storyCategory: 'adventure', storyTheme: 'pirate', storyDetails: 'x', artStyle: 'watercolor' }, 6);
    expect(t).toContain('a colour no cast member wears');
  });
});
