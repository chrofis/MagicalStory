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
 *
 * SIZE IS NEVER CUT (owner, 2026-10-04): with Composition: size and DEPTH AND
 * SIZE protected, this cover's floor (8,654) is over the cap again, so it takes
 * the 2026-09-30 path — its scene prose is shortened (one LLM try, stubbed here)
 * and every labelled block, the title and the size blocks are sent whole. The
 * current-format front cover of dragon run 9 fits on block drops alone
 * (prompt-fit-keeps-size-run9.test.ts).
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
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
const PB = require('../../server/lib/promptBuilders.js');
const shorten = require('../../server/lib/sceneShorten.js');
const { PROMPT_TEMPLATES } = require('../../server/services/prompts.js');
// @ts-expect-error - JS module without types
import { shrinkPromptForModel, promptFloor, dedupeIdenticalBullets, PROMPT_NEVER_CUT } from '../../server/lib/images.js';

// The cut MECHANISM is tested against the cap these stored fixtures were sized
// for. Grok's real cap was raised to 16,000 bytes (config 15,900) on 2026-10-04
// (decisions.md "Grok prompt caps are 16,000 / 64,000 bytes"), which these
// prompts now fit under, so the cap is passed to the shrink explicitly.
const MECHANISM_CAP = 7900;

/** Paragraph openings of the ranked PROMPT_CUT_ORDER blocks — the only labelled text the shrink may drop. */
const CUT_ORDER_PREFIXES = ['Generate a SINGLE', 'When the FIRST reference', '**HEIGHT ORDER', '**Composition', '**COUNTS'];

/**
 * Scene-prose room the cover's fixed blocks must leave under the cap once every
 * allowed drop has run (measured 2026-10-04 with size never cut: 591). A cover
 * block that grows eats into this and fails here.
 */
const MIN_SCENE_ROOM = 500;

/** The one scene-shortening LLM try, stubbed: a sentence-cut copy of the prose that fits its target. */
const ORIGINAL_TRY = shorten.shortenSceneOnce;
let llmCalls: Array<{ prose: string; target: number }> = [];
function stubLlm() {
  llmCalls = [];
  shorten.shortenSceneOnce = async (prose: string, target: number) => {
    llmCalls.push({ prose, target });
    return `${shorten.cutAtSentence(prose, target - 40)} LLM_SHORTENED.`;
  };
}
afterEach(() => { shorten.shortenSceneOnce = ORIGINAL_TRY; });

/** The scene prose of a built prompt: the head's paragraphs that are no labelled block. */
function sceneProse(prompt: string): string {
  const p = dedupeIdenticalBullets(prompt);
  const tailStart = Math.min(...PROMPT_NEVER_CUT.filter((k: any) => k.marker)
    .map((k: any) => p.indexOf(k.marker)).filter((i: number) => i >= 0));
  const head = p.slice(0, tailStart);
  return shorten.sceneParagraphIndices(head).map((i: number) => head.split('\n\n')[i]).join('\n\n');
}

function build() {
  const coverOpts = coverRenderOptions(-1, { title: FX.title, dedication: FX.dedication });
  const { extractSceneMetadata } = require('../../server/lib/storyHelpers.js');
  const tier = pageRender.pageRenderModel({ sceneMetadata: extractSceneMetadata(FX.brief), coverOpts, pageNumber: -1 });
  const inputData = { artStyle: FX.artStyle, language: FX.language, languageLevel: FX.languageLevel, layout: FX.layout };
  const prompt = String(pageRender.makePageImagePrompt({
    sceneDescription: FX.brief, inputData, sceneCharacters: FX.sceneCharacters, visualBible: FX.visualBible,
    pageNumber: -1, characterPhotos: FX.referencePhotos, pageImageModel: tier.pageImageModel, coverOpts,
  })(FX.vbRefElementIds));
  return { prompt, model: tier.pageImageModel, cap: MECHANISM_CAP };
}

async function floorOf(prompt: string, _model: string): Promise<number> {
  return promptFloor(prompt);
}

beforeAll(async () => { await loadPromptTemplates(); });

describe('the dragon front cover', () => {
  it('fits Grok\'s cap: over it after the allowed cuts, its scene is shortened by one LLM try', async () => {
    const { prompt, model, cap } = build();
    expect(await floorOf(prompt, model)).toBeGreaterThan(cap); // size kept: drops alone no longer fit
    stubLlm();
    const meta: any = {};
    const sent = await shrinkPromptForModel(prompt, cap, 'test', model, meta);
    expect(sent.length).toBeLessThanOrEqual(cap);
    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0].prose).toBe(sceneProse(prompt));
    expect(sent).toContain('LLM_SHORTENED.');
    expect(meta.compressedScene).toContain('LLM_SHORTENED.');
  });

  it('the fixed blocks leave room for a scene after every allowed cut', async () => {
    const { prompt, model, cap } = build();
    const fixed = (await floorOf(prompt, model)) - sceneProse(prompt).length;
    expect(cap - fixed).toBeGreaterThanOrEqual(MIN_SCENE_ROOM);
  });

  it('sends the title and every labelled block whole — the size blocks included; only the scene prose is shortened', async () => {
    const { prompt, model, cap } = build();
    stubLlm();
    const sent = await shrinkPromptForModel(prompt, cap, 'test', model);
    expect(sent).toContain(`Paint "${FX.title}"`);
    expect(sent).toContain('8% of the canvas width');
    for (const m of ['**REQUIRED TEXT:**', '**REQUIRED OBJECTS', '**REQUIRED CAST:**', '**COMPOSITION — OPEN AREA:**', '**SEASON:**', '**LIGHT:**', '**ART STYLE', 'AGE & PROPORTIONS']) {
      expect(sent, m).toContain(m);
    }
    const kept = prompt.split(/\n{2,}/).map((p: string) => p.trim()).filter(Boolean)
      .filter((p: string) => shorten.isLabelledBlock(p) && !CUT_ORDER_PREFIXES.some(pre => p.startsWith(pre)));
    for (const para of kept) expect(sent, para.slice(0, 60)).toContain(para);
    expect(sent).toContain(`${PB.COMPOSITION_HEADER}\n${PB.COMPOSITION_SIZE_BULLET}`);
    expect(sent).toContain(PROMPT_TEMPLATES.imageGeneration.split(/\n{2,}/).map((x: string) => x.trim()).find((x: string) => x.startsWith('**DEPTH AND SIZE:**')));
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
