/**
 * Regression: staging trial job_1792476898085_zdswtvv9v. Call B (pages writer) returned TEXT-only pages
 * (page 6: "SCENE HINT: placeholder"); the pipeline then used the PAGE TEXT as the scene description and the
 * picture model painted the dialogue. Call B must deliver a scene hint for every page: one fed-back re-ask
 * naming the pages that lack one, then a loud failure. The pipeline holds no page-text stand-in.
 * docs/decisions.md 2026-10-20 "Trial call B must deliver a scene hint".
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { loadPromptTemplates } = require('../../server/services/prompts.js');
const { runTrialWriter } = require('../../server/lib/trialWriter.js');
const FIX = path.join(__dirname, 'fixtures', 'trial-writer-two-calls');
const read = (f: string) => fs.readFileSync(path.join(FIX, f), 'utf8').replace(/\r\n/g, '\n').trim();
const input = JSON.parse(read('input.json'));
const ARC = read('arc.txt');
const GOOD = read('pages.txt');
const TEXT_ONLY = read('pages-text-only-2026-10-20.txt'); // the real failed reply, stored

beforeAll(async () => { await loadPromptTemplates(); });

/** replies: call 1 = planner, call 2 = pages, call 3 = re-ask */
function caller(pagesReplies: string[], log: any[] = []) {
  return async (prompt: string, _m: any, onChunk: any, _model: string, _o: any) => {
    log.push({ prompt, streamed: false });
    const n = log.length;
    const text = n === 1 ? ARC : pagesReplies[n - 2];
    if (text === undefined) throw new Error(`unexpected call ${n}`);
    if (onChunk && n === 2) onChunk(text, text);
    return { text, modelId: 'm', usage: { input_tokens: 10, output_tokens: 5 } };
  };
}
const run = (replies: string[], log: any[] = [], sceneCount = 6) =>
  runTrialWriter({ inputData: input, sceneCount, pagesModel: 'claude-sonnet', callText: caller(replies, log) });
const pageBlock = (text: string, n: number) => {
  const i = text.indexOf(`--- Page ${n} ---`);
  const j = text.indexOf(`--- Page ${n + 1} ---`);
  return text.slice(i, j < 0 ? undefined : j);
};

describe('trial call B must deliver a scene hint for every page', () => {
  it('a good reply needs no re-ask', async () => {
    const log: any[] = [];
    await run([GOOD], log);
    expect(log).toHaveLength(2);
  });

  it('the real stored text-only reply is re-asked once, with the missing pages named, and the good reply is used', async () => {
    const log: any[] = [];
    const r = await run([TEXT_ONLY, GOOD], log);
    expect(log).toHaveLength(3);
    expect(log[2].prompt.startsWith(log[1].prompt)).toBe(true);
    expect(log[2].prompt).toMatch(/no usable SCENE HINT for page\(s\) 1, 2, 3, 4, 5, 6\./);
    expect((r.text.match(/SCENE HINT:/g) || []).length).toBe(6);
    expect(r.usage.input_tokens).toBe(30);
  });

  it('only the pages that lack a hint are re-asked and replaced; a page with a valid hint keeps attempt 1', async () => {
    const p3 = pageBlock(GOOD, 3);
    const noHint3 = GOOD.replace(p3, p3.split('SCENE HINT:')[0]);
    const other = GOOD.replace('--- Page 1 ---', '--- Page 1 ---\nREPLACED-IN-ATTEMPT-2');
    const log: any[] = [];
    const r = await run([noHint3, other], log);
    expect(log[2].prompt).toMatch(/for page\(s\) 3\./);
    expect(r.text).not.toContain('REPLACED-IN-ATTEMPT-2');
    expect(r.pagesText).toContain(p3.split('SCENE HINT:')[1].slice(0, 40));
  });

  it('throws, naming the pages, when the re-ask still lacks hints (no page-text fallback)', async () => {
    await expect(run([TEXT_ONLY, TEXT_ONLY])).rejects.toThrow(/page\(s\) 1, 2, 3, 4, 5, 6 of 6, after one re-ask/);
  });

  it('a hint that is not a JSON scene object counts as missing', async () => {
    const broken = GOOD.replace(/```json\s*\{"scene"/, '```json\n{"nope"');
    const log: any[] = [];
    await run([broken, GOOD], log);
    expect(log).toHaveLength(3);
  });

  it('the pipeline has no page-text stand-in for a missing scene hint', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'storyJobPipeline.js'), 'utf8');
    expect(src).not.toMatch(/page\.sceneHint\s*\|\|\s*page\.text/);
  });
});
