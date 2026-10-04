import { describe, it, expect } from 'vitest';

// Jev text audit (server/lib/jevAudit.js): question building from the
// versioned prompt file, the fail-loudly client, and flag aggregation into the
// FAULT-line shape textRefine.parseFaultLines already reads.
const J = require('../../server/lib/jevAudit');
const { parseFaultLines } = require('../../server/lib/textRefine');

const FILE = `#! maintainer line
[GRAMMAR]
GRAM_ANY: This {LANGUAGE} text has a mistake.
GRAM_CLEAN: Every sentence of this {LANGUAGE} text is correct.
[SLOP]
SLOP_A: stock phrase.
[LOGIC]
LOGIC_APPEAR: On page {PAGE}, someone appears.
[ARC]
ARC_PAGE_MATCH: The page tells «{PLAN}»
ARC_PAGE_CONTRADICT: The page contradicts «{PLAN}»
ARC_CAST_BEAT: {NAME} changes what happens.
[SHOT]
SHOT_TYPE: Which framing?
`;
const Q = J.parseQuestionFile(FILE);

function fakeFetch(reply: any, status = 200) {
  const calls: any[] = [];
  const fn = async (url: string, init: any) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    return { ok: status === 200, status, text: async () => (typeof reply === 'function' ? JSON.stringify(reply(JSON.parse(init.body))) : JSON.stringify(reply)) };
  };
  return { fn, calls };
}

describe('question file', () => {
  it('parses sections and skips maintainer lines', () => {
    expect(Object.keys(Q)).toEqual(['GRAMMAR', 'SLOP', 'LOGIC', 'ARC', 'SHOT']);
    expect(Q.GRAMMAR.map((q: any) => q.id)).toEqual(['GRAM_ANY', 'GRAM_CLEAN']);
  });

  it('the shipped file parses and every section the audit asks for exists', () => {
    const real = J.loadQuestions();
    for (const s of ['GRAMMAR', 'LOGIC', 'ARC', 'SHOT']) expect(real[s]?.length).toBeGreaterThan(0);
    // the slop questions live in proseSlop.js, one per type, so a flag names the problem
    expect(real.SLOP).toBeUndefined();
    const ids = Object.keys(J.buildSlopQuestions());
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThan(5);
  });

  it('fills the language name and refuses an unknown language', () => {
    const qs = J.buildGrammarQuestions('de-ch', { questions: Q });
    expect(qs.GRAM_ANY).toEqual({ type: 'noul', instructions: 'This German text has a mistake.' });
    expect(() => J.buildGrammarQuestions('xx', { questions: Q })).toThrow(/unsupported language/);
  });

  it('a placeholder without a value throws instead of sending braces', () => {
    expect(() => J.fill('On page {PAGE}', {})).toThrow(/\{PAGE\}/);
  });

  it('builds page, plan and per-cast questions', () => {
    expect(J.buildLogicQuestions(4, { questions: Q }).LOGIC_APPEAR.instructions).toBe('On page 4, someone appears.');
    const arc = J.buildArcPageQuestions('the egg is found', { questions: Q });
    expect(Object.keys(arc)).toEqual(['ARC_PAGE_MATCH', 'ARC_PAGE_CONTRADICT']);
    const cast = J.buildCastBeatQuestions(['A', 'B'], { questions: Q });
    expect(cast.ARC_CAST_BEAT__1.instructions).toBe('B changes what happens.');
    const shot = J.buildShotQuestion({ questions: Q });
    expect(shot.SHOT_TYPE.type).toBe('choice');
    expect(Object.keys(shot.SHOT_TYPE.criteria)).toEqual(['closeup', 'medium', 'wide']);
  });
});

describe('normalizeShot', () => {
  it('maps the brief vocabulary to three bins', () => {
    expect(J.normalizeShot('close-up')).toBe('closeup');
    expect(J.normalizeShot('over-the-shoulder')).toBe('closeup');
    expect(J.normalizeShot('ultra-wide')).toBe('wide');
    expect(J.normalizeShot('high-angle')).toBe('wide');
    expect(J.normalizeShot('medium')).toBe('medium');
    expect(J.normalizeShot('')).toBe(null);
  });
});

