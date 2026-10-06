/**
 * UNDERWATER AND DARK ARE LIGHTS, NOT HOURS (owner, 2026-10-06; supersedes the 2026-09-24 "one of seven
 * hours" line for pages with no sky). Staging job_1791267520938_essbvehs8 p5, p7 and p9-p12 were drawn at the
 * surface or on dry land under an hour's sun and sky (job ypl33 p9: a bright reef against pitch-black ink).
 * Pins behaviour: the enum, that no line built for a skyless page names a sun, moon, sky, horizon or
 * daylight, that the clock goes on around such a page, and that Jev's light answer for it is `indoor`
 * (weather `none`). Never the phrase wording.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { makeJevStub } from '../helpers/jev-stub';

const req = createRequire(import.meta.url);
const SL = req('../../server/lib/sceneLight');
const JD = req('../../server/lib/jevDecisions');
const { buildSeasonNote } = req('../../server/lib/season');

const SKY_WORDS = /\b(sun|moon|sky|skies|horizon|daylight)\b/i;

describe('the enum', () => {
  it('keeps the seven hours and adds the two skyless lights after them', () => {
    expect(SL.CLOCK_HOURS).toEqual(['dawn', 'morning', 'midday', 'afternoon', 'evening', 'dusk', 'night']);
    expect(SL.TIMES_OF_DAY).toEqual([...SL.CLOCK_HOURS, 'underwater', 'dark']);
    expect(SL.normaliseTimeOfDay('Underwater')).toBe('underwater');
    expect(SL.declaredLight({ timeOfDay: 'dark', weather: 'none' })).toEqual({ timeOfDay: 'dark', weather: 'none' });
  });
  it('the brief authors are told the two values and what they take', () => {
    expect(SL.SCENE_LIGHT_FIELD_RULE).toContain('underwater');
    expect(SL.SCENE_LIGHT_FIELD_RULE).toContain('dark');
    expect(SL.SCENE_WEATHER_FIELD_RULE).toContain(SL.SKYLESS_LIGHT_RULE);
  });
});

describe('a skyless page is never given sun or sky wording', () => {
  for (const t of ['underwater', 'dark']) {
    for (const weather of ['clear', 'fog', 'none']) {
      it(`${t} / ${weather}: page, plate, repair, relight, derive and judge lines`, () => {
        const light = { timeOfDay: t, weather };
        const lines = [
          SL.buildLightLine(light),
          SL.buildLightLine(light, { plate: true }),
          SL.buildRepairLightLine(light),
          SL.buildPlateRelightInstruction(light),
          SL.relightClause(light),
          SL.keepLightClause(light),
          SL.describeLightForJudge(light),
        ];
        for (const l of lines) expect(l, l).not.toMatch(SKY_WORDS);
      });
    }
  }
  it('an hour still names its sky (nothing else changed)', () => {
    expect(SL.buildLightLine({ timeOfDay: 'dusk', weather: 'clear' })).toMatch(/sky/);
  });
  it('the season note drops the sky and the daylight for a skyless page only', () => {
    const season = { season: 'autumn' };
    expect(buildSeasonNote(season, { skyless: true })).not.toMatch(SKY_WORDS);
    expect(buildSeasonNote(season, {})).toMatch(/sky and daylight/);
  });
  it('a skyless light is contradicted by a daylight read and by nothing else', () => {
    expect(SL.timeContradicts('underwater', 'afternoon')).toBe(true);
    expect(SL.timeContradicts('dark', 'midday')).toBe(true);
    expect(SL.timeContradicts('dark', 'night')).toBe(false);
    expect(SL.timeContradicts('underwater', 'dusk')).toBe(false);
    expect(SL.timeContradicts('dusk', 'night')).toBe(false);
  });
});

describe('Jev light: the clock goes on around a skyless page', () => {
  it('a skyless page is not an hour: it neither moves the clock nor is held by it', () => {
    expect(JD.forwardClock(['evening', 'underwater', 'dusk', 'dark', 'morning', 'underwater', 'afternoon']).times)
      .toEqual(['evening', 'underwater', 'dusk', 'dark', 'morning', 'underwater', 'afternoon']);
    // the hour before and after is still held: a dark page between two evenings does not let the next one step back
    expect(JD.forwardClock(['dusk', 'dark', 'afternoon']).times).toEqual(['dusk', 'dark', 'dusk']);
  });
  it('the TIME question offers both values with what they mean', () => {
    const q = JD.lightQuestions().TIME;
    expect(Object.keys(q.criteria)).toEqual(SL.TIMES_OF_DAY);
    expect(q.criteria.dark).toMatch(/cave/);
    expect(q.criteria.underwater).toMatch(/beneath the surface/);
  });
  it('a skyless answer is indoor (weather none) whatever the INDOOR question said', async () => {
    // the stub picks the first TIME criterion (`dawn`); give it the skyless one through the answer shape
    const stub = makeJevStub({ noul: () => 0.0 });
    const impl = async (args: any) => {
      const r = await stub.impl(args);
      r.answers.TIME = { choice: 'underwater', probabilities: { underwater: 1 } };
      return r;
    };
    const d = await JD.decideLight({ arc: 'A', pages: [{ pageNumber: 1, planLine: 'SHOT — Ana — swims — y' }] }, { callImpl: impl });
    expect(d.pages[0].timeOfDay).toBe('underwater');
    expect(d.pages[0].indoor).toBe(true);
  });
  it('the FIXED line says no sky, never indoors or outdoors', () => {
    expect(JD.fixedLine({ timeOfDay: 'underwater', indoor: true })).toContain('no sky (weather none)');
    expect(JD.fixedLine({ timeOfDay: 'dusk', indoor: false })).toContain('outdoors');
    expect(JD.fixedBlock({ jevFixed: { timeOfDay: 'dark', indoor: true } })).toContain('no sky (weather none)');
  });
});
