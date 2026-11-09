/**
 * The RETEST after a major change (owner 2026-11-09, docs/decisions.md): when runPostAuditTextRound rewrites a
 * page past MODEL_DEFAULTS.textRefineMajorChangeRatio, the whole book is read ONCE for story logic on the new
 * text (textLogicRead.runLogicReadStep). The logic read's own fix round calls runPostAuditTextRound with
 * noRetest, so there is never a second retest. Regression data: the stored rhyming book
 * job_1793964466256_1tmyzh1do, p2 and p9 (64% and 65% rewrites that the old 30% cap threw back).
 * The model is stubbed; no paid call.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const textModels = nodeRequire('../../server/lib/textModels.js');
const { runPostAuditTextRound } = nodeRequire('../../server/lib/textRefine.js');
const fx = nodeRequire('./fixtures/verse-edit-cap-p2-p9.json');

const realCall = textModels.callTextModelStreaming;
const STORY: any = { language: 'de-ch', languageLevel: 'standard', storyCategory: fx.storyCategory, storyTopic: fx.storyTopic, textForm: 'verse', characters: [], mainCharacters: [] };
const pagesOf = () => Object.entries(fx.pages).map(([n, p]: any) => ({ pageNumber: Number(n), text: p.before, sceneIntent: 'x', sceneBrief: 'x', planLine: '' }));
const rewrite = (map: Record<string, string>) => '---ANALYSIS---\nfixed\n---STORY TEXT---\n' + Object.entries(map).map(([n, t]) => `## Page ${n}\n${t}`).join('\n\n');
const fault = (n: number) => ({ page: n, severity: 'MINOR', line: `FAULT[TEXT][MINOR]: p${n} — fix it` });
const STORED = rewrite({ 2: fx.pages[2].after, 9: fx.pages[9].after });
const SMALL = rewrite({ 2: fx.pages[2].before.replace(/\w+/, 'Ein') });

let labels: string[] = [];
let refineReplies: string[] = [];
let logicReply = '';
beforeEach(() => {
  labels = []; refineReplies = []; logicReply = JSON.stringify({ findings: [] });
  textModels.callTextModelStreaming = async (_p: string, _m: unknown, _i: unknown, model: string, opts: any = {}) => {
    const label = String(opts.usageLabel || '');
    labels.push(label);
    const text = label === 'text_logic_read' ? logicReply : (refineReplies.shift() ?? STORED);
    return { text, modelId: `stub-${model}`, usage: { input_tokens: 1, output_tokens: 1 } };
  };
});
process.on('exit', () => { textModels.callTextModelStreaming = realCall; });

describe('runPostAuditTextRound: no rewrite is rejected for size', () => {
  it('keeps the stored 64% and 65% verse rewrites', async () => {
    const res = await runPostAuditTextRound(STORY, pagesOf(), [fault(2), fault(9)]);
    expect(res.pages.map((p: any) => p.text)).toEqual([fx.pages[2].after, fx.pages[9].after]);
    expect(res.entry.changedPages).toEqual([2, 9]);
    expect(res.entry.majorChangePages.map((o: any) => o.pageNumber)).toEqual([2, 9]);
    expect(res.entry.editRatios.map((o: any) => Math.round(o.ratio * 100))).toEqual([64, 65]);
  });
  it('keeps them for a prose book too', async () => {
    const res = await runPostAuditTextRound({ ...STORY, storyCategory: 'adventure', storyTopic: '', textForm: undefined }, pagesOf(), [fault(2), fault(9)]);
    expect(res.pages.map((p: any) => p.text)).toEqual([fx.pages[2].after, fx.pages[9].after]);
  });
});

describe('runPostAuditTextRound: the retest', () => {
  it('does not fire when every page is under the threshold', async () => {
    refineReplies = [SMALL];
    const res = await runPostAuditTextRound(STORY, pagesOf(), [fault(2)]);
    expect(res.entry.changedPages).toEqual([2]);
    expect(res.entry.majorChangePages).toEqual([]);
    expect(res.entry.retest).toBeNull();
    expect(labels).not.toContain('text_logic_read');
  });
  it('fires ONCE after a major change and is recorded in the entry', async () => {
    const res = await runPostAuditTextRound(STORY, pagesOf(), [fault(2), fault(9)]);
    expect(labels.filter(l => l === 'text_logic_read')).toHaveLength(1);
    expect(res.entry.retest).toMatchObject({ ran: true, ok: true, majorCount: 0, fixedPages: [] });
    expect(typeof res.entry.retest.cost).toBe('number');
  });
  it('a MAJOR logic finding gets its one fix round, which never starts a second retest', async () => {
    logicReply = JSON.stringify({ findings: [{ question: 'CONTRADICTION', severity: 'MAJOR', pages: [2], quote: '', fix: 'make p2 agree' }] });
    refineReplies = [STORED, STORED];   // the book-audit fix, then the logic read's fix round (also a major change)
    const res = await runPostAuditTextRound(STORY, pagesOf(), [fault(2), fault(9)]);
    expect(labels.filter(l => l === 'text_logic_read')).toHaveLength(1);
    expect(labels.filter(l => l === 'text_logic_fix')).toHaveLength(1);
    expect(res.entry.retest.majorCount).toBe(1);
    expect(res.entry.retest.rounds.map((r: any) => r.kind)).toEqual(['logic_read', 'logic_fix']);
  });
  it('opts.noRetest suppresses it', async () => {
    await runPostAuditTextRound(STORY, pagesOf(), [fault(2), fault(9)], { noRetest: true });
    expect(labels).not.toContain('text_logic_read');
  });
});
