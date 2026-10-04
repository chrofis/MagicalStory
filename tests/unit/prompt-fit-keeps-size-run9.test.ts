/**
 * SIZE IS NEVER CUT, AND A NORMAL STORY STILL RENDERS EVERY PAGE (2026-10-04).
 *
 * Two owner rules that have to hold at once:
 *   - the size blocks (Composition: size, DEPTH AND SIZE, the REQUIRED OBJECTS
 *     scale riders) are never cut — staging job_1791040103540_atbttop6w (dragon
 *     run 9) cut them on 13 of its 14 over-cap prompts and the grown dragon
 *     rendered egg-sized on p17/p18;
 *   - no page or cover ships without an image (2026-09-30): a prompt still over
 *     the cap after the allowed drops has its scene prose shortened, never a
 *     size block cut and never prompt_fit_failed.
 *
 * The fixture is every over-cap prompt of run 9, rebuilt from the prompt that
 * was SENT plus the logged dropped blocks (exact length match). These are
 * current-format briefs (colour + garment noun outfits, 2026-09-30): all 14
 * fit on block drops alone, so the scene-shortening LLM is never asked.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const FX = require('./fixtures/prompt-fit-run9-job_1791040103540_atbttop6w.json');
const PB = require('../../server/lib/promptBuilders.js');
const { loadPromptTemplates, PROMPT_TEMPLATES } = require('../../server/services/prompts.js');
const images = require('../../server/lib/images.js');
const shorten = require('../../server/lib/sceneShorten.js');

const ORIGINAL_TRY = shorten.shortenSceneOnce;
let llmCalls = 0;
afterEach(() => { shorten.shortenSceneOnce = ORIGINAL_TRY; });

let DEPTH = '';
beforeAll(async () => {
  await loadPromptTemplates();
  DEPTH = PROMPT_TEMPLATES.imageGeneration.split(/\n{2,}/).map((x: string) => x.trim())
    .find((x: string) => x.startsWith('**DEPTH AND SIZE:**'));
});

/** The REQUIRED OBJECTS block: its heading, every element with its scale rider, the precedence line. */
function requiredObjects(p: string): string {
  const i = p.indexOf('**REQUIRED OBJECTS');
  if (i < 0) return '';
  const end = p.indexOf('\n\n', i);
  return p.slice(i, end < 0 ? undefined : end);
}

describe.each(FX.prompts.map((x: any) => [x.id, x]))('run 9 %s', (_id, fx: any) => {
  it('fits the cap on block drops alone: size kept, no scene shortening, no failure', async () => {
    shorten.shortenSceneOnce = async () => { llmCalls++; throw new Error('the scene must not need shortening'); };
    llmCalls = 0;
    expect(fx.prompt.length).toBeGreaterThan(fx.cap);
    expect(images.promptFloor(fx.prompt)).toBeLessThanOrEqual(fx.cap);
    const meta: any = {};
    const sent: string = await images.shrinkPromptForModel(fx.prompt, fx.cap, `TEST run9 ${fx.id}`, null, meta);
    expect(llmCalls).toBe(0);
    expect(sent.length).toBeLessThanOrEqual(fx.cap);
    expect(sent).toContain(PB.COMPOSITION_SIZE_BULLET);
    expect(sent).toContain(DEPTH);
    const ro = requiredObjects(fx.prompt);
    expect(ro.length).toBeGreaterThan(0);
    expect(sent).toContain(ro);
    // The scene went out as built: the head the judges read is the built head minus ranked blocks only.
    for (const para of fx.prompt.split(/\n{2,}/).filter((p: string) => p.trim() && !shorten.isLabelledBlock(p))) {
      expect(sent, para.slice(0, 60)).toContain(para.trim());
    }
  });
});
