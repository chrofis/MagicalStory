/**
 * Regression: staging trial job_1792476898085_zdswtvv9v. Call B (pages writer) returned TEXT-only pages
 * (page 6: "SCENE HINT: placeholder"); the pipeline then used the PAGE TEXT as the scene description and the
 * picture model painted the dialogue. Call B must deliver a scene hint for every page or the writer fails
 * loudly; the pipeline holds no page-text stand-in. docs/decisions.md "Trial call B must deliver a scene hint".
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

const caller = (pages: string) => async (_p: string, _m: any, onChunk: any, _model: string, _o: any) => {
  const isArc = !caller.seen++;
  const text = isArc ? ARC : pages;
  return { text, modelId: 'm', usage: { input_tokens: 1, output_tokens: 1 } };
};
caller.seen = 0;
const run = (pages: string, sceneCount = 6) => { caller.seen = 0; return runTrialWriter({ inputData: input, sceneCount, pagesModel: 'claude-sonnet', callText: caller(pages) }); };

describe('trial call B must deliver a scene hint for every page', () => {
  it('accepts a reply with a JSON scene hint on every page', async () => {
    await expect(run(GOOD)).resolves.toBeTruthy();
  });

  it('rejects the real stored text-only reply (pages 1-5 no hint, page 6 "placeholder")', async () => {
    await expect(run(TEXT_ONLY)).rejects.toThrow(/no usable scene hint.*page\(s\) 1, 2, 3, 4, 5, 6 of 6/);
  });

  it('names only the pages that lack a hint', async () => {
    const i = GOOD.indexOf('--- Page 3 ---');
    const j = GOOD.indexOf('--- Page 4 ---');
    const noHint3 = GOOD.slice(0, i) + GOOD.slice(i, j).split('SCENE HINT:')[0] + GOOD.slice(j);
    await expect(run(noHint3)).rejects.toThrow(/page\(s\) 3 of 6/);
  });

  it('rejects a hint that is not a JSON scene object', async () => {
    const broken = GOOD.replace(/```json\s*\{"scene"/, '```json\n{"nope"');
    await expect(run(broken)).rejects.toThrow(/no usable scene hint/);
  });

  it('the pipeline has no page-text stand-in for a missing scene hint', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'storyJobPipeline.js'), 'utf8');
    expect(src).not.toMatch(/page\.sceneHint\s*\|\|\s*page\.text/);
  });
});
