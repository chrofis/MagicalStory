/**
 * A FULL SCENE FITS THE GROK CAP — THE FIXED BLOCKS ARE COMPACT (owner, 2026-09-27).
 *
 * Staging job_1790529840433_ar4u7qry3 (4-page smoke story): pages 1 and 4
 * rendered NO image. After every allowed cut their prompts were 8,278 and
 * 8,122 chars against Grok's 7,900 — the scene (~3.6k) plus the never-cut
 * blocks (~4.6k). The fix the owner chose: shorten the fixed blocks, never cut
 * scene content, no element cap, no budget raise, no truncation fallback.
 *
 * The fixture is the stored page inputs; the builder is the production one
 * (pageRenderCall.makePageImagePrompt, which the Lab image stage also calls).
 * Before the fix this built byte-for-byte the prompt stored on the page.
 *
 * SIZE IS NEVER CUT (owner, 2026-10-04) — Composition: size and DEPTH AND SIZE
 * (~950 chars) left the cut order, so these two pages no longer fit on block
 * drops alone: their briefs predate the colour + garment noun outfit rule
 * (2026-09-30) and carry ~1.6k of scene prose against ~1.1k of room. They now
 * take the 2026-09-30 path: the scene prose is shortened (one LLM try, stubbed
 * here), every labelled block — the size blocks included — is sent whole, and
 * the page renders. Current-format briefs fit on drops alone:
 * prompt-fit-keeps-size-run9.test.ts.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const FX = require('./fixtures/page-prompt-fit-job_1790529840433_ar4u7qry3.json');
const pageRender = require('../../server/lib/pageRenderCall.js');
const worn = require('../../server/lib/wornItems.js');
const { IMAGE_MODELS } = require('../../server/config/models.js');
const { loadPromptTemplates } = require('../../server/services/prompts.js');
const PB = require('../../server/lib/promptBuilders.js');
const shorten = require('../../server/lib/sceneShorten.js');
const { PROMPT_TEMPLATES } = require('../../server/services/prompts.js');
// @ts-expect-error - JS module without types
import { shrinkPromptForModel, promptFloor, dedupeIdenticalBullets, PROMPT_CUT_ORDER, PROMPT_NEVER_CUT } from '../../server/lib/images.js';

// The cut MECHANISM is tested against the cap these stored fixtures were sized
// for. Grok's real cap was raised to 16,000 bytes (config 15,900) on 2026-10-04
// (decisions.md "Grok prompt caps are 16,000 / 64,000 bytes"), which these
// prompts now fit under, so the cap is passed to the shrink explicitly.
const MECHANISM_CAP = 7900;

/**
 * Scene-prose room the fixed blocks must leave under the cap once every
 * allowed drop has run (measured 2026-10-04 with size never cut: p1 1,156,
 * p4 1,093). A fixed block that grows eats into this and fails here.
 */
const MIN_SCENE_ROOM = 1000;

/** Paragraph openings of the ranked PROMPT_CUT_ORDER blocks — the only labelled text the shrink may drop. */
const CUT_ORDER_PREFIXES = ['Generate a SINGLE', 'When the FIRST reference', '**HEIGHT ORDER', '**Composition', '**COUNTS'];

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

function build(page: any) {
  const inputData = { artStyle: FX.artStyle, language: FX.language, languageLevel: FX.languageLevel, layout: FX.layout };
  const tier = pageRender.pageRenderModel({ sceneMetadata: page.sceneMetadata, pageNumber: page.pageNumber });
  const make = pageRender.makePageImagePrompt({
    sceneDescription: page.sceneDescription, inputData, sceneCharacters: page.sceneCharacters,
    visualBible: FX.visualBible, pageNumber: page.pageNumber, characterPhotos: page.referencePhotos,
    pageImageModel: tier.pageImageModel,
  });
  return { prompt: String(make(page.vbRefElementIds)), cap: MECHANISM_CAP, model: tier.pageImageModel };
}

