/**
 * THE STORY'S OWN SEASON (owner, 2026-11-09, "Story's own date decides"; bug
 * season-ignores-story-date-christmas-drawn-autumn). A story that places itself in a season is drawn in it, whatever
 * the request or the creation date said. Jev answers over the arc (full pipeline), the trial planner answers in a
 * typed section; season.applyStorySeason is the one place the answer meets the resolver. Code never reads prose.
 * Archetypal fixtures only. see docs/decisions.md 2026-11-09 "The story's own season decides".
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const req = createRequire(import.meta.url);
const S = req('../../server/lib/season');
const JD = req('../../server/lib/jevDecisions');
const { loadPromptTemplates } = req('../../server/services/prompts');
const { runTrialWriter } = req('../../server/lib/trialWriter.js');
const BP = req('../../server/lib/beatsPipeline');

const NOV = '2026-11-03T10:00:00Z'; // autumn by the date
const gl = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
/** A Jev stand-in that answers the season question with `choice`. */
const jevSays = (choice: string) => async ({ questions }: any) => {
  const keys = Object.keys(questions.SEASON.criteria);
  return { answers: { SEASON: { choice, probabilities: Object.fromEntries(keys.map(k => [k, k === choice ? 0.97 : 0.0075])) } }, cost: 0, model: 'stub', usage: {} };
};

describe('resolver precedence: the story season, then the request, then the date', () => {
  it('the story overrides the request and keeps what was asked for', () => {
    const d: any = { season: 'autumn', createdAt: NOV };
    const r = S.applyStorySeason(d, 'winter');
    expect(r).toMatchObject({ season: 'winter', source: 'story', overridden: true, requested: 'autumn' });
    expect(d).toMatchObject({ season: 'winter', requestedSeason: 'autumn', seasonSource: 'story' });
    expect(S.resolveSeason(d)).toBe('winter');
    expect(S.buildSeasonNote(d)).toContain('**SEASON:** Winter');
  });

  it('the story overrides the creation date when the request carries no season', () => {
    const d: any = { season: '', createdAt: NOV };
    S.applyStorySeason(d, 'summer');
    expect(S.resolveSeason(d)).toBe('summer');
    expect(d.requestedSeason).toBe('autumn'); // what the date gave
  });

  it('none keeps the request, and with no request the date', () => {
    const asked: any = { season: 'spring', createdAt: NOV };
    expect(S.applyStorySeason(asked, 'none')).toMatchObject({ season: 'spring', source: 'request', overridden: false });
    expect(asked.seasonSource).toBeUndefined();
    const dated: any = { createdAt: NOV };
    S.applyStorySeason(dated, 'none');
    expect(S.resolveSeason(dated)).toBe('autumn');
  });

  it('a story that agrees with the request changes nothing but is marked as the story\'s', () => {
    const d: any = { season: 'autumn', createdAt: NOV };
    expect(S.applyStorySeason(d, 'autumn')).toMatchObject({ overridden: false, source: 'story' });
    expect(d.requestedSeason).toBeUndefined();
  });

  it('an answer outside the choices throws instead of passing as none', () => {
    const d: any = { season: 'autumn' };
    expect(() => S.applyStorySeason(d, 'monsoon')).toThrow(/outside spring\|summer\|autumn\|winter\|none/);
    expect(() => S.applyStorySeason(d, undefined)).toThrow();
    expect(d.season).toBe('autumn');
  });

  it('an old story with no field keeps its stored season through the resolver', () => {
    expect(S.resolveSeason({ season: 'summer', createdAt: NOV })).toBe('summer');
  });
});

describe('the trial planner typed section', () => {
  it('parses the value, tolerates brackets and case, rejects the echoed template and absence', () => {
    expect(S.parseStorySeasonSection('---STORY SEASON---\nSEASON: winter\n(x)')).toBe('winter');
    expect(S.parseStorySeasonSection('---STORY SEASON---\nSEASON: [Autumn]\r\n')).toBe('autumn');
    expect(S.parseStorySeasonSection('---STORY SEASON---\nSEASON: none\n')).toBe('none');
    expect(S.parseStorySeasonSection('---STORY SEASON---\nSEASON: [spring | summer | autumn | winter | none]\n')).toBeNull();
    expect(S.parseStorySeasonSection('---STORY SEASON---\nSEASON: monsoon\n')).toBeNull();
    expect(S.parseStorySeasonSection('---STORY ARC---\nPAGE 1: x')).toBeNull();
  });

  it('the trial planner template asks for the section between the arc and the title', () => {
    const t = fs.readFileSync(path.join(__dirname, '../../prompts/story-trial-arc.txt'), 'utf8');
    const i = t.indexOf('---STORY ARC---'), j = t.indexOf('---STORY SEASON---'), k = t.indexOf('---TITLE---');
    expect(i).toBeGreaterThan(0); expect(j).toBeGreaterThan(i); expect(k).toBeGreaterThan(j);
  });
});

