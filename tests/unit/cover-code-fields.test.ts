/**
 * THE COVERS' CODE-OWNED FIELDS (owner, 2026-10-05): shot, light, population,
 * era and gaze are decided by code on a cover and pinned into its METADATA; the
 * Art Director no longer writes them. Pins behaviour, never prompt wording.
 * Archetypal fixtures only. see docs/decisions.md 2026-10-05 "The covers' fields are code's"
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);
const JBF = req('../../server/lib/jevBriefFields');
const JD = req('../../server/lib/jevDecisions');
const { extractSceneMetadata } = req('../../server/lib/sceneMetadata');

const pg = (n: number, timeOfDay: string, indoor = false, weatherAdvice = 'clear') => ({ pageNumber: n, fixed: { timeOfDay, indoor, weatherAdvice } });

describe('coverLight: the book\'s light, by cover', () => {
  // afternoon x3 outdoors, one indoor morning page 1, dusk last
  const story = [pg(1, 'morning', true, 'none'), pg(2, 'afternoon', false, 'overcast'), pg(3, 'afternoon', false, 'rain'), pg(4, 'afternoon', false, 'clear'), pg(5, 'dusk', false, 'clear')];
  it('the front cover takes the dominant outdoor light, from the first page holding it', () => {
    expect(JBF.coverLight('frontCover', story)).toEqual({ timeOfDay: 'afternoon', indoor: false, weather: 'overcast', sourcePage: 2 });
  });
  it('the title page takes page 1\'s light, indoors and weather none with it', () => {
    expect(JBF.coverLight('initialPage', story)).toEqual({ timeOfDay: 'morning', indoor: true, weather: 'none', sourcePage: 1 });
  });
  it('the back cover takes the last page\'s light', () => {
    expect(JBF.coverLight('backCover', story)).toMatchObject({ timeOfDay: 'dusk', sourcePage: 5 });
  });
  it('a tie in the front cover goes to the light reached first; a book with no outdoor page uses all pages', () => {
    expect(JBF.coverLight('frontCover', [pg(1, 'morning'), pg(2, 'dusk')]).timeOfDay).toBe('morning');
    expect(JBF.coverLight('frontCover', [pg(1, 'night', true, 'none'), pg(2, 'night', true, 'none'), pg(3, 'dawn', true, 'none')]).timeOfDay).toBe('night');
  });
  it('an outdoor source page whose weather advice is none pins no weather (never none outdoors)', () => {
    // staging job_1791145238223_50osg2osm: Jev advised none on outdoor pages 3-10
    const f = JBF.coverLight('backCover', [pg(1, 'dusk'), pg(2, 'dusk', false, 'none')]);
    expect(f.timeOfDay).toBe('dusk');
    expect(f.weather).toBeUndefined();
    expect(JBF.coverFacts({ coverKey: 'backCover', storyBeats: [pg(1, 'dusk', false, 'none')] }).weather).toBeUndefined();
  });
  it('no decided light on any page: nothing to pin', () => {
    expect(JBF.coverLight('frontCover', [{ pageNumber: 1 }])).toBeNull();
  });
});

describe('coverFacts', () => {
  const story = [pg(1, 'morning'), pg(2, 'dusk')];
  it('always the wide shot and the viewer gaze; the rest only where code has a value', () => {
    expect(JBF.coverFacts({ coverKey: 'backCover', storyBeats: [] })).toEqual({ coverPlace: true, shot: 'wide', looksAtAll: 'viewer' });
  });
  it('light, the location\'s population and the era join when decided; the vantage id reads its base location', () => {
    const f = JBF.coverFacts({ coverKey: 'backCover', storyBeats: story, location: 'LOC001.3', population: { LOC001: { population: 'ambient' } }, era: ' medieval ' });
    expect(f).toMatchObject({ shot: 'wide', timeOfDay: 'dusk', indoor: false, weather: 'clear', population: 'ambient', era: 'medieval' });
  });
  it('a location with no population decision leaves population to the Art Director', () => {
    expect(JBF.coverFacts({ coverKey: 'backCover', storyBeats: story, location: 'LOC009.1', population: { LOC001: { population: 'ambient' } } }).population).toBeUndefined();
  });
});

describe('the cover FIXED block and its pin', () => {
  const brief = `Prose.\n\n---METADATA---\n${JSON.stringify({ shot: 'medium', timeOfDay: 'morning', weather: 'rain', era: 'present day', population: 'cast_only', objects: ['LOC001.1', 'ART001'], characters: [{ name: 'A', looksAt: 'B' }, { name: 'B', looksAt: 'away' }] }, null, 2)}`;
  const fixed = { coverPlace: true, location: 'LOC001.3', labels: { 'LOC001.3': 'square, steps' }, shot: 'wide', timeOfDay: 'dusk', indoor: false, weather: 'clear', population: 'ambient', era: 'medieval', looksAtAll: 'viewer' };
  it('the block lists every code-owned field and never objects', () => {
    const block = JD.fixedBlock({ jevFixed: fixed });
    for (const w of ['shot: wide', 'timeOfDay: dusk', 'weather clear', 'LOC001.3', 'population: ambient', 'era: medieval', 'looksAt: every figure']) expect(block).toContain(w);
    expect(block).not.toMatch(/- objects:/);
  });
  it('a cover with no decided place or light still states the shot and the gaze', () => {
    const block = JD.fixedBlock({ jevFixed: { coverPlace: true, shot: 'wide', looksAtAll: 'viewer' } });
    expect(block).toContain('shot: wide');
    expect(block).not.toContain('location:');
  });
  it('on the outage backup the pin runs but no FIXED block is shown', () => {
    expect(JD.fixedBlock({ jevFixed: { coverPlace: true, shot: 'wide', looksAtAll: 'viewer', quiet: true } })).toBe('');
  });
  it('the pin overwrites whatever the Art Director wrote, every figure looks at the viewer', () => {
    const m = extractSceneMetadata(JD.pinBrief(brief, fixed).brief);
    const d = (m.fullData || m);
    expect(d).toMatchObject({ shot: 'wide', timeOfDay: 'dusk', weather: 'clear', population: 'ambient' });
    expect(m.era).toBe('medieval');
    expect(d.objects).toEqual(['LOC001.3', 'ART001']);
    expect(d.characters.map((c: any) => c.looksAt)).toEqual(['viewer', 'viewer']);
  });
  it('a story page\'s weather is still the Art Director\'s: no weather in its FIXED, no weather written', () => {
    const r = JD.pinBrief(brief, { shot: 'wide', timeOfDay: 'dusk', indoor: false });
    expect(((extractSceneMetadata(r.brief) || {}) as any).weather ?? 'rain').toBe('rain');
  });
});
