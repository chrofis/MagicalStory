/**
 * The trial writer is two calls (docs/decisions.md 2026-10-10 "Trial writer: Flash arc+bible v4"):
 * a planner (gemini-3.7-flash, reasoning low) writes ARC + TITLE + VISUAL BIBLE + COVER SCENE, the pages
 * writer (Sonnet 5.5 medium) writes page texts and scene hints bound to it. Real stored output of one
 * measured run is the fixture (tests/unit/fixtures/trial-writer-two-calls/).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const PB = require('../../server/lib/promptBuilders.js');
const { loadPromptTemplates, PROMPT_TEMPLATES } = require('../../server/services/prompts.js');
const { MODEL_DEFAULTS } = require('../../server/config/models.js');
const { runTrialWriter, PAGES_MARKER } = require('../../server/lib/trialWriter.js');
const { ProgressiveUnifiedParser, UnifiedStoryParser } = require('../../server/lib/outlineParser');

const FIX = path.join(__dirname, 'fixtures', 'trial-writer-two-calls');
const read = (f: string) => fs.readFileSync(path.join(FIX, f), 'utf8');
const input = JSON.parse(read('input.json'));
const ARC = read('arc.txt').replace(/\r\n/g, '\n').trim();
const PAGES = read('pages.txt').replace(/\r\n/g, '\n').trim();

beforeAll(async () => { await loadPromptTemplates(); });

const stream = (text: string, onChunk: any, size = 400) => {
  let full = '';
  for (let i = 0; i < text.length; i += size) {
    const c = text.slice(i, i + size);
    full += c;
    if (onChunk) onChunk(c, full);
  }
};

/** a fake callTextModelStreaming that records its calls and replies from the fixture */
function fakeCaller(log: any[], overrides: any = {}) {
  return async (prompt: string, _max: any, onChunk: any, model: string, options: any) => {
    const call = { n: log.length + 1, prompt, model, options };
    log.push(call);
    const reply = call.n === 1 ? (overrides.arc ?? ARC) : (overrides.pages ?? PAGES);
    stream(reply, onChunk);
    return { text: reply, modelId: `id-of-${model}`, usage: { input_tokens: 100 * call.n, output_tokens: 10 * call.n }, truncation: overrides.truncation?.[call.n] };
  };
}