/** The prompt's size once EVERY allowed cut has run (the shrink reports it when told to fit into 1 char). */
async function floorOf(prompt: string, _model: string): Promise<number> {
  return promptFloor(prompt);
}

beforeAll(async () => { await loadPromptTemplates(); });

describe.each(FX.pages.map((p: any) => [p.pageNumber, p]))('smoke page %i', (_n, page: any) => {
  it('the fixed blocks leave room for a scene after every allowed cut', async () => {
    const { prompt, cap, model } = build(page);
    expect(prompt.length).toBeLessThan(page.storedPromptLength);
    const fixed = (await floorOf(prompt, model)) - sceneProse(prompt).length;
    expect(cap - fixed).toBeGreaterThanOrEqual(MIN_SCENE_ROOM);
  });

  it('is sent: over the cap after every allowed cut, its scene is shortened (one LLM try) and it fits', async () => {
    const { prompt, cap, model } = build(page);
    expect(await floorOf(prompt, model)).toBeGreaterThan(cap); // size kept: drops alone no longer fit
    stubLlm();
    const meta: any = {};
    const sent = await shrinkPromptForModel(prompt, cap, 'test', model, meta);
    expect(sent.length).toBeLessThanOrEqual(cap);
    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0].prose).toBe(sceneProse(prompt));
    expect(sent).toContain('LLM_SHORTENED.');
    expect(meta.compressedScene).toContain('LLM_SHORTENED.'); // the judges read the scene that was sent
  });

  it('loses no labelled block on the way — the size blocks included; only the scene prose is shortened', async () => {
    const { prompt, cap, model } = build(page);
    stubLlm();
    const sent = await shrinkPromptForModel(prompt, cap, 'test', model);
    // Only ranked cut-order blocks and the scene prose may change; every other
    // paragraph — THIS IMAGE DEPICTS, the cast lines, worn items, DEPTH AND
    // SIZE and the whole protected tail — is sent verbatim.
    const paras = prompt.split(/\n{2,}/).map((p: string) => p.trim()).filter(Boolean);
    const kept = paras.filter((p: string) => shorten.isLabelledBlock(p) && !CUT_ORDER_PREFIXES.some(pre => p.startsWith(pre)));
    expect(kept.length).toBeGreaterThan(8);
    // Line by line: the dedupe step merges bullets with identical bodies
    // ("- A, B: body"), which keeps every name and every body.
    for (const line of kept.join('\n').split('\n').filter(Boolean)) {
      const bullet = line.match(/^- ([^:]{1,40}): (.{40,})$/);
      if (bullet) {
        expect(sent, line.slice(0, 60)).toContain(bullet[2]);
        expect(sent, line.slice(0, 60)).toContain(bullet[1]);
      } else {
        expect(sent, line.slice(0, 60)).toContain(line);
      }
    }
    // Size is never cut (2026-10-04): the Composition header with its size
    // bullet, DEPTH AND SIZE, and every REQUIRED OBJECTS scale rider.
    expect(sent).toContain(`${PB.COMPOSITION_HEADER}\n${PB.COMPOSITION_SIZE_BULLET}`);
    expect(sent).toContain(PROMPT_TEMPLATES.imageGeneration.split(/\n{2,}/).map((x: string) => x.trim()).find((x: string) => x.startsWith('**DEPTH AND SIZE:**')));
    const ro = (s: string) => s.slice(s.indexOf('**REQUIRED OBJECTS'), s.indexOf('\n\n', s.indexOf('**REQUIRED OBJECTS')));
    expect(sent).toContain(ro(prompt));
    for (const marker of ['**REQUIRED CAST:**', '**REQUIRED OBJECTS', '**SEASON:**', '**LIGHT:**', '**ART STYLE', '**NO MARKS', '**HANDS:**', 'EXPRESSIONS AND EYES', 'AGE & PROPORTIONS']) {
      expect(sent, marker).toContain(marker);
    }
    // Every card still maps a colour to its person.
    for (const p of page.referencePhotos) expect(sent).toMatch(new RegExp(`[A-Z]+ = ${p.name}\\b`));
  });
});

