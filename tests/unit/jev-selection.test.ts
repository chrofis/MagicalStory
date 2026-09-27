/**
 * JEV PICKS THE CHALLENGES AND LANDMARKS THAT FIT (owner, 2026-09-27).
 * Pins the selection BEHAVIOUR with Jev stubbed: what is ranked, what is drawn
 * from where, what a Jev outage leaves, and that an idea request never waits.
 * see docs/decisions.md 2026-09-27 "Jev selection built"
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const S = require('../../server/lib/jevSelection.js');
const JD = require('../../server/lib/jevDecisions.js');
const PB = require('../../server/lib/promptBuilders.js');

const realWait = JD.JEV_OUTAGE.waitMs;
afterEach(() => { JD.JEV_OUTAGE.waitMs = realWait; S._ideaRankings.clear(); });

/** A Jev stub answering every noul with score(questionText, id). */
const jev = (score: (text: string, id: string) => number, calls: any[] = []) => async (req: any) => {
  calls.push(req);
  return { answers: Object.fromEntries(Object.entries<any>(req.questions).map(([k, q]) => [k, { noul: score(q.instructions, k) }])), cost: 0.0001, model: 'stub', usage: {} };
};
const down = async () => { throw new Error('jevAudit: HTTP 503: upstream down'); };
const gl = () => { const ev: any[] = []; return { ev, info: (k: string, m: string, _x: any, d: any) => ev.push({ level: 'info', k, d }), warn: () => {}, error: (k: string, m: string, _x: any, d: any) => ev.push({ level: 'error', k, d }), debug: () => {} }; };

const story = {
  characters: [{ name: 'Mila', age: 7, gender: 'female' }, { name: 'Ben', age: 9, gender: 'male' }],
  storyCategory: 'adventure', storyTheme: 'pirate', userLocation: { city: 'Zürich' },
  storyDetails: 'Mila and Ben find a map in the old harbour.', pages: 12,
};

describe('drawFromTop', () => {
  it('draws k distinct items from the top window, in rank order, whatever rng returns', () => {
    const ranked = Array.from({ length: 30 }, (_, i) => i);
    for (const rng of [() => 0, () => 0.999999, Math.random]) {
      const d = S.drawFromTop(ranked, 12, 20, rng);
      expect(d).toHaveLength(12);
      expect(new Set(d).size).toBe(12);
      expect(d.every((x: number) => x < 20)).toBe(true);
      expect([...d].sort((a: number, b: number) => a - b)).toEqual(d);
    }
    expect(S.drawFromTop([1, 2], 3, 5)).toEqual([1, 2]);
  });
});

describe('the question wording is one copy', () => {
  it('the eval script reads production\'s questions and states', () => {
    const E = require('../../scripts/analysis/eval-jev-selection.js');
    expect(E.setupState).toBe(S.setupState);
    expect(E.premiseState).toBe(S.premiseState);
  });
  it('the story state carries cast, kind, town and the commissioned idea', () => {
    const st = S.premiseState(S.selectionSetup(story));
    expect(st).toContain('Cast: children aged 7, 9.');
    expect(st).toContain('Kind of story: adventure, theme "pirate".');
    expect(st).toContain('Home town: Zürich.');
    expect(st).toContain('# THE COMMISSIONED IDEA\nMila and Ben find a map in the old harbour.');
  });
});

describe('challenges: 12 at random from Jev\'s top 20', () => {
  it('ranks every eligible entry in ONE call and offers 12 of the 20 best-fitting', async () => {
    const calls: any[] = [];
    // Higher catalogue id = better fit, so the top 20 are the 20 highest ids.
    const r = await S.selectChallengeDraw({ inputData: story, jevReport: { fallback: null }, callImpl: jev((_t, id) => Number(id.slice(1)) / 1000, calls) });
    expect(calls).toHaveLength(1);
    const pool = PB.challengePool(story, { need: S.JEV_CHALLENGE_TOP }).entries.map((e: any) => e.id);
    expect(Object.keys(calls[0].questions)).toHaveLength(pool.length);
    expect(calls[0].state).toContain('# THE COMMISSIONED IDEA');
    const top20 = [...pool].sort((a, b) => b - a).slice(0, 20);
    expect(r.ids).toHaveLength(12);
    expect(r.ids.every((id: number) => top20.includes(id))).toBe(true);
    expect(r.selection.method).toBe('jev');
    expect(r.selection.top).toEqual(top20);
    expect(Object.keys(r.selection.scores)).toHaveLength(pool.length);
    expect(r.section.split('\n').filter((l: string) => l.startsWith('- [C'))).toHaveLength(12);
  });

  it('keeps the exclusion memory: an offered id is never ranked', async () => {
    const calls: any[] = [];
    const excluded = PB.challengePool(story, { need: 20 }).entries.slice(0, 5).map((e: any) => e.id);
    const r = await S.selectChallengeDraw({ inputData: story, excludeIds: [excluded], jevReport: { fallback: null }, callImpl: jev(() => 0.5, calls) });
    for (const id of excluded) expect(Object.keys(calls[0].questions)).not.toContain(`c${id}`);
    expect(r.ids.some((id: number) => excluded.includes(id))).toBe(false);
  });

  it('Jev down after the wait: the story switches to the backup at step "challenges" and gets today\'s random 25', async () => {
    JD.JEV_OUTAGE.waitMs = 20;
    const report: any = { fallback: null };
    const g = gl();
    const r = await S.selectChallengeDraw({ inputData: story, jevReport: report, gl: g, callImpl: down });
    expect(report.fallback.step).toBe('challenges');
    expect(g.ev.filter(e => e.k === 'jev_fallback')).toHaveLength(1);
    expect(r.ids).toHaveLength(25);
    expect(r.selection.method).toBe('random');
  });

  it('a story already on the backup makes no Jev call', async () => {
    const calls: any[] = [];
    const r = await S.selectChallengeDraw({ inputData: story, jevReport: { fallback: { step: 'start' } }, callImpl: jev(() => 1, calls) });
    expect(calls).toHaveLength(0);
    expect(r.ids).toHaveLength(25);
  });
});

