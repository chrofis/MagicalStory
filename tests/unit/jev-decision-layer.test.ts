/**
 * THE JEV DECISION LAYER (owner, 2026-09-27): Jev decides, code verifies and
 * writes. Pins behaviour — the budget held by construction, the field code
 * writes, the failure policy — never question wording (that is the evaluated
 * wording in server/lib/jevDecisions.js, measured by the eval scripts).
 * see docs/decisions.md 2026-09-27 "Jev decision layer wired"
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);
const JD = req('../../server/lib/jevDecisions');
const SV = req('../../server/lib/shotVocabulary');
const PB = req('../../server/lib/promptBuilders');
const { runPlanCounters } = req('../../server/lib/planCounters');
const { loadPromptTemplates } = req('../../server/services/prompts');

const P = SV.PLAN_SHOT_PLACEHOLDER;

/** A stub Jev: every noul answers from `score(questionText, state)`, every choice picks `pick(...)`. */
function stubJev({ noul = (_q: string, _s: string) => 0.5, choice = (q: any) => Object.keys(q.criteria)[0] } = {}) {
  const calls: any[] = [];
  const impl = async ({ state, questions }: any) => {
    calls.push({ state, questions });
    const answers: any = {};
    for (const [id, q] of Object.entries<any>(questions)) {
      if (q.type === 'noul') answers[id] = { noul: noul(q.instructions, state) };
      else {
        const c = choice(q, state);
        answers[id] = { choice: c, probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, k === c ? 0.9 : 0.1 / (Object.keys(q.criteria).length - 1)])) };
      }
    }
    return { answers, cost: 0.0001, model: 'stub', usage: { prompt_tokens: 10, completion_tokens: 1 } };
  };
  return { impl, calls };
}

const book = (n: number, heads: (p: number) => number) => {
  const pages = Array.from({ length: n }, (_, i) => ({ pageNumber: i + 1, planLine: `${P} — Ana and Ben — they do thing ${i + 1} — something changes` }));
  const present = new Map(pages.map(p => [p.pageNumber, Array.from({ length: heads(p.pageNumber) }, (_, k) => `C${k}`)]));
  return { pages, present };
};

describe('the plan line: field 0 is the placeholder until code writes the shot', () => {
  it('strips the placeholder or a shot word, never the who column', () => {
    expect(JD.stripPlanShot(`${P} — Ana — she runs — she is out`)).toBe('Ana — she runs — she is out');
    expect(JD.stripPlanShot('close-up — Ana — she runs — she is out')).toBe('Ana — she runs — she is out');
    expect(JD.stripPlanShot('Ana — she runs — she is out')).toBe('Ana — she runs — she is out');
  });
  it('writes the shot into field 0', () => {
    expect(JD.withShot(`${P} — Ana — she runs — she is out`, 'wide')).toBe('wide — Ana — she runs — she is out');
  });
  it('writes a who column as English names', () => {
    expect(JD.withWho(`${P} — Ana, Ben, Cy and Dora — they run — out`, ['Ana', 'Ben'])).toBe(`${P} — Ana and Ben — they run — out`);
    expect(JD.whoText(['A', 'B', 'C'])).toBe('A, B and C');
  });
});

describe('decideShots: Jev scores, code assigns under the budget', () => {
  it('holds every floor, the cap and the group rule even when Jev wants medium everywhere', async () => {
    const { pages, present } = book(18, p => (p % 5 === 0 ? 4 : 2));
    const { impl, calls } = stubJev({ noul: (q) => (/ medium shot/.test(q) ? 0.9 : 0.2) });
    const d = await JD.decideShots({ arc: '1. A thing.', pages, present }, { callImpl: impl });
    expect(calls).toHaveLength(18);                                  // one call per page (owner: 1 call)
    expect(d.violations).toEqual([]);
    expect(d.unmet).toBeNull();
    const count = (s: string) => d.shots.filter((x: string) => x === s).length;
    const f = SV.shotFloors(18);
    for (const [s, n] of Object.entries<number>(f.floors)) expect(count(s)).toBeGreaterThanOrEqual(n);
    expect(count('medium') + count('wide')).toBeLessThanOrEqual(f.maxMediumWide);
    pages.forEach((p, i) => { if (present.get(p.pageNumber)!.length > SV.GROUP_STAGING_MAX) expect(SV.GROUP_WIDER_SHOTS).toContain(d.shots[i]); });
  });

  it('the questions never see a shot, and carry the page marked', async () => {
    const { pages, present } = book(6, () => 1);
    const { impl, calls } = stubJev();
    await JD.decideShots({ arc: 'ARC', pages, present }, { callImpl: impl });
    for (const c of calls) {
      expect(c.state).not.toContain(`${P} —`);
      expect(c.state).toMatch(/PAGE TO JUDGE: Page \d+ — Ana and Ben/);
      expect(Object.keys(c.questions)).toHaveLength(SV.SHOT_TYPES.length);
    }
  });

  it('no head count for a page is an error, never a guess', async () => {
    const { pages } = book(4, () => 1);
    await expect(JD.decideShots({ arc: '', pages, present: new Map([[1, ['A']]]) }, { callImpl: stubJev().impl }))
      .rejects.toThrow(JD.JevDecisionError);
  });

  it('applyShots writes field 0 of every line and nothing else', () => {
    const { pages } = book(3, () => 1);
    const out = JD.applyShots(pages, ['wide', 'close-up', 'medium']);
    expect(out.map((p: any) => p.planLine.split(' — ')[0])).toEqual(['wide', 'close-up', 'medium']);
    expect(out[0].planLine.split(' — ').slice(1)).toEqual(pages[0].planLine.split(' — ').slice(1));
  });
});

