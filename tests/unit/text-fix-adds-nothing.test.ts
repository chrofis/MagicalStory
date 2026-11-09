/**
 * A TEXT FIX NEVER ADDS (docs/decisions.md 2026-11-09 "A text fix never adds").
 *
 * Owner, 2026-11-09: "Retest also checks additions", "Make sure opus knows that is not supposed to add new
 * characters etc", and a book counts as rhyming only if it is actually written in verse.
 *   - ONE sentence (NO_NEW_ELEMENT_RULE) reaches the book review, the logic read's fix lines and the refiner.
 *   - The retest asks one more question (ADDED) inside the logic read it already runs, about the pages over the
 *     threshold only; the logic read after the lector is unchanged.
 *   - An ADDED finding is MAJOR and reaches the one fix round (noRetest).
 *   - isVerseStory reads the typed `textForm` field, never the topic; a rhyming-topic record without the field throws.
 * No model call: the text model is stubbed. Data: the staging Rubi replay (evals/runs/2026-11-09_post-audit-text-replay/v2-*).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const textModels = nodeRequire('../../server/lib/textModels.js');
const { loadPromptTemplates, fillTemplate, PROMPT_TEMPLATES } = nodeRequire('../../server/services/prompts.js');
const PB = nodeRequire('../../server/lib/promptBuilders.js');
const { parseLogicRead, toFaultLines, runLogicReadStep } = nodeRequire('../../server/lib/textLogicRead.js');
const { runPostAuditTextRound } = nodeRequire('../../server/lib/textRefine.js');
const { buildChunkInstructions, bookAuditStoryFill } = nodeRequire('../../server/lib/bookAudit.js');
const fx = nodeRequire('./fixtures/rubi-additions-v2.json');

const { getLanguageNameEnglish } = nodeRequire('../../server/lib/languages.js');
const RULE: string = PB.NO_NEW_ELEMENT_RULE;
beforeAll(async () => { await loadPromptTemplates(); });

const STORY: any = { language: 'de-ch', languageLevel: 'standard', characters: [{ id: 'c1', name: 'Janna', age: 8, gender: 'female' }], mainCharacters: ['c1'] };
const page = (n: number, text: string) => ({ pageNumber: n, text, sceneIntent: 'x', sceneBrief: 'x', planLine: '' });
const pagesAfter = () => [page(1, 'Janna ging in den Wald.'), page(5, fx.after['5']), page(10, fx.after['10'])];
const pagesBefore = () => [page(1, 'Janna ging in den Wald.'), page(5, fx.before['5']), page(10, fx.before['10'])];
const faultText = (f: string) => f.replace(/^FAULT\[[^\]]*\](\[[^\]]*\])?:\s*p\d+\s*\S\s*/, '');
const additions = () => [5, 10].map(n => ({
  pageNumber: n, before: fx.before[n], after: fx.after[n],
  findings: fx.faults.filter((f: string) => f.includes(`p${n} `)).map(faultText),
}));

describe('the shared sentence', () => {
  it('names what a fix may not bring in', () => {
    for (const w of ['character', 'creature', 'group', 'place', 'object', 'event', 'ability', 'rule']) expect(RULE).toContain(w);
    expect(RULE).toMatch(/^A fix never brings in/);
  });
  it('appears in the rendered book review, the logic read and the refiner', () => {
    const { instructions } = buildChunkInstructions(PROMPT_TEMPLATES.bookAudit, [{ pageNumber: 1 }], null, bookAuditStoryFill(STORY));
    // Q1's FAULT[TEXT] rule, the listener-questions rule, the fault-line format sentence
    expect(instructions.split(RULE).length - 1).toBe(3);
    expect(instructions).not.toMatch(/\{NO_NEW_ELEMENT\}/);
    expect(instructions).not.toContain('adds no new rule, creature ability or event');
    expect(PB.buildTextLogicReadPrompt(STORY, pagesAfter())).toContain(RULE);
    expect(PB.buildTextRefinePrompt(STORY, pagesAfter(), '', '1. A story.')).toContain(RULE);
  });
});

