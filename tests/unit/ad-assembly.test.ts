/**
 * THE ART DIRECTOR WRITES ONLY WHAT IT AUTHORS; CODE ASSEMBLES THE REST (owner,
 * 2026-10-05: "Why ask Gemini to output the same fields code decides?";
 * docs/decisions.md 2026-10-05, which supersedes 2026-09-27 point 5).
 *
 * Pins: (1) a brief without the decided fields parses and is assembled to the
 * same metadata the pre-change run pinned; (2) the decided fields always come
 * from the decisions, whatever the author wrote; (3) the two path gates — the
 * Jev path's templates ask for no decided field, the backup's are the template
 * as it was; (4) the re-ask and the page-brief step merge without reporting
 * disobedience.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);
const JD = req('../../server/lib/jevDecisions.js');
const PB = req('../../server/lib/promptBuilders.js');
const { assessSceneBrief } = req('../../server/lib/iterateBriefGuard.js');
const { parseProseMetadataFormat } = req('../../server/lib/sceneMetadata.js');
const { assembleBriefs } = req('../../server/lib/jevBriefFields.js');
const { fixedOfBlock, coverFixedOfBlock, stripDecided } = req('../../scripts/analysis/replay-ad-assembly.js');
const { loadPromptTemplates } = req('../../server/services/prompts.js');

const metaOf = (b: string) => (parseProseMetadataFormat(b) || {}).metadata;
const brief = (m: any) => `Ana and Ben on the quay.\n\n---METADATA---\n${JSON.stringify({ sceneIntent: 'Ana waves.', ...m })}`;

// What the Art Director wrote before this change: every field.
const WRITTEN_BY_TODAY_AD = {
  characters: [
    { name: 'Ana', clothing: 'standard', position: 'left foreground', depth: 'foreground', looksAt: 'ANI001', expression: 'brows up', emotion: 'happy' },
    { name: 'Ben', clothing: 'standard', position: 'right midground', depth: 'midground', looksAt: 'Ana', expression: 'calm', emotion: 'neutral' },
  ],
  shot: 'wide', population: 'ambient', aboard: 'VEH001', era: 'present day', timeOfDay: 'dusk', weather: 'none',
  objects: ['LOC001.2', 'ANI001', 'CLO001'], interactions: [], wornItems: [],
};
const FIXED_BLOCK = [
  'FIXED — code writes each into METADATA (write none of them); the prose shows each:',
  '- shot: wide',
  '- timeOfDay: dusk; indoors (weather none)',
  '- objects: LOC001.2 (harbour, quay steps); ANI001 (Drako)',
  '- aboard: VEH001 (boat)',
  '- population: ambient',
  '- looksAt: Ana → ANI001 (Drako); Ben → away',
].join('\n');
const CTX = { decidedIds: ['ANI001', 'ART009', 'VEH001'], aboardIds: ['VEH001'] };

describe('the assembled brief equals what the run pinned before the Art Director stopped writing the decided fields', () => {
  const fixed = fixedOfBlock(FIXED_BLOCK, CTX);

  it('the FIXED block reads back into the decisions', () => {
    expect(fixed).toMatchObject({ shot: 'wide', timeOfDay: 'dusk', indoor: true, location: 'LOC001.2', cites: ['ANI001'], aboard: 'VEH001', population: 'ambient', looksAt: { Ana: 'ANI001', Ben: 'away' } });
  });

  it('a brief stripped of every decided field is a usable brief, and assembles to the same metadata', () => {
    const today = metaOf(JD.pinBrief(brief(WRITTEN_BY_TODAY_AD), fixed).brief);
    const stripped = stripDecided(brief(WRITTEN_BY_TODAY_AD), fixed);
    expect(assessSceneBrief(stripped.text).usable).toBe(true);
    for (const k of ['shot', 'population', 'aboard', 'timeOfDay']) expect(stripped.metadata[k], k).toBeUndefined();
    expect(stripped.metadata.characters.every((c: any) => c.looksAt === undefined)).toBe(true);
    expect(stripped.metadata.objects).toEqual(['CLO001']);                       // only what the FIXED block does not list
    const assembled = metaOf(JD.pinBrief(stripped.text, fixed).brief);
    expect(assembled).toEqual(today);
    expect(assembled.objects).toEqual(['LOC001.2', 'ANI001', 'CLO001']);         // location, decided cites, then the author's own ids
    expect(assembled.weather).toBe('none');                                      // indoors: the author's `none`, and code pins it too
    const forgot = metaOf(JD.pinBrief(brief({ ...stripped.metadata, weather: undefined }), fixed).brief);
    expect(forgot.weather).toBe('none');                                         // an indoor page whose author forgot it still gets `none`
  });

  it('the decided fields always come from the decisions, whatever the author wrote', () => {
    const stray = { ...WRITTEN_BY_TODAY_AD, shot: 'close-up', population: 'cast_only', timeOfDay: 'morning', aboard: null, objects: ['LOC009', 'ANI001', 'ART009', 'CLO001'] };
    const m = metaOf(JD.pinBrief(brief(stray), fixed).brief);
    expect(m).toMatchObject({ shot: 'wide', population: 'ambient', timeOfDay: 'dusk', aboard: 'VEH001', weather: 'none' });
    expect(m.objects).toEqual(['LOC001.2', 'ANI001', 'CLO001']);                 // another LOC and an undecided-away element leave
    expect(m.characters.map((c: any) => c.looksAt)).toEqual(['ANI001', 'away']);
  });

  it('weather stays the author\'s outdoors: an outdoor page without one is reported for the brief check, never guessed', () => {
    const outdoors = { ...fixed, indoor: false };
    const noWeather = brief({ ...stripDecided(brief({ ...WRITTEN_BY_TODAY_AD, weather: undefined }), outdoors).metadata });
    const p = JD.pinBrief(noWeather, outdoors);
    expect(p.changes.find((c: any) => c.problem === 'outdoors')).toBeTruthy();
    expect(metaOf(p.brief).weather).toBeUndefined();
    const written = brief({ ...stripDecided(brief(WRITTEN_BY_TODAY_AD), outdoors).metadata, weather: 'overcast' });
    expect(metaOf(JD.pinBrief(written, outdoors).brief).weather).toBe('overcast');
  });

  it('a cover\'s FIXED block holds its location alone: code writes it first, the author\'s other ids follow', () => {
    const cover = coverFixedOfBlock('FIXED — code writes it into METADATA; the prose shows it:\n- location: LOC001.1 (harbour, wide view) — code puts it first in objects[]; write the cover\'s other ids after it, following its beat');
    expect(cover).toEqual({ location: 'LOC001.1', coverPlace: true });
    const written = brief({ ...WRITTEN_BY_TODAY_AD, objects: ['LOC001.1', 'ANI001', 'CLO001'] });
    const stripped = stripDecided(written, cover);
    expect(stripped.metadata.objects).toEqual(['ANI001', 'CLO001']);
    expect(stripped.metadata.shot).toBe('wide');                                 // a cover's shot, population, light are the author's
    const m = metaOf(JD.pinBrief(stripped.text, cover).brief);
    expect(m.objects).toEqual(['LOC001.1', 'ANI001', 'CLO001']);
    expect(m.shot).toBe('wide');
  });

  it('assembleBriefs merges into every page that has decisions, leaves one without, and reports nothing for a normal merge', () => {
    const events: any[] = [];
    const gl = { info: () => {}, warn: (...a: any[]) => events.push(['warn', ...a]), error: (k: string) => events.push(['error', k]) };
    const stripped = stripDecided(brief(WRITTEN_BY_TODAY_AD), fixed).text;
    const free = brief({ ...WRITTEN_BY_TODAY_AD, shot: 'medium' });
    const expansions = [{ pageNumber: 1, brief: stripped }, { pageNumber: 2, brief: free }, { pageNumber: 3, brief: 'prose with no metadata at all' }];
    assembleBriefs(expansions, [{ pageNumber: 1, jevFixed: fixed }, { pageNumber: 2 }, { pageNumber: 3, jevFixed: fixed }], gl);
    expect(metaOf(expansions[0].brief).shot).toBe('wide');
    expect(expansions[1].brief).toBe(free);
    expect(events).toEqual([['error', 'beats_jev_brief_unparsed']]);             // only a brief that cannot be assembled is loud
  });
});

describe('the two path gates of the Art Director templates', () => {
  beforeAll(async () => { await loadPromptTemplates(); });
  const story = { characters: [], language: 'en', season: 'summer' };
  const beats = [{ pageNumber: 1, planLine: 'wide — Ana — x — y' }];
  const build = (site: 'all' | 'one', jevBackup: boolean) => String(site === 'all'
    ? PB.buildSceneBriefsAllPrompt(story, beats, { jevBackup })
    : PB.buildSceneExpansionPrompt(1, 'PLAN: x', [], 'en', null, '', null, { jevBackup, story }));
  // The fenced JSON example alone (the paragraph after it names the fields a cover writes).
  const exampleOf = (p: string) => p.slice(p.indexOf('Then a single-line JSON object:')).split('```')[1];

  for (const site of ['all', 'one'] as const) {
    it(`${site}: the Jev path's example and rules ask for no decided field; no gate marker survives`, () => {
      const p = build(site, false);
      const ex = exampleOf(p);
      for (const k of ['"shot"', '"population"', '"aboard"', '"timeOfDay"', '"looksAt"']) expect(ex, `${site} example ${k}`).not.toContain(k);
      expect(ex).toContain('"weather": "clear"');
      expect(ex).toContain('"objects": ["CLO001"]');
      expect(p).toContain(JD.JEV_FIXED_FIELDS_RULE);
      expect(p).toContain(req('../../server/lib/sceneLight.js').SCENE_WEATHER_FIELD_RULE);   // the clock is code's, the weather stays the author's on every page
      expect(p).not.toContain(req('../../server/lib/sceneLight.js').SCENE_LIGHT_FIELD_RULE);
      expect(p).not.toMatch(/JEV_(BACKUP|FIXED)_(BEGIN|END)/);
    });
    it(`${site}: the backup's example still carries every field`, () => {
      const p = build(site, true);
      const ex = exampleOf(p);
      for (const k of ['"shot"', '"population"', '"aboard"', '"timeOfDay"', '"looksAt"', '"weather": "none"']) expect(ex, `${site} backup ${k}`).toContain(k);
      expect(p).not.toContain('FIXED');
      expect(p).not.toMatch(/JEV_(BACKUP|FIXED)_(BEGIN|END)/);
    });
  }

  it('applyJevGate: a marker alone on its line takes the line, an inline one takes nothing but itself', () => {
    const t = 'a\n<!-- JEV_FIXED_BEGIN -->\nx\n<!-- JEV_FIXED_END -->\nb **y**<!-- JEV_FIXED_BEGIN --> (z)<!-- JEV_FIXED_END -->\n- c <!-- JEV_BACKUP_BEGIN -->d<!-- JEV_BACKUP_END -->';
    expect(PB.applyJevGate(t, false)).toBe('a\nx\nb **y** (z)\n- c ');
    expect(PB.applyJevGate(t, true)).toBe('a\nb **y**\n- c d');
  });
});