describe('Jev outage policy: wait, then the caller switches to the backup', () => {
  const saved = { ...JD.JEV_OUTAGE };
  beforeAll(() => { JD.JEV_OUTAGE.waitMs = 50; JD.JEV_OUTAGE.maxBackoffMs = 5; });
  afterAll(() => { Object.assign(JD.JEV_OUTAGE, saved); });
  it('retries a transient HTTP error, then answers', async () => {
    let n = 0;
    const impl = async ({ questions }: any) => {
      if (n++ === 0) throw new Error('jevAudit: HTTP 503: upstream down');
      return { answers: Object.fromEntries(Object.keys(questions).map(k => [k, { noul: 0.5 }])), cost: 0, model: 'stub', usage: {} };
    };
    const stats: any = { calls: 0, cost: 0, ms: [], retries: 0, failed: 0, errors: [] };
    const out = await JD.runJevRequests([{ key: 'k', state: 's', questions: { Q: { type: 'noul', instructions: 'q' } } }], { callImpl: impl, retryDelayMs: 1, stats });
    expect(out.get('k')).toHaveLength(1);
    expect(stats.retries).toBe(1);
  });
  it('a missing API key is configuration, not an outage: it fails at once, as a JevDecisionError', async () => {
    const impl = async () => { throw new Error('jevAudit: OPENROUTER_API_KEY is not set'); };
    await expect(JD.runJevRequests([{ key: 'k', state: 's', questions: { Q: { type: 'noul', instructions: 'q' } } }], { callImpl: impl, retryDelayMs: 1 }))
      .rejects.toThrow(JD.JevDecisionError);
  });
  it('an error that persists is retried until the outage wait is spent, then fails', async () => {
    let n = 0;
    const impl = async () => { n++; throw new Error('jevAudit: HTTP 503: down'); };
    await expect(JD.runJevRequests([{ key: 'k', state: 's', questions: { Q: { type: 'noul', instructions: 'q' } } }], { callImpl: impl, retryDelayMs: 1 }))
      .rejects.toThrow(JD.JevDecisionError);
    expect(n).toBeGreaterThan(2);
  });
  it('the probe answers ok, or reports the error — it never throws', async () => {
    expect((await JD.probeJev({ callImpl: async ({ questions }: any) => ({ answers: Object.fromEntries(Object.keys(questions).map(k => [k, { noul: 0.9 }])), cost: 0, usage: {} }) })).ok).toBe(true);
    const down = await JD.probeJev({ callImpl: async () => { throw new Error('HTTP 502'); } });
    expect(down.ok).toBe(false);
    expect(down.error).toMatch(/502/);
  });
});

describe('the planner no longer authors a shot', () => {
  beforeAll(async () => { await loadPromptTemplates(); });
  it('the built planner writes the placeholder and carries no distribution', () => {
    const p = String(PB.buildBeatsPrompt({ characters: [{ name: 'Ana' }, { name: 'Ben' }], language: 'en', pages: 18 }, 18, { finalArc: '1. A thing.' }));
    expect(p).toContain(`Page <N>: ${P} — <who is in frame>`);
    expect(p).not.toMatch(/medium or wide|close-up page|over-the-shoulder/i);
    expect(p).not.toMatch(/\{[A-Z_]{3,}\}/);
  });
  it('the counters raise no shot finding on a placeholder plan', () => {
    const pages = [1, 2, 3, 4].map(n => ({ pageNumber: n, planLine: `${P} — Ana — she acts ${n} — a change ${n}` }));
    const roster = new Map(pages.map(p => [p.pageNumber, { people: ['Ana'], things: [], covers: [] }]));
    const r = runPlanCounters({ pages, commissionedNames: ['Ana'], roster });
    expect(r.findings.map((f: any) => f.code).filter((c: string) => /SHOT|CONSECUTIVE/.test(c))).toEqual([]);
  });
});