describe('the retest prompt: the additions question', () => {
  it('carries BEFORE, AFTER and the finding for each over-threshold page, and the question', () => {
    const p = PB.buildTextLogicReadPrompt(STORY, pagesAfter(), { additions: additions() });
    expect(p).toContain('# REWRITTEN PAGES');
    expect(p).toContain('ADDED. The rule for any fix: ' + RULE);
    expect(p).toContain('An addition is always MAJOR');
    expect(p).toContain('CAUSE|VERSE|ADDED>');
    for (const n of [5, 10]) {
      expect(p).toContain(fx.before[n].trim());
      expect(p).toContain(fx.after[n].trim());
    }
    expect(p).toContain('- After «Das Licht wurde schon blasser», add a sentence saying that if the light goes out, Rubi cannot get home.');
    expect(p).not.toMatch(/\{[A-Z_]+\}/);
  });
  it('shows before/after only for the pages passed (the over-threshold ones)', () => {
    const p = PB.buildTextLogicReadPrompt(STORY, pagesAfter(), { additions: additions().slice(0, 1) });
    expect(p.match(/^BEFORE:$/gm)).toHaveLength(1);
    expect(p).toContain(fx.before[5].trim());
    expect(p).not.toContain(fx.before[10].trim());
  });
  it('the logic read after the lector is unchanged: no question, no before/after, only the shared sentence is new', () => {
    const none = PB.buildTextLogicReadPrompt(STORY, pagesAfter());
    expect(none).not.toContain('REWRITTEN PAGES');
    expect(none).not.toContain('ADDED');
    expect(none).toContain('CAUSE|VERSE>');
    const legacy = fillTemplate(PROMPT_TEMPLATES.storyTextLogicRead, {
      LANGUAGE: getLanguageNameEnglish('de-ch'), MAIN_CHARACTERS: PB.mainCharactersText(STORY),
      PAGES: pagesAfter().map(p => `--- Page ${p.pageNumber} ---\n${p.text.trim()}`).join('\n\n'),
      FRIEND_REASON: PB.FRIEND_REASON_RULE, NO_NEW_ELEMENT: RULE, VERSE_FORM: '', VERSE_QUESTION: '', ADDITIONS: '', ADDED_ID: '',
    });
    expect(none).toBe(legacy);
  });
  it('runPostAuditTextRound hands the before/after of its over-threshold pages to the retest', async () => {
    const real = textModels.callTextModelStreaming;
    const sent: Record<string, string> = {};
    textModels.callTextModelStreaming = async (prompt: string, _a: unknown, _b: unknown, _m: string, o: any = {}) => {
      sent[o.usageLabel] = prompt;
      const text = o.usageLabel === 'text_logic_read'
        ? JSON.stringify({ findings: [] })
        : '---ANALYSIS---\nT1 fixed\n---STORY TEXT---\n' + [5, 10].map(n => `## Page ${n}\n${fx.after[n]}`).join('\n\n');
      return { text, modelId: 'stub', usage: { input_tokens: 1, output_tokens: 1 } };
    };
    try {
      const faults = fx.faults.map((line: string, i: number) => ({ page: [5, 10][i], severity: 'MINOR', line }));
      await runPostAuditTextRound(STORY, pagesBefore(), faults);
      const read = sent['text_logic_read'];
      expect(read).toContain('# REWRITTEN PAGES');
      expect(read).toContain(fx.before['5'].trim());
      expect(read).toContain(fx.after['10'].trim());
    } finally { textModels.callTextModelStreaming = real; }
  });
});

describe('an ADDED finding', () => {
  const reply = JSON.stringify({ findings: [{ pages: [5], question: 'ADDED', severity: 'MAJOR', quote: 'geht seine Herde ohne ihn', fix: 'Remove the herd from the sentence; say only that Rubi cannot get home.' }] });
  it('parses as MAJOR and becomes a fault line for its page', () => {
    const r = parseLogicRead(reply, pagesAfter());
    expect(r.ok).toBe(true);
    expect(r.findings[0]).toMatchObject({ question: 'ADDED', severity: 'MAJOR', pages: [5] });
    expect(toFaultLines(r.findings)[0].line).toMatch(/^FAULT\[ADDED\]: p5 — /);
  });
  it('reaches the one fix round, which is a noRetest round', async () => {
    const real = textModels.callTextModelStreaming;
    const labels: string[] = [];
    const prompts: Record<string, string> = {};
    textModels.callTextModelStreaming = async (prompt: string, _a: unknown, _b: unknown, _m: string, o: any = {}) => {
      labels.push(o.usageLabel); prompts[o.usageLabel] = prompt;
      const text = o.usageLabel === 'text_logic_read' ? reply : '---ANALYSIS---\nfixed\n---STORY TEXT---\n## Page 5\n' + fx.before['5'];
      return { text, modelId: 'stub', usage: { input_tokens: 1, output_tokens: 1 } };
    };
    try {
      const res = await runLogicReadStep(STORY, pagesAfter(), { additions: additions() });
      expect(res.logicRead.majorCount).toBe(1);
      expect(labels).toEqual(['text_logic_read', 'text_logic_fix']);
      expect(prompts['text_logic_fix']).toContain('FAULT[ADDED]: p5');
      expect(prompts['text_logic_fix']).toContain(RULE);
      expect(res.rounds.map((r: any) => r.kind)).toEqual(['logic_read', 'logic_fix']);
    } finally { textModels.callTextModelStreaming = real; }
  });
});

describe('isVerseStory reads the typed field, not the topic', () => {
  const topic = { storyCategory: 'educational', storyTopic: 'rhyming' };
  it('verse only when the writer stamped textForm verse', () => {
    expect(PB.isVerseStory({ ...topic, textForm: 'verse' })).toBe(true);
  });
  it('a rhyming-topic book recorded as prose is not verse (a prose book is not rewritten into verse)', () => {
    expect(PB.isVerseStory({ ...topic, textForm: 'prose' })).toBe(false);
    expect(PB.verseFormFor({ ...topic, textForm: 'prose' }, 'rewrite')).toBe('');
  });
  it('a story of another topic is prose with no field', () => {
    expect(PB.isVerseStory({ storyCategory: 'adventure', storyTopic: '' })).toBe(false);
  });
  it('a rhyming-topic record with no field throws, never guesses', () => {
    expect(() => PB.isVerseStory(topic)).toThrow(/textForm/);
    expect(() => PB.verseFormFor(topic, 'audit')).toThrow(/textForm/);
  });
  it('the page writer reads the topic and stamps the field', () => {
    const input: any = { ...topic };
    expect(PB.verseFormFor(input, 'write')).toContain('VERSE FORM.');
    PB.markVerseWriter(input);
    expect(input.textForm).toBe('verse');
    const other: any = { storyCategory: 'adventure', storyTopic: '' };
    PB.markVerseWriter(other);
    expect(other.textForm).toBeUndefined();
  });
});