describe('callJev', () => {
  const questions = { A: { type: 'noul', instructions: 'x' } };
  it('posts model, state and questions and returns answers + cost', async () => {
    const { fn, calls } = fakeFetch({ model: 'typesafe/jev-1.13-x', answers: { A: { type: 'noul', noul: 0.7 } }, usage: { cost: 0.00002 } });
    const r = await J.callJev({ state: 'text', questions, apiKey: 'k', fetchImpl: fn });
    expect(calls[0].body).toEqual({ model: J.JEV_MODEL, state: 'text', questions });
    expect(calls[0].headers.Authorization).toBe('Bearer k');
    expect(r.answers.A.noul).toBe(0.7);
    expect(r.cost).toBe(0.00002);
  });
  it('throws on HTTP error', async () => {
    const { fn } = fakeFetch({ error: 'bad' }, 400);
    await expect(J.callJev({ state: 't', questions, apiKey: 'k', fetchImpl: fn })).rejects.toThrow(/HTTP 400/);
  });
  it('throws when an answer is missing', async () => {
    const { fn } = fakeFetch({ answers: {} });
    await expect(J.callJev({ state: 't', questions, apiKey: 'k', fetchImpl: fn })).rejects.toThrow(/lacks answers for A/);
  });
  it('throws on an oversize state and without a key', async () => {
    const { fn } = fakeFetch({ answers: { A: { noul: 1 } } });
    await expect(J.callJev({ state: 'x'.repeat(J.MAX_STATE_CHARS + 1), questions, apiKey: 'k', fetchImpl: fn })).rejects.toThrow(/over/);
    await expect(J.callJev({ state: 't', questions, apiKey: '', fetchImpl: fn })).rejects.toThrow(/OPENROUTER_API_KEY/);
  });
});

describe('mechanical Swiss checks', () => {
  it('flags ß and non-guillemet quotes only for Swiss languages', () => {
    const t = 'Er ging auf der Straße. „Hallo“, sagte er.';
    expect(J.mechanicalChecks(t, 'de-ch').map((f: any) => f.questionId)).toEqual(['MECH_ESZETT', 'MECH_QUOTES']);
    expect(J.mechanicalChecks(t, 'de-de')).toEqual([]);
    expect(J.mechanicalChecks('Er ging. «Hallo», sagte er.', 'de-ch')).toEqual([]);
    expect(J.mechanicalChecks('Il dit "bonjour".', 'fr-ch').map((f: any) => f.questionId)).toEqual(['MECH_QUOTES']);
  });
  it('counts "suddenly" per page: one is fine, two is a flag', () => {
    expect(J.mechanicalChecks('Plötzlich ging er.', 'de-ch')).toEqual([]);
    expect(J.mechanicalChecks('Plötzlich ging er. Und plötzlich stand er.', 'de-ch')).toEqual([{ questionId: 'MECH_SUDDENLY', evidence: '2×' }]);
    expect(J.mechanicalChecks('Suddenly. Suddenly!', 'en')).toEqual([{ questionId: 'MECH_SUDDENLY', evidence: '2×' }]);
  });
});

describe('adopted check table', () => {
  it('asks no question the evaluation rejected', () => {
    for (const id of ['GRAM_ANY', 'LOGIC_APPEAR', 'LOGIC_OBJECT', 'ARC_PAGE_MATCH', 'SHOT_TYPE']) {
      expect(J.JEV_CHECKS[id].enabled).toBe(false);
    }
    // not even asked: gone from the slop set
    const slopIds = Object.keys(J.buildSlopQuestions());
    expect(slopIds).not.toContain('SLOP_SUDDENLY');
    expect(slopIds).not.toContain('SLOP_EMOTION_LABEL');
  });
  it('every check names a question that exists and every enabled one has a threshold', () => {
    const ids = new Set([...Object.values(J.loadQuestions()).flat().map((q: any) => q.id), ...Object.keys(J.buildSlopQuestions())]);
    for (const [id, c] of Object.entries(J.JEV_CHECKS) as any) {
      expect(ids.has(id)).toBe(true);
      if (c.enabled) { expect(typeof c.threshold).toBe('number'); expect(['above', 'below']).toContain(c.flagWhen); }
    }
  });
  it('every slop type is enabled', () => {
    for (const id of Object.keys(J.buildSlopQuestions())) expect(J.JEV_CHECKS[id]?.enabled).toBe(true);
  });
});

