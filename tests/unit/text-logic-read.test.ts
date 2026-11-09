/**
 * The LOGIC READ of the finished text (docs/decisions.md 2026-11-08 "Logic read of the finished text").
 *
 * Pins BEHAVIOUR, never prompt wording beyond what the contract needs:
 *   - the parser types the JSON reply, drops (and records) every unusable entry, never silently
 *   - ONLY the typed severity decides what is fixed: MAJOR goes to the fix round, MINOR never does
 *   - the fix lines are scoped to every page a finding names
 *   - the prompt names the main character(s) and is text only; the verse question appears for verse books only
 *   - the step makes no fix call without a MAJOR, never throws, and a failed read leaves the text as it was
 * The model is stubbed through the CJS registry (textModels is required lazily), so no paid call is made.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const textModels = nodeRequire('../../server/lib/textModels.js');
const { loadPromptTemplates } = nodeRequire('../../server/services/prompts.js');
const {
  parseLogicRead, selectMajorFindings, toFaultLines, runLogicReadStep, LOGIC_QUESTIONS,
} = nodeRequire('../../server/lib/textLogicRead.js');
const { buildTextLogicReadPrompt, FRIEND_REASON_RULE, buildStoryTextFromBeatsPrompt } = nodeRequire('../../server/lib/promptBuilders.js');

beforeAll(async () => { await loadPromptTemplates(); });

const realCall = textModels.callTextModelStreaming;
afterAll(() => { textModels.callTextModelStreaming = realCall; });
let sent: string[] = [];
let replies: Array<string | (() => never)> = [];
beforeEach(() => {
  sent = [];
  replies = [];
  textModels.callTextModelStreaming = async (prompt: string) => {
    sent.push(prompt);
    const r = replies.shift() ?? '';
    if (typeof r === 'function') r();
    return { text: r, usage: { input_tokens: 100, output_tokens: 50 }, modelId: 'claude-sonnet-5-5' };
  };
});

const storyData: any = {
  language: 'de-ch',
  languageLevel: '1st-grade',
  mainCharacters: ['c1'],
  characters: [
    { id: 'c1', name: 'Levin', age: 7, gender: 'male' },
    { id: 'c2', name: 'Mia', age: 6, gender: 'female' },
  ],
};
const pages = () => [
  { pageNumber: 1, text: 'Levin rennt zum Brunnen.', sceneIntent: 'a boy at a fountain', sceneBrief: 'A boy runs.', planLine: '' },
  { pageNumber: 2, text: 'Mia öffnet das Tor.', sceneIntent: 'a gate', sceneBrief: 'A gate.', planLine: '' },
  { pageNumber: 3, text: 'Alle gehen heim.', sceneIntent: 'home', sceneBrief: 'Home.', planLine: '' },
];
const reply = (findings: any[]) => JSON.stringify({ resolution: { page: 2, actor: 'Mia', byMainCharacter: false }, findings });
const finding = (o: any = {}) => ({ pages: [2], question: 'OBSTACLE', severity: 'MAJOR', quote: 'Mia öffnet das Tor.', fix: 'Levin opens the gate.', ...o });

describe('parseLogicRead', () => {
  it('types a clean reply and keeps the resolution', () => {
    const r = parseLogicRead(reply([finding()]), pages());
    expect(r.ok).toBe(true);
    expect(r.findings).toEqual([{ pages: [2], question: 'OBSTACLE', severity: 'MAJOR', quote: 'Mia öffnet das Tor.', fix: 'Levin opens the gate.' }]);
    expect(r.resolution.actor).toBe('Mia');
  });

  it('reads a reply wrapped in a code fence', () => {
    const r = parseLogicRead('```json\n' + reply([finding()]) + '\n```', pages());
    expect(r.ok).toBe(true);
    expect(r.findings).toHaveLength(1);
  });

  it('a reply with no JSON is a failed read, not an empty book', () => {
    const r = parseLogicRead('The book is fine.', pages());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/findings/);
  });

  it('an empty findings list is a clean book', () => {
    const r = parseLogicRead(reply([]), pages());
    expect(r.ok).toBe(true);
    expect(r.findings).toEqual([]);
  });

  it('drops and records unknown question, unknown severity, missing page, missing fix and an absent quote', () => {
    const r = parseLogicRead(reply([
      finding({ question: 'Q1' }),
      finding({ severity: 'CRITICAL' }),
      finding({ pages: [9] }),
      finding({ fix: '  ' }),
      finding({ quote: 'words that are not on the page' }),
      finding({ question: 'stakes', severity: 'major', quote: '', pages: [1, 3] }),
    ]), pages());
    expect(r.dropped.map((d: any) => d.reason)).toEqual(['unknown-question', 'unknown-severity', 'no-such-page', 'no-fix', 'quote-absent']);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ question: 'STAKES', severity: 'MAJOR', pages: [1, 3], quote: '' });
  });

  it('accepts a quote re-wrapped across a line break', () => {
    const p = [{ pageNumber: 1, text: 'Levin rennt\nzum Brunnen.' }];
    const r = parseLogicRead(reply([finding({ pages: [1], quote: 'Levin rennt zum Brunnen.' })]), p);
    expect(r.findings).toHaveLength(1);
  });

  it('every question id is upper-case letters only (they double as FAULT-line categories)', () => {
    for (const q of LOGIC_QUESTIONS) expect(q).toMatch(/^[A-Z]+$/);
  });
});

describe('severity routing', () => {
  const all = [
    finding({ severity: 'MAJOR' }),
    finding({ severity: 'MINOR', question: 'NOPROGRESS', pages: [3], quote: '' }),
    finding({ severity: 'MAJOR', question: 'PLACE', pages: [1, 3], quote: '' }),
  ];
  const typed = () => parseLogicRead(reply(all), pages()).findings;

  it('selects MAJOR only, by the typed field', () => {
    expect(selectMajorFindings(typed()).map((f: any) => f.question)).toEqual(['OBSTACLE', 'PLACE']);
  });

  it('writes one scoped FAULT line per page a finding touches, from typed fields only', () => {
    const lines = toFaultLines(selectMajorFindings(typed())).map((l: any) => l.line);
    expect(lines).toEqual([
      'FAULT[OBSTACLE]: p2 — "Mia öffnet das Tor." — Levin opens the gate.',
      'FAULT[PLACE]: p1 — Levin opens the gate. (the fault runs over pages 1, 3)',
      'FAULT[PLACE]: p3 — Levin opens the gate. (the fault runs over pages 1, 3)',
    ]);
  });
});

describe('buildTextLogicReadPrompt', () => {
  it('names the main character, carries every page, and has no unfilled placeholder', () => {
    const p = buildTextLogicReadPrompt(storyData, pages());
    expect(p).toContain('The main character is: Levin.');
    expect(p).not.toContain('(together');
    expect(p).toContain('--- Page 2 ---\nMia öffnet das Tor.');
    expect(p).toContain(FRIEND_REASON_RULE);
    expect(p).not.toMatch(/\{[A-Z_]+\}/);
  });

  it('names every declared main when there are several', () => {
    const p = buildTextLogicReadPrompt({ ...storyData, mainCharacters: ['c1', 'c2'] }, pages());
    expect(p).toContain('Levin, Mia (together');
  });

  it('asks the verse question only for a verse book', () => {
    expect(buildTextLogicReadPrompt(storyData, pages())).not.toMatch(/^VERSE\./m);
    const verse = { ...storyData, storyCategory: 'educational', storyTopic: 'rhyming', textForm: 'verse' };
    const v = buildTextLogicReadPrompt(verse, pages());
    expect(v).toMatch(/^VERSE\./m);
  });
});

describe('generator and critic share the friend rule', () => {
  it('the beats writer is given the same sentence the reader judges against', () => {
    const w = buildStoryTextFromBeatsPrompt(storyData, [{ pageNumber: 1, planLine: 'p', instant: 'i' }], [{ pageNumber: 1, brief: 'b' }], 'ARC', {});
    expect(w).toContain(FRIEND_REASON_RULE);
  });
});

describe('runLogicReadStep', () => {
  it('makes no fix call when nothing is MAJOR, and leaves the text', async () => {
    replies = [reply([finding({ severity: 'MINOR' })])];
    const res = await runLogicReadStep(storyData, pages(), {});
    expect(sent).toHaveLength(1);
    expect(res.logicRead).toMatchObject({ ran: true, ok: true, majorCount: 0, fixedPages: [] });
    expect(res.logicRead.findings).toHaveLength(1);
    expect(res.rounds.map((r: any) => r.kind)).toEqual(['logic_read']);
    expect(res.pages.map((p: any) => p.text)).toEqual(pages().map(p => p.text));
  });

  it('sends only the MAJOR finding to ONE fix round, scoped to its page', async () => {
    replies = [
      reply([finding(), finding({ severity: 'MINOR', question: 'NOPROGRESS', pages: [3], quote: '' })]),
      '---ANALYSIS---\nfixed\n\n---STORY TEXT---\n## Page 2\nLevin öffnet das Tor.\n\n## Page 3\nsollte verworfen werden',
    ];
    const res = await runLogicReadStep(storyData, pages(), { firstRound: 5 });
    expect(sent).toHaveLength(2);
    expect(sent[0]).not.toMatch(/data:image|base64/);
    expect(sent[1]).toContain('FAULT[OBSTACLE]: p2 —');
    expect(sent[1]).not.toContain('NOPROGRESS');
    expect(res.pages[1].text).toBe('Levin öffnet das Tor.');
    expect(res.pages[2].text).toBe('Alle gehen heim.');
    expect(res.rounds.map((r: any) => [r.round, r.kind])).toEqual([[5, 'logic_read'], [6, 'logic_fix']]);
    expect(res.logicRead.fixedPages).toEqual([2]);
    expect(res.logicRead.majorCount).toBe(1);
    expect(res.logicRead.fix.findingOutcomes[0].outcome).toBe('page-rewritten');
  });

  it('records a failed read and keeps the text, without throwing', async () => {
    replies = [() => { throw new Error('provider down'); }];
    const res = await runLogicReadStep(storyData, pages(), {});
    expect(res.logicRead).toMatchObject({ ran: true, ok: false });
    expect(res.logicRead.error).toContain('provider down');
    expect(res.rounds[0]).toMatchObject({ kind: 'logic_read', ok: false });
    expect(res.pages.map((p: any) => p.text)).toEqual(pages().map(p => p.text));
  });

  it('a reply that is not JSON is a failed read, not a clean book', async () => {
    replies = ['no problems found'];
    const res = await runLogicReadStep(storyData, pages(), {});
    expect(res.logicRead.ok).toBe(false);
    expect(res.rounds).toHaveLength(1);
    expect(res.rounds[0].ok).toBe(false);
  });
});
