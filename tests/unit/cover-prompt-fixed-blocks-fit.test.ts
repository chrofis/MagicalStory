/**
 * A FULL-STORY FRONT COVER FITS THE GROK CAP (2026-09-28, bug cover-prompt-over-cap-after-compaction).
 *
 * Staging dragon run job_1790539784661_6mjcny1c7 shipped with NO front cover:
 * page -1 was 8,378 chars after every allowed cut (scene 3,620 + must-keep
 * 4,758) against Grok's 7,900. The page compaction had reached the cover (one
 * builder), but the cover carries blocks a page does not: the baked title
 * (REQUIRED TEXT), the copy-space OPEN AREA, and a WORN ITEMS block listing
 * whole outfits — one "X IS wearing this" line per garment, each garment name
 * said twice. The fixture is the stored brief; the builder is production's.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const FX = require('./fixtures/cover-prompt-fit-job_1790539784661_6mjcny1c7.json');
const pageRender = require('../../server/lib/pageRenderCall.js');
const { coverRenderOptions } = require('../../server/lib/coverRender.js');
const worn = require('../../server/lib/wornItems.js');
const { IMAGE_MODELS } = require('../../server/config/models.js');
const { loadPromptTemplates } = require('../../server/services/prompts.js');
// @ts-expect-error - JS module without types
import { shrinkPromptForModel } from '../../server/lib/images.js';

const CUT_ORDER_PREFIXES = ['Generate a SINGLE', 'When the FIRST reference', '**HEIGHT ORDER', '**Composition', '**DEPTH AND SIZE', '**COUNTS'];

function build() {
  const coverOpts = coverRenderOptions(-1, { title: FX.title, dedication: FX.dedication });
  const { extractSceneMetadata } = require('../../server/lib/storyHelpers.js');
  const tier = pageRender.pageRenderModel({ sceneMetadata: extractSceneMetadata(FX.brief), coverOpts, pageNumber: -1 });
  const inputData = { artStyle: FX.artStyle, language: FX.language, languageLevel: FX.languageLevel, layout: FX.layout };
  const prompt = String(pageRender.makePageImagePrompt({
    sceneDescription: FX.brief, inputData, sceneCharacters: FX.sceneCharacters, visualBible: FX.visualBible,
    pageNumber: -1, characterPhotos: FX.referencePhotos, pageImageModel: tier.pageImageModel, coverOpts,
  })(FX.vbRefElementIds));
  return { prompt, model: tier.pageImageModel, cap: IMAGE_MODELS[tier.pageImageModel].maxPromptLength };
}

async function floorOf(prompt: string, model: string): Promise<number> {
  try { await shrinkPromptForModel(prompt, 1, 'floor', model); } catch (e: any) {
    const m = String(e.message).match(/: (\d+) chars after every allowed drop/);
    if (m) return Number(m[1]);
    throw e;
  }
  throw new Error('a 1-char cap cannot be met');
}

beforeAll(async () => { await loadPromptTemplates(); });

describe('the dragon front cover', () => {
  it('fits Grok\'s cap after the allowed cuts, with room to spare', async () => {
    const { prompt, model, cap } = build();
    expect(await floorOf(prompt, model)).toBeLessThanOrEqual(cap - 150);
    expect((await shrinkPromptForModel(prompt, cap, 'test', model)).length).toBeLessThanOrEqual(cap);
  });

  it('sends the title, the scene and every protected block whole', async () => {
    const { prompt, model, cap } = build();
    const sent = await shrinkPromptForModel(prompt, cap, 'test', model);
    expect(sent).toContain(`Paint "${FX.title}"`);
    expect(sent).toContain('8% of the canvas width');
    for (const m of ['**REQUIRED TEXT:**', '**REQUIRED OBJECTS', '**REQUIRED CAST:**', '**COMPOSITION — OPEN AREA:**', '**SEASON:**', '**LIGHT:**', '**ART STYLE', 'AGE & PROPORTIONS']) {
      expect(sent, m).toContain(m);
    }
    const kept = prompt.split(/\n{2,}/).map((p: string) => p.trim()).filter(Boolean)
      .filter((p: string) => !CUT_ORDER_PREFIXES.some(pre => p.startsWith(pre)));
    for (const para of kept) expect(sent, para.slice(0, 60)).toContain(para);
  });

  it('lists every worn garment once per wearer line, never its name twice', () => {
    const { prompt } = build();
    const block = prompt.split(/\n{2,}/).find((p: string) => p.trim().startsWith('**WORN ITEMS'))!.trim();
    const rows = block.split('\n').slice(1);
    const wearers = rows.map((r: string) => r.match(/^- (\S+) IS wearing/)?.[1]).filter(Boolean);
    expect(new Set(wearers).size).toBe(wearers.length);
    expect(block).not.toMatch(/(\b[\w-]+ [\w-]+ [\w-]+\b) — (?:a |an |the )?\1\b/i);
  });
});

describe('worn rows of one character share a line; the name is said once', () => {
  const row = (owner: string, name: string, description = '') => ({
    id: `ART${name.length}`, name, owner, wearer: owner, handedOver: false, state: 'worn',
    entry: { id: `ART${name.length}`, name, description }, slot: 'top',
  });
  it('groups plain worn rows by wearer, in first-appearance order', () => {
    const lines = worn.buildWornStateLines([
      row('A', 'blue scarf'), row('B', 'red hat'), row('A', 'green coat with toggles'),
    ]);
    expect(lines).toEqual([
      '- A IS wearing these on this page: blue scarf; green coat with toggles.',
      '- B IS wearing this on this page: red hat.',
    ]);
  });
  it('drops a description\'s leading repeat of the item name, keeping the rest', () => {
    const [line] = worn.buildWornStateLines([row('A', 'red shirt', 'A red shirt with a round neckline. It is soft.')]);
    expect(line).toBe('- A IS wearing this on this page: red shirt — with a round neckline.');
  });
  it('a description that does not open with the name is kept whole', () => {
    const [line] = worn.buildWornStateLines([row('A', 'sash', 'a wide black cloth folded into a band')]);
    expect(line).toBe('- A IS wearing this on this page: sash — a wide black cloth folded into a band.');
  });
});

describe('the repair builds its page prompt through the shared closure', () => {
  it('images.js has no direct buildImagePrompt call — iterate uses pageRenderCall.makePageImagePrompt', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../server/lib/images.js'), 'utf8');
    expect(src).not.toMatch(/\bbuildImagePrompt\(/);
    expect(src).toMatch(/require\('\.\/pageRenderCall'\)\.makePageImagePrompt\(/);
  });
});
