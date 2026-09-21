/**
 * A8 — the book audit's TEXT route gets ONE corrective text round.
 *
 * Pins BEHAVIOUR, never prompt wording:
 *   - no TEXT fault → no call at all (happy-path latency is sacred)
 *   - the faults reach the prompt as the refine template's AUDIT FINDINGS
 *   - the rewrite is SCOPED: a page no fault named keeps its shipped text,
 *     and the out-of-scope return is recorded rather than silently dropped
 *   - the pictures are final, so the round is told not to move a passage
 *     between pages
 *   - every fault gets exactly one ledger outcome, including a fault naming a
 *     page the book does not have
 *   - a failing model never throws and never changes the text
 *
 * The model is stubbed through Node's native CJS registry (textRefine requires
 * ./textModels lazily inside the call), so this test makes no paid call.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const textModels = nodeRequire('../../server/lib/textModels.js');
const { runPostAuditTextRound } = nodeRequire('../../server/lib/textRefine.js');

const realCall = textModels.callTextModelStreaming;
let sent: string[] = [];
let reply: string | (() => never) = '';

beforeEach(() => {
  sent = [];
  textModels.callTextModelStreaming = async (prompt: string) => {
    sent.push(prompt);
    if (typeof reply === 'function') reply();
    return { text: reply, usage: { input_tokens: 10, output_tokens: 10 }, modelId: 'stub-model' };
  };
});

const storyData: any = {
  language: 'de-ch',
  languageLevel: '1st-grade',
  mainCharacters: ['c1'],
  characters: [{ id: 'c1', name: 'Levin', age: 7, gender: 'male', personality: 'curious' }],
};
const pages = () => [
  { pageNumber: 1, text: 'Levin rennt zum Brunnen.', sceneIntent: 'a boy at a fountain', sceneBrief: 'A boy runs to a fountain.', planLine: '' },
  { pageNumber: 2, text: 'Der Ball ist weg.', sceneIntent: 'an empty square', sceneBrief: 'An empty square.', planLine: '' },
];
const fault = (n: number, what = 'the words have him sitting and the picture has him standing') =>
  ({ page: n, severity: 'MAJOR', line: `FAULT[TEXT][MAJOR]: p${n} — ${what}` });

describe('runPostAuditTextRound (A8)', () => {
  it('makes NO model call when the audit routed no TEXT fault', async () => {
    expect(await runPostAuditTextRound(storyData, pages(), [])).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('sends the audit fault lines and the no-move constraint, and applies the rewrite', async () => {
    reply = '---ANALYSIS---\nfixed p1\n\n---STORY TEXT---\n## Page 1\nLevin steht am Brunnen.';
    const res = await runPostAuditTextRound(storyData, pages(), [fault(1)]);
    expect(sent).toHaveLength(1);
    // The fault reaches the prompt verbatim, and the round is told the pictures
    // are final: no passage may move to another page.
    expect(sent[0]).toContain('FAULT[TEXT][MAJOR]: p1 —');
    expect(sent[0]).toMatch(/never move a passage from one page to another/i);
    expect(res!.entry.ok).toBe(true);
    expect(res!.entry.changedPages).toEqual([1]);
    expect(res!.pages[0].text).toBe('Levin steht am Brunnen.');
    expect(res!.pages[1].text).toBe('Der Ball ist weg.');
    // The round is readable afterwards: faults in, prompt, reply, per-page diff.
    expect(res!.entry.faults).toHaveLength(1);
    expect(res!.entry.prompt.length).toBeGreaterThan(0);
    expect(res!.entry.rawResponse).toContain('Levin steht am Brunnen.');
    expect(res!.entry.pages).toEqual([
      { pageNumber: 1, before: 'Levin rennt zum Brunnen.', after: 'Levin steht am Brunnen.' },
    ]);
  });

  it('drops a rewritten page no fault named, and records it', async () => {
    reply = '---ANALYSIS---\nx\n\n---STORY TEXT---\n## Page 1\nneu eins\n\n## Page 2\nneu zwei';
    const res = await runPostAuditTextRound(storyData, pages(), [fault(1)]);
    expect(res!.entry.changedPages).toEqual([1]);
    expect(res!.entry.outOfScopePages).toEqual([2]);
    expect(res!.pages[1].text).toBe('Der Ball ist weg.');
  });

  it('gives every fault exactly one outcome, including one naming a page the book lacks', async () => {
    reply = '---ANALYSIS---\nx\n\n---STORY TEXT---\n## Page 1\nneu eins';
    const res = await runPostAuditTextRound(storyData, pages(), [fault(1), fault(9)]);
    const outcomes = res!.entry.findingOutcomes.map((f: any) => [f.pageNumber, f.outcome]);
    expect(outcomes).toEqual([[1, 'page-rewritten'], [9, 'no-such-page']]);
    expect(res!.entry.unresolvedCount).toBe(1);
  });

  it('records a round that rewrote nothing rather than reporting success silently', async () => {
    reply = '---ANALYSIS---\nnothing to do\n\n---STORY TEXT---\nNONE';
    const res = await runPostAuditTextRound(storyData, pages(), [fault(1)]);
    expect(res!.entry.ok).toBe(true);
    expect(res!.entry.changedPages).toEqual([]);
    expect(res!.entry.findingOutcomes[0].outcome).toBe('page-unchanged');
  });

  it('never throws and never changes the text when the model fails', async () => {
    reply = () => { throw new Error('provider down'); };
    const res = await runPostAuditTextRound(storyData, pages(), [fault(2)]);
    reply = '';
    expect(res!.entry.ok).toBe(false);
    expect(res!.entry.error).toContain('provider down');
    expect(res!.pages.map((p: any) => p.text)).toEqual(['Levin rennt zum Brunnen.', 'Der Ball ist weg.']);
  });

  it('answers a page-less fault without a model call being wasted on an unscopable round', async () => {
    const res = await runPostAuditTextRound(storyData, pages(), [{ page: null, severity: null, line: 'FAULT[TEXT][MINOR]: the book never says why' }]);
    expect(sent).toHaveLength(0);
    expect(res!.entry.ok).toBe(false);
    expect(res!.entry.findingOutcomes[0].outcome).toBe('no-page-named');
  });
});

// Restore the real caller for any suite sharing this process.
process.on('exit', () => { textModels.callTextModelStreaming = realCall; });