describe('aggregation', () => {
  const checks = {
    GRAM_ANY: { enabled: true, threshold: 0.9, flagWhen: 'above' },
    ARC_PAGE_MATCH: { enabled: true, threshold: 0.3, flagWhen: 'below' },
    SLOP_A: { enabled: false, threshold: 0.1, flagWhen: 'above' },
  };
  const rows = [
    { pageNumber: 2, paragraphIndex: 1, check: 'grammar', scores: { GRAM_ANY: 0.95 }, texts: { GRAM_ANY: 'has a mistake' } },
    { pageNumber: 1, paragraphIndex: 0, check: 'grammar', scores: { GRAM_ANY: 0.5 } },
    { pageNumber: 1, paragraphIndex: null, check: 'arc', scores: { ARC_PAGE_MATCH: 0.1 } },
    { pageNumber: 3, paragraphIndex: null, check: 'slop', scores: { SLOP_A: 0.99 } },
  ];
  it('fires above/below per check and ignores disabled checks', () => {
    const flags = J.aggregateFlags(rows, checks);
    expect(flags.map((f: any) => `${f.pageNumber}:${f.questionId}`)).toEqual(['1:ARC_PAGE_MATCH', '2:GRAM_ANY']);
  });
  it('groups flags per page and renders FAULT lines textRefine can parse', () => {
    const flags = J.aggregateFlags(rows, checks);
    expect(J.pagesToRewrite(flags)).toEqual([{ pageNumber: 1, questionIds: ['ARC_PAGE_MATCH'] }, { pageNumber: 2, questionIds: ['GRAM_ANY'] }]);
    const lines = J.toFaultLines(flags);
    const parsed = parseFaultLines(lines.join('\n'), 'jev');
    expect(parsed.map((f: any) => [f.category, f.pageNumber])).toEqual([['ARC', 1], ['GRAMMAR', 2]]);
    expect(parsed[1].text).toBe('[GRAM_ANY] paragraph 2: has a mistake');
  });
  it('cast-beat subjects carry the name into the flag', () => {
    const f = J.aggregateFlags([{ pageNumber: null, check: 'arc_cast', scores: { ARC_CAST_BEAT__0: 0.1 }, subjects: { ARC_CAST_BEAT__0: 'Mia' } }], { ARC_CAST_BEAT: { enabled: true, threshold: 0.5, flagWhen: 'below' } });
    expect(f[0].subject).toBe('Mia');
  });
  it('an arc-level flag renders without a page and parses as no-page', () => {
    const f = J.aggregateFlags([{ pageNumber: null, check: 'arc_cast', scores: { ARC_CAST_BEAT__0: 0.1 }, texts: { ARC_CAST_BEAT__0: 'In this story arc, Mia does something.' }, subjects: { ARC_CAST_BEAT__0: 'Mia' } }], { ARC_CAST_BEAT: { enabled: true, threshold: 0.5, flagWhen: 'below' } });
    const [line] = J.toFaultLines(f);
    expect(line).toBe('FAULT[ARCCAST]: [ARC_CAST_BEAT] In this story arc, Mia does something.');
    expect(parseFaultLines(line, 'jev')[0]).toMatchObject({ category: 'ARCCAST', pageNumber: null });
  });
});

describe('auditStoryText', () => {
  it('asks only enabled questions, per paragraph when configured, and sums cost', async () => {
    const seen: any[] = [];
    const callImpl = async ({ state, questions }: any) => {
      seen.push({ state, ids: Object.keys(questions) });
      const answers: any = {};
      for (const id of Object.keys(questions)) answers[id] = { type: 'noul', noul: state.includes('bad') ? 0.99 : 0.1 };
      return { answers, cost: 0.001 };
    };
    const checks = { GRAM_ANY: { enabled: true, threshold: 0.9, flagWhen: 'above', unit: 'paragraph' } };
    const r = await J.auditStoryText(
      { pages: [{ pageNumber: 1, text: 'good one.\n\nbad two.' }, { pageNumber: 2, text: 'fine.' }], language: 'de-ch' },
      { checks, callImpl, questions: Q },
    );
    expect(seen.map(s => s.ids)).toEqual([['GRAM_ANY'], ['GRAM_ANY'], ['GRAM_ANY']]);
    expect(r.flags).toEqual([{ pageNumber: 1, paragraphIndex: 1, check: 'grammar', questionId: 'GRAM_ANY', subject: null, text: 'This German text has a mistake.', p: 0.99 }]);
    expect(r.faultLines).toEqual(['FAULT[GRAMMAR]: p1 — [GRAM_ANY] paragraph 2: This German text has a mistake.']);
    expect(r.pages).toEqual([{ pageNumber: 1, questionIds: ['GRAM_ANY'] }]);
    expect(r.calls).toBe(3);
    expect(r.cost).toBeCloseTo(0.003);
  });
  it('counts shots from the brief field without a call', async () => {
    const callImpl = async () => { throw new Error('no call expected'); };
    const r = await J.auditStoryText(
      { pages: [{ pageNumber: 1, text: 'x' }], language: 'en', briefs: [{ pageNumber: 1, camera: 'close-up' }, { pageNumber: 2, camera: 'wide' }] },
      { checks: {}, callImpl, questions: Q },
    );
    expect(r.shots).toEqual({ closeup: 1, medium: 0, wide: 1 });
  });
  it('refuses an empty story', async () => {
    await expect(J.auditStoryText({ pages: [], language: 'de' }, { checks: {}, questions: Q })).rejects.toThrow(/no pages/);
  });
});

describe('marked story state', () => {
  const pages = [{ pageNumber: 1, text: 'a' }, { pageNumber: 2, text: 'b' }, { pageNumber: 3, text: 'c' }];
  it('marks the judged page and can cut later pages', () => {
    expect(J.buildMarkedStoryState(pages, 2)).toBe('--- Page 1 ---\na\n\n--- Page 2 (PAGE TO JUDGE) ---\nb\n\n--- Page 3 ---\nc');
    expect(J.buildMarkedStoryState(pages, 2, { includeLater: false })).not.toContain('Page 3');
  });
});