describe('trial writer prompts', () => {
  it('the planner prompt carries the mandatory cast line from the special details, once', () => {
    const p = PB.buildTrialArcPrompt(input, 6);
    expect(p.split('MANDATORY CAST & OBJECTS').length - 1).toBe(1);
    expect(p).toContain('Serena: ');
    expect(p).not.toMatch(/\{[A-Z][A-Z0-9_]*\}/);
  });

  it('the pages prompt carries the same line and the planner output verbatim as the plan', () => {
    const p = PB.buildTrialPagesPrompt(input, 6, ARC);
    expect(p).toContain('MANDATORY CAST & OBJECTS');
    expect(p).toContain('---STORY ARC---');
    expect(p).toContain(ARC.slice(0, 300));
    expect(p).toContain(ARC.slice(-300));
    expect(p).not.toMatch(/\{[A-Z][A-Z0-9_]*\}/);
  });

  it('no mandatory line when no character has special details', () => {
    const bare = { ...input, characters: input.characters.map((c: any) => ({ ...c, traits: { strengths: ['Joyeux'] }, customTraits: undefined })) };
    expect(PB.buildTrialMandatoryCast(bare)).toBe('');
    expect(PB.buildTrialArcPrompt(bare, 6)).not.toContain('MANDATORY CAST');
  });

  it('the planner writes the arc, bible and cover and no pages; the pages writer the reverse', () => {
    const a = PB.buildTrialArcPrompt(input, 6);
    const b = PB.buildTrialPagesPrompt(input, 6, ARC);
    expect(a).toContain('---VISUAL BIBLE---');
    expect(a).toContain('---COVER SCENE---');
    expect(a).not.toContain('# Scene Hint Format');
    expect(b).toContain('# Scene Hint Format');
    expect(b).toContain(PAGES_MARKER);
    expect(b).toMatch(/Output only the story pages/);
  });

  it('the planner is told the repair rules (v4): payoffs, consistency, topic, names, causality', () => {
    const a = PB.buildTrialArcPrompt(input, 6);
    expect(a).toMatch(/every setup \(a skill, clue, trick, object, promise\) pays off in a later beat or is not introduced/);
    expect(a).toMatch(/counts, object states and places stay consistent from page to page/);
    expect(a).toMatch(/each page's action follows from the previous page/);
    expect(a).toMatch(/no figure, animal or place gets a name except the characters and the Visual Bible entries/);
  });

  it('the templates stay generic: no name from the fixture story or a measured story leaks in', () => {
    for (const k of ['storyTrialArc', 'storyTrialPages']) expect(PROMPT_TEMPLATES[k], k).not.toMatch(/Serena|Montpreveyres|Barnab|\bEli\b|Lukas/);
  });
});

describe('runTrialWriter', () => {
  it('runs the planner first on its model at reasoning low, then the pages writer on the given model at the trial effort', async () => {
    const log: any[] = [];
    const r = await runTrialWriter({ inputData: input, sceneCount: 6, pagesModel: 'claude-sonnet', callText: fakeCaller(log) });
    expect(log.map(c => c.model)).toEqual([MODEL_DEFAULTS.trialArcModel, 'claude-sonnet']);
    expect(log[0].options).toEqual({ usageLabel: 'unified_story', reasoning: { effort: MODEL_DEFAULTS.trialArcEffort } });
    expect(log[1].options).toEqual({ usageLabel: 'unified_story', effort: MODEL_DEFAULTS.trialStoryEffort });
    // the handoff: B's prompt contains A's whole output
    expect(log[1].prompt).toContain(ARC.slice(0, 500));
    expect(log[1].prompt).toContain(ARC.slice(-500));
    // the merged transcript is A then B, usage is summed, the model id is the pages writer's
    expect(r.text).toBe(`${ARC}\n\n${PAGES}`);
    expect(r.usage.input_tokens).toBe(300);
    expect(r.usage.output_tokens).toBe(30);
    expect(r.modelId).toBe('id-of-claude-sonnet');
  });

  it('fires the arc callback once, before any pages chunk, with a text ending on the pages marker', async () => {
    const events: string[] = [];
    let armed = '';
    await runTrialWriter({
      inputData: input, sceneCount: 6, pagesModel: 'claude-sonnet', callText: fakeCaller([]),
      onArcText: (arcText: string, merged: string) => { events.push('arc'); armed = merged; expect(arcText).toBe(ARC); },
      onPagesChunk: (_chunk: string, merged: string) => { events.push('pages'); expect(merged.startsWith(ARC)).toBe(true); },
    });
    expect(events[0]).toBe('arc');
    expect(events.filter(e => e === 'arc').length).toBe(1);
    expect(events.filter(e => e === 'pages').length).toBeGreaterThan(1);
    expect(armed.trimEnd().endsWith(PAGES_MARKER)).toBe(true);
  });

  it('the progressive parser fires title, bible and cover when the planner lands, then every page', async () => {
    const order: string[] = [];
    const parser = new ProgressiveUnifiedParser({
      onTitle: () => order.push('title'),
      onVisualBible: () => order.push('bible'),
      onCoverScene: () => order.push('cover'),
      onPageComplete: (p: any) => order.push(`page${p.pageNumber}`),
    }, { isTrial: true });
    let pagesStarted = false;
    await runTrialWriter({
      inputData: input, sceneCount: 6, pagesModel: 'claude-sonnet', callText: fakeCaller([]),
      onArcText: (_a: string, merged: string) => parser.processChunk('', merged),
      onPagesChunk: (chunk: string, merged: string) => {
        if (!pagesStarted) { pagesStarted = true; order.push('--pages-start--'); }
        parser.processChunk(chunk, merged);
      },
    });
    parser.finalize();
    const startAt = order.indexOf('--pages-start--');
    expect(order.slice(0, startAt)).toEqual(expect.arrayContaining(['title', 'bible', 'cover']));
    expect(order.slice(startAt).filter(e => e.startsWith('page'))).toEqual(['page1', 'page2', 'page3', 'page4', 'page5', 'page6']);
  });

  it('the merged transcript parses with the real parser into the stored story shape', async () => {
    const r = await runTrialWriter({ inputData: input, sceneCount: 6, pagesModel: 'claude-sonnet', callText: fakeCaller([]) });
    const p = new UnifiedStoryParser(r.text, { isTrial: true });
    expect(p.extractTitle()).toBeTruthy();
    const vb = p.extractVisualBible();
    expect(vb).toBeTruthy();
    expect(Object.keys(vb)).toEqual(expect.arrayContaining(['secondaryCharacters', 'animals', 'artifacts', 'locations']));
    const pages = p.extractPages();
    expect(pages).toHaveLength(6);
    for (const pg of pages) {
      expect(Object.keys(pg)).toEqual(expect.arrayContaining(['pageNumber', 'text', 'sceneHint']));
      expect(pg.text.length).toBeGreaterThan(20);
    }
    // the cover reaches the pipeline through the progressive parser (onCoverScene, asserted above); the full parser
    // reads no cover from a trial transcript, the single-call writer's included.
  });

  it('fails loudly, with no fallback, when the planner returns no arc or no bible', async () => {
    const noArc = ARC.replace('---STORY ARC---', '---ARC---');
    await expect(runTrialWriter({ inputData: input, sceneCount: 6, pagesModel: 'claude-sonnet', callText: fakeCaller([], { arc: noArc }) })).rejects.toThrow(/---STORY ARC---/);
    const noVb = ARC.replace('---VISUAL BIBLE---', '---BIBLE---');
    await expect(runTrialWriter({ inputData: input, sceneCount: 6, pagesModel: 'claude-sonnet', callText: fakeCaller([], { arc: noVb }) })).rejects.toThrow(/---VISUAL BIBLE---/);
  });

  it('fails loudly when the pages writer returns no pages section, or either reply was cut off', async () => {
    await expect(runTrialWriter({ inputData: input, sceneCount: 6, pagesModel: 'claude-sonnet', callText: fakeCaller([], { pages: 'no pages here' }) })).rejects.toThrow(/---STORY PAGES---/);
    const cut = { suspected: true, reason: 'x', model: 'm', provider: 'p', stopReason: 'length', outputTokens: 1, maxTokens: 1 };
    await expect(runTrialWriter({ inputData: input, sceneCount: 6, pagesModel: 'claude-sonnet', callText: fakeCaller([], { truncation: { 1: cut } }) })).rejects.toThrow(/planner reply was cut off/);
    await expect(runTrialWriter({ inputData: input, sceneCount: 6, pagesModel: 'claude-sonnet', callText: fakeCaller([], { truncation: { 2: cut } }) })).rejects.toThrow(/pages reply was cut off/);
  });

  it('the Lab stage and the pipeline both call this one function, and the pipeline builds no trial prompt itself', () => {
    const lab = fs.readFileSync(path.join(__dirname, '../../server/lib/testlab.js'), 'utf8');
    const pipe = fs.readFileSync(path.join(__dirname, '../../storyJobPipeline.js'), 'utf8');
    expect(lab).toMatch(/runTrialWriter\(/);
    expect(pipe).toMatch(/runTrialWriter\(/);
    expect(pipe).not.toMatch(/buildTrial(Story|Arc|Pages)Prompt/);
  });
});
