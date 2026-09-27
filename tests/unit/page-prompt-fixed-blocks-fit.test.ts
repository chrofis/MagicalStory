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
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const FX = require('./fixtures/page-prompt-fit-job_1790529840433_ar4u7qry3.json');
const pageRender = require('../../server/lib/pageRenderCall.js');
const worn = require('../../server/lib/wornItems.js');
const { IMAGE_MODELS } = require('../../server/config/models.js');
const { loadPromptTemplates } = require('../../server/services/prompts.js');
// @ts-expect-error - JS module without types
import { shrinkPromptForModel, PROMPT_CUT_ORDER, PROMPT_NEVER_CUT } from '../../server/lib/images.js';

/** Room the floor must leave under the cap: a page one citation longer still fits. */
const MARGIN = 300;

/** Paragraph openings of the ranked PROMPT_CUT_ORDER blocks — the only text the shrink may drop. */
const CUT_ORDER_PREFIXES = ['Generate a SINGLE', 'When the FIRST reference', '**HEIGHT ORDER', '**Composition', '**DEPTH AND SIZE', '**COUNTS'];

function build(page: any) {
  const inputData = { artStyle: FX.artStyle, language: FX.language, languageLevel: FX.languageLevel, layout: FX.layout };
  const tier = pageRender.pageRenderModel({ sceneMetadata: page.sceneMetadata, pageNumber: page.pageNumber });
  const make = pageRender.makePageImagePrompt({
    sceneDescription: page.sceneDescription, inputData, sceneCharacters: page.sceneCharacters,
    visualBible: FX.visualBible, pageNumber: page.pageNumber, characterPhotos: page.referencePhotos,
    pageImageModel: tier.pageImageModel,
  });
  return { prompt: String(make(page.vbRefElementIds)), cap: IMAGE_MODELS[tier.pageImageModel].maxPromptLength, model: tier.pageImageModel };
}

/** The prompt's size once EVERY allowed cut has run (the shrink reports it when told to fit into 1 char). */
async function floorOf(prompt: string, model: string): Promise<number> {
  try {
    await shrinkPromptForModel(prompt, 1, 'floor', model);
  } catch (e: any) {
    const m = String(e.message).match(/: (\d+) chars after every allowed drop/);
    if (m) return Number(m[1]);
    throw e;
  }
  throw new Error('a 1-char cap cannot be met');
}

beforeAll(async () => { await loadPromptTemplates(); });

describe.each(FX.pages.map((p: any) => [p.pageNumber, p]))('smoke page %i', (_n, page: any) => {
  it('is sent: fits the Grok cap, with room to spare after every allowed cut', async () => {
    const { prompt, cap, model } = build(page);
    expect(prompt.length).toBeLessThan(page.storedPromptLength);
    const sent = await shrinkPromptForModel(prompt, cap, 'test', model);
    expect(sent.length).toBeLessThanOrEqual(cap);
    expect(await floorOf(prompt, model)).toBeLessThanOrEqual(cap - MARGIN);
  });

  it('loses no scene content and no protected block on the way', async () => {
    const { prompt, cap, model } = build(page);
    const sent = await shrinkPromptForModel(prompt, cap, 'test', model);
    // Only ranked cut-order blocks may go; every other paragraph — THIS IMAGE
    // DEPICTS, the cast lines, worn items, the scene prose and the whole
    // protected tail — is sent verbatim.
    const paras = prompt.split(/\n{2,}/).map((p: string) => p.trim()).filter(Boolean);
    const kept = paras.filter((p: string) => !CUT_ORDER_PREFIXES.some(pre => p.startsWith(pre)));
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
    for (const marker of ['**REQUIRED CAST:**', '**REQUIRED OBJECTS', '**SEASON:**', '**LIGHT:**', '**ART STYLE', '**NO MARKS', '**HANDS:**', 'EXPRESSIONS AND EYES']) {
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