describe('Jev decides the season over the arc', () => {
  it('asks one choice question, with every choice a criterion, and returns the answer', async () => {
    const calls: any[] = [];
    const impl = async (rq: any) => { calls.push(rq); return jevSays('winter')(rq); };
    const r = await JD.decideStorySeason({ arc: '1. On a snowy evening the family trims the tree.' }, { callImpl: impl });
    expect(r.season).toBe('winter');
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0].questions.SEASON.criteria)).toEqual(S.STORY_SEASON_CHOICES);
    expect(calls[0].state).toContain('snowy evening');
  });

  it('refuses an empty arc and an answer outside the choices', async () => {
    await expect(JD.decideStorySeason({ arc: '  ' }, { callImpl: jevSays('winter') })).rejects.toThrow(/no arc/);
    await expect(JD.decideStorySeason({ arc: 'x' }, { callImpl: jevSays('monsoon') })).rejects.toThrow(/outside/);
  });
});

describe('the beats pipeline step', () => {
  const arc = '1. The story.';
  it('applies a differing answer to inputData and records it in the Jev report', async () => {
    const inputData: any = { season: 'autumn', createdAt: NOV }; const report: any = { fallback: null };
    const r = await BP.decideAndApplyStorySeason({ inputData, approvedArc: arc, jevReport: report, gl: gl(), callImpl: jevSays('winter') });
    expect(r.overridden).toBe(true);
    expect(inputData).toMatchObject({ season: 'winter', requestedSeason: 'autumn' });
    expect(report.season).toMatchObject({ season: 'winter', overridden: true });
  });

  it('none leaves the requested season', async () => {
    const inputData: any = { season: 'autumn' };
    await BP.decideAndApplyStorySeason({ inputData, approvedArc: arc, jevReport: { fallback: null }, gl: gl(), callImpl: jevSays('none') });
    expect(inputData.season).toBe('autumn');
  });

  it('no arc, or the Jev backup path, is an error in the log and the requested season stands', async () => {
    const g = gl(); const inputData: any = { season: 'autumn' };
    expect(await BP.decideAndApplyStorySeason({ inputData, approvedArc: '', jevReport: { fallback: null }, gl: g })).toBeNull();
    expect(await BP.decideAndApplyStorySeason({ inputData, approvedArc: arc, jevReport: { fallback: { step: 'light' } }, gl: g })).toBeNull();
    expect(g.error).toHaveBeenCalledTimes(2);
    expect(inputData.season).toBe('autumn');
  });

  it('a Jev outage switches the story to the backup path and keeps the requested season', async () => {
    const report: any = { fallback: null }; const inputData: any = { season: 'autumn' };
    const was = JD.JEV_OUTAGE.waitMs;
    JD.JEV_OUTAGE.waitMs = 0;
    try {
      const down = async () => { throw new Error('HTTP 503'); };
      const r = await BP.decideAndApplyStorySeason({ inputData, approvedArc: arc, jevReport: report, gl: gl(), callImpl: down });
      expect(r).toBeNull();
      expect(report.fallback.step).toBe('season');
      expect(inputData.season).toBe('autumn');
    } finally { JD.JEV_OUTAGE.waitMs = was; }
  });
});

describe('the trial writer applies the planner season before the cover and the pages writer', () => {
  const FIX = path.join(__dirname, 'fixtures', 'trial-writer-two-calls');
  const rd = (f: string) => fs.readFileSync(path.join(FIX, f), 'utf8').replace(/\r\n/g, '\n').trim();
  const ARC = rd('arc.txt'), PAGES = rd('pages.txt');
  const withSeason = (v: string) => ARC.replace('---TITLE---', `---STORY SEASON---\nSEASON: ${v}\n\n---TITLE---`);
  const run = async (arcText: string, inputData: any) => {
    const seen: any = {};
    let n = 0;
    await runTrialWriter({
      inputData, sceneCount: 6, pagesModel: 'm',
      onArcText: () => { seen.atArc = inputData.season; },
      callText: async (prompt: string) => { n++; if (n === 2) seen.pagesPrompt = prompt; return { text: n === 1 ? arcText : PAGES, modelId: 'm', usage: {} }; },
    });
    return seen;
  };
  beforeAll(async () => { await loadPromptTemplates(); });

  it('a winter section turns the season before onArcText and before the pages prompt is built', async () => {
    const inputData = { ...JSON.parse(rd('input.json')), season: 'autumn' };
    const seen = await run(withSeason('winter'), inputData);
    expect(seen.atArc).toBe('winter');
    expect(seen.pagesPrompt).toMatch(/It is Winter/);
    expect(inputData.requestedSeason).toBe('autumn');
  });

  it('a missing section leaves the requested season (the error goes to the log)', async () => {
    const inputData = { ...JSON.parse(rd('input.json')), season: 'autumn' };
    const seen = await run(ARC, inputData);
    expect(seen.atArc).toBe('autumn');
    expect(inputData.seasonSource).toBeUndefined();
  });
});
