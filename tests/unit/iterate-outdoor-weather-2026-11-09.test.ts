/**
 * An iterate rewrite of an OUTDOOR page must not ship `weather: none` (the indoor value): with
 * it the page prompt's LIGHT line takes the indoor variant ("dark at the windows, the room lit
 * only by its own lamps"), and an outdoor night forest is painted bright (prod
 * job_1794231161354_l3n2o3afm p8 v1/v2, p9, p11, p15). pinBrief reported the problem and
 * iteratePageCore kept only the fields it restored, and the rewrite was never told the page's
 * decided light at all. Stored replay 2026-11-09: 30 of 72 outdoor sky rewrites (staging + prod
 * eval_calls iterate_rebrief) wrote `none`; the check flags all 30 and no indoor or skyless page.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import { createRequire } from 'module';

const req = createRequire(import.meta.url);
const { weatherNoneOutdoorsFinding } = req('../../server/lib/briefChecks');
const { fixedBlock, isOutdoorSky } = req('../../server/lib/jevDecisions');
const { buildSceneDescriptionPrompt } = req('../../server/lib/promptBuilders');
const { loadPromptTemplates } = req('../../server/services/prompts');

const brief = (meta: any) => `Prose.\n\n---METADATA---\n${JSON.stringify({ characters: [], objects: [], ...meta })}`;
const outdoorNight = { timeOfDay: 'night', indoor: false };
// The rewrite's FIXED block (since 2026-11-09 the whole block, not the light line alone).
const rewriteCtx = (planLine: string, jf: any) => ({ planLine, fixedBlock: fixedBlock({ jevFixed: jf }, { rewrite: true }), fixedOutdoors: isOutdoorSky(jf) });

beforeAll(async () => { await loadPromptTemplates(); });

describe('weatherNoneOutdoorsFinding', () => {
  it('flags an outdoor page whose brief says weather none or nothing', () => {
    expect(weatherNoneOutdoorsFinding(8, brief({ timeOfDay: 'night', weather: 'none' }), outdoorNight)?.type).toBe('weather_none_outdoors');
    expect(weatherNoneOutdoorsFinding(8, brief({ timeOfDay: 'night' }), outdoorNight)?.type).toBe('weather_none_outdoors');
  });
  it('leaves an outdoor sky, an indoor page and a skyless page alone', () => {
    expect(weatherNoneOutdoorsFinding(8, brief({ weather: 'clear' }), outdoorNight)).toBeNull();
    expect(weatherNoneOutdoorsFinding(1, brief({ weather: 'none' }), { timeOfDay: 'night', indoor: true })).toBeNull();
    expect(weatherNoneOutdoorsFinding(3, brief({ weather: 'none' }), { timeOfDay: 'underwater', indoor: false })).toBeNull();
    expect(weatherNoneOutdoorsFinding(3, brief({ weather: 'none' }), null)).toBeNull();
  });
});

describe('the iterate rewrite', () => {
  const src = fs.readFileSync(new URL('../../server/lib/images.js', import.meta.url), 'utf8');
  it('sends an outdoor weather none to its one corrective re-ask', () => {
    expect(src).toContain("require('./briefChecks').weatherNoneOutdoorsFinding(pageNumber, text, savedScene?.jevFixed)");
  });
  it('is given the page\'s decided light', () => {
    expect(src).toContain("fixedOutdoors: require('./jevDecisions').isOutdoorSky(savedScene?.jevFixed)");
    const p = buildSceneDescriptionPrompt(8, 'They stop at the edge of the dark forest.', [], 'a forest edge', 'en', null, [], null, '', [],
      rewriteCtx('wide — Amaya, Fabiola — they stop at the fork', outdoorNight), null, {});
    expect(p).toContain('- timeOfDay: night; outdoors');
    expect(p).toContain('outdoors, `weather` is an outdoor value, never `none`');
  });
  it('an indoor page is not told the outdoor clause', () => {
    const p = buildSceneDescriptionPrompt(1, 'Bedtime.', [], 'a bedroom', 'en', null, [], null, '', [],
      rewriteCtx('medium — Amaya — bedtime', { timeOfDay: 'night', indoor: true }), null, {});
    expect(p).toContain('- timeOfDay: night; indoors (weather none)');
    expect(p).not.toContain('never `none`');
  });
});