const place = (name: string, extra: any = {}) => ({ name, type: 'castle', wikipediaExtract: `${name} is a place.`, landmarkIndexId: name.charCodeAt(0), ...extra });
const town = () => ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map(n => place(n));
// Score by letter: H best, A worst.
const byLetter = (text: string) => { const m = text.match(/The place: (\w)/); return m ? ('ABCDEFGH'.indexOf(m[1]) + 1) / 10 : 0.9; };

describe('landmarks in the story', () => {
  it('full story: the list in Jev order, a premise-named place pinned first', async () => {
    const input: any = { ...story, availableLandmarks: [place('B', { premisePinned: true }), ...town().filter(l => l.name !== 'B')] };
    const rec = await S.selectStoryLandmarks(input, { jevReport: { fallback: null }, mode: 'full', callImpl: jev(byLetter) });
    expect(input.availableLandmarks.map((l: any) => l.name)).toEqual(['B', 'H', 'G', 'F', 'E', 'D', 'C', 'A']);
    expect(rec.method).toBe('jev');
    expect(rec.scores).toHaveLength(8);
  });

  it('trial story: the first 3 are the pin, then a draw from Jev\'s top 5; probed first', async () => {
    const calls: any[] = [];
    const input: any = { ...story, trialMode: true, availableLandmarks: [place('A', { premisePinned: true }), ...town().filter(l => l.name !== 'A')] };
    const report: any = { fallback: null, probe: null };
    const rec = await S.selectStoryLandmarks(input, { jevReport: report, mode: 'trial', probe: true, callImpl: jev(byLetter, calls) });
    expect(calls[0].questions.PROBE).toBeTruthy();
    expect(report.probe.ok).toBe(true);
    expect(rec.picked[0]).toBe('A');
    expect(rec.picked).toHaveLength(3);
    for (const n of rec.picked.slice(1)) expect(['H', 'G', 'F', 'E', 'D']).toContain(n);
    // The trial writer reads exactly those three.
    expect(input.availableLandmarks.slice(0, 3).map((l: any) => l.name)).toEqual(rec.picked);
  });

  it('once per job: a second call (the landmark-minimum retry) makes no Jev call and keeps the order', async () => {
    const calls: any[] = [];
    const input: any = { ...story, availableLandmarks: town() };
    await S.selectStoryLandmarks(input, { jevReport: { fallback: null }, callImpl: jev(byLetter, calls) });
    const order = input.availableLandmarks.map((l: any) => l.name);
    await S.selectStoryLandmarks(input, { jevReport: { fallback: null }, callImpl: jev(() => 0.5, calls) });
    expect(calls).toHaveLength(1);
    expect(input.availableLandmarks.map((l: any) => l.name)).toEqual(order);
  });

  it('trial probe fails: today\'s order stands and the switch is thrown at "start"', async () => {
    const input: any = { ...story, availableLandmarks: town() };
    const report: any = { fallback: null, probe: null };
    const rec = await S.selectStoryLandmarks(input, { jevReport: report, mode: 'trial', probe: true, callImpl: down });
    expect(report.fallback.step).toBe('start');
    expect(rec.method).toBe('today');
    expect(input.availableLandmarks.map((l: any) => l.name)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
  });

  it('trial: probe ok, then the landmark call fails — one attempt, backup at "landmarks", never the 5-minute wait', async () => {
    // JEV_OUTAGE.waitMs stays at its real 5 minutes here: without the trial cap this test would time out.
    const calls: any[] = [];
    const probeOkThenDown = async (req: any) => {
      calls.push(req);
      if (req.questions.PROBE) return { answers: { PROBE: { noul: 1 } }, cost: 0, model: 'stub', usage: {} };
      throw new Error('jevAudit: HTTP 503: upstream down');
    };
    const input: any = { ...story, trialMode: true, availableLandmarks: town() };
    const report: any = { fallback: null, probe: null };
    const rec = await S.selectStoryLandmarks(input, { jevReport: report, mode: 'trial', probe: true, callImpl: probeOkThenDown });
    expect(report.probe.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(report.fallback.step).toBe('landmarks');
    expect(rec.method).toBe('today');
    expect(input.availableLandmarks.map((l: any) => l.name)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
  });

  it('the trial cap never waits and times a call out at the probe\'s limit', () => {
    expect(JD.TRIAL_JEV_OUTAGE).toEqual({ waitMs: 0, callTimeoutMs: JD.JEV_OUTAGE.probeTimeoutMs });
  });

  it('a make-believe trial idea asks Jev nothing', async () => {
    const calls: any[] = [];
    const input: any = { ...story, ideaKind: 'fantasy', availableLandmarks: town() };
    const rec = await S.selectStoryLandmarks(input, { jevReport: { fallback: null }, mode: 'trial', probe: true, callImpl: jev(() => 1, calls) });
    expect(calls).toHaveLength(0);
    expect(rec.method).toBe('none');
  });

  it('buildTrialStoryPrompt names the three the selection put first', () => {
    const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../server/lib/promptBuilders.js'), 'utf8');
    expect(src).toContain("inputData.availableLandmarks.slice(0, require('./jevSelection').TRIAL_STORY_LANDMARKS)");
    expect(S.TRIAL_STORY_LANDMARKS).toBe(3);
  });
});

describe('landmarks for the idea cards: prepared off the request, never awaited', () => {
  const setup = S.selectionSetup({ ...story, storyDetails: '' });

  it('not ready → today\'s order for THIS request, and the ranking starts for the next', async () => {
    const calls: any[] = [];
    const landmarks = town();
    const first = S.pickIdeaLandmarks({ setup, language: 'de', landmarks, n: 2, callImpl: jev(byLetter, calls) });
    expect(first.source).toBe('absent');
    expect(first.landmarks.map((l: any) => l.name)).toEqual(['A', 'B']);
    expect(calls).toHaveLength(1);
    expect(calls[0].state).toContain('BEFORE ITS STORY IS WRITTEN');   // LB1: no premise
    await S._ideaRankings.get(first.key).promise;
    const second = S.pickIdeaLandmarks({ setup, language: 'de', landmarks, n: 2, callImpl: jev(byLetter, calls) });
    expect(second.source).toBe('jev');
    expect(second.landmarks).toHaveLength(2);
    for (const l of second.landmarks) expect(['H', 'G', 'F', 'E', 'D']).toContain(l.name);
    expect(calls).toHaveLength(1);
  });

  it('a prepare call makes the ranking ready before the idea request; pending means today\'s order', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>(r => { release = r; });
    const slow = async (req: any) => { await gate; return jev(byLetter)(req); };
    const landmarks = town();
    const { key, entry } = S.startIdeaLandmarkRanking({ setup, language: 'de', landmarks, callImpl: slow });
    expect(S.pickIdeaLandmarks({ setup, language: 'de', landmarks, n: 3 }).source).toBe('pending');
    release();
    await entry.promise;
    const ready = S.pickIdeaLandmarks({ setup, language: 'de', landmarks, n: 3 });
    expect(ready.key).toBe(key);
    expect(ready.source).toBe('jev');
    expect(ready.landmarks).toHaveLength(3);
  });

  it('the cache key is town + language + story kind + age bands', () => {
    const k = (over: any) => S.ideaRankKey(S.selectionSetup({ ...story, ...over }), 'de');
    expect(k({ characters: [{ age: 7 }, { age: 8 }] })).toBe(k({ characters: [{ age: 6 }] }));
    expect(k({ characters: [{ age: 7 }] })).not.toBe(k({ characters: [{ age: 4 }] }));
    expect(k({})).not.toBe(k({ storyTheme: 'dragon' }));
    expect(k({})).not.toBe(k({ userLocation: { city: 'Basel' } }));
  });

  it('a list the ranking never scored is not ranked from a stale entry', async () => {
    const landmarks = town();
    const { entry } = S.startIdeaLandmarkRanking({ setup, language: 'de', landmarks, callImpl: jev(byLetter) });
    await entry.promise;
    const r = S.pickIdeaLandmarks({ setup, language: 'de', landmarks: [...landmarks, place('Z')], n: 2, callImpl: jev(byLetter) });
    expect(r.source).toBe('absent');
  });

  it('a failed ranking is logged and forgotten, so the next prepare starts again', async () => {
    JD.JEV_OUTAGE.waitMs = 10;
    const { key, entry } = S.startIdeaLandmarkRanking({ setup, language: 'de', landmarks: town(), callImpl: down });
    await entry.promise;
    expect(S._ideaRankings.has(key)).toBe(false);
  });

  it('the trial idea sentence is one shared constant', () => {
    expect(PB.trialIdeaLandmarksText(['X', 'Y'])).toBe('At least one scene must take place at one of these real local landmarks: X, Y.');
    expect(PB.trialIdeaLandmarksText([])).toBe('');
  });
});