describe('AGE & PROPORTIONS ships whole on a cut page (owner, 2026-09-27)', () => {
  it('is not a cut step, and a page cut to its floor keeps the heading and every bullet', async () => {
    expect(PROMPT_CUT_ORDER.map((s: any) => s.label)).not.toContain('AGE & PROPORTIONS');
    expect(PROMPT_NEVER_CUT.map((s: any) => s.label)).toContain('AGE & PROPORTIONS');
    const page = FX.pages[0];
    const { prompt, cap, model } = build(page);
    const block = prompt.match(/^AGE & PROPORTIONS[^\n]*\n(?:- [^\n]+\n?)+/m)![0].trim();
    expect(block.split('\n').length).toBeGreaterThan(1);
    stubLlm();
    const sent = await shrinkPromptForModel(prompt, cap, 'test', model);
    expect(sent.length).toBeLessThan(prompt.length); // this page IS cut
    expect(sent).toContain(block);
  });
});

describe('the worn-items override is said once, not once per row', () => {
  const row = (owner: string, state: string, extra: any = {}) => ({
    id: `ART${owner}`, name: `${owner.toLowerCase()} scarf`, owner, wearer: owner, handedOver: false, state,
    entry: { id: `ART${owner}`, name: `${owner.toLowerCase()} scarf` }, slot: 'accessories', ...extra,
  });
  it('three rows carry one statement that the references do not decide', () => {
    const block = worn.buildWornStateBlock([row('A', 'worn'), row('B', 'off', { location: 'on the bench' }), row('C', 'worn')]);
    expect(block.split('attached reference').length - 1).toBe(1);
    expect(block).toContain(worn.WORN_ITEMS_HEADER);
    // Each row still states its own fact.
    expect(block).toMatch(/- A IS wearing this on this page: a scarf\./);
    expect(block).toMatch(/- B is NOT wearing this on this page: b scarf — on the bench\./);
    expect(block).toMatch(/- C IS wearing this on this page: c scarf\./);
  });
});

describe('the reference-card legend is one line', () => {
  it('names every card once, and the do-not-paint rule once', () => {
    const { prompt } = build(FX.pages[0]);
    const lines = prompt.split('\n').filter((l: string) => l.startsWith('REFERENCE CARD'));
    expect(lines).toHaveLength(1);
    for (const p of FX.pages[0].referencePhotos) expect(lines[0].split(`= ${p.name}`).length - 1).toBe(1);
    expect(prompt.split('never paint a frame').length - 1).toBe(1);
  });
});

describe('verify check pagePromptsFit', () => {
  const { checks } = require('../../scripts/admin/verify-checks.js');
  const ctx = (log: any[]) => ({ data: { sceneImages: [{ pageNumber: 1, prompt: 'x'.repeat(9000) }], generationLog: log } });
  it('fails a run with a prompt_fit_failed event', () => {
    const r = checks.pagePromptsFit(ctx([{ event: 'prompt_fit_failed', message: 'IMAGE GEN-ONLY page 1: 8278 chars' }]));
    expect(r).toMatchObject({ covered: true, pass: false });
  });
  it('passes a run whose renders all fit, cut or not', () => {
    const r = checks.pagePromptsFit(ctx([{ event: 'prompt_shrink', details: { branch: 'cut' } }]));
    expect(r).toMatchObject({ covered: true, pass: true });
    expect(r.detail).toMatch(/1 render\(s\) needed the ranked cut/);
  });
  it('is not covered when no page stored a prompt', () => {
    expect(checks.pagePromptsFit({ data: { sceneImages: [], generationLog: [] } }).covered).toBe(false);
  });
});
