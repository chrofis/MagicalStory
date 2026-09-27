import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// REQUIRED OBJECTS, SEASON and COMPOSITION GUIDELINES ARE MUST-KEEP (owner,
// 2026-09-23). A cover with no REQUIRED OBJECTS block had its protected tail
// start at ART STYLE — and the template places the cover's element block, SEASON
// and COMPOSITION right before it, at the very end of the trimmable head. The
// last-resort prose trim ate them first: staging job_1789853503332_riqncqg1i's
// back cover shipped with all three gone. They are now in the protected tail on
// every prompt. Since 2026-09-26 the prose before the tail is never trimmed
// either (owner: "The eval should judge the same thing as image generation"):
// a prompt the ranked drops cannot fit fails loudly.
// (Every cover now carries REQUIRED OBJECTS like a page; the cover's separate
// KEY STORY ELEMENTS block was deleted the same day.)

// @ts-expect-error - JS module without types
import { shrinkPromptForModel } from '../../server/lib/images.js';
// @ts-expect-error - JS module without types
import { COUNTS_RULE, buildCompositionBlock, buildRequiredCastRule } from '../../server/lib/promptBuilders.js';

const TEMPLATE = fs.readFileSync(path.join(process.cwd(), 'prompts', 'image-generation.txt'), 'utf-8');
const para = (prefix: string) => {
  const p = TEMPLATE.split(/\n{2,}/).map(x => x.trim()).find(x => x.startsWith(prefix));
  if (!p) throw new Error(`no paragraph "${prefix}"`);
  return p;
};

// A cover's shape: cast + prose in the head, then the must-keep tail.
const coverPrompt = (proseRepeat: number, styleRepeat = 20) => [
  para('Generate a SINGLE illustration'),
  '',
  '**CHARACTERS IN THIS IMAGE (each person, then what that person wears):**',
  '- The main character is a school-age child. Wearing: SENTINEL_OUTFIT.',
  '',
  'A wide group portrait set before the harbour. The main character stands in the center, eyes on the viewer. '
    + 'Gulls wheel above the stone wall and the tide runs out slowly. '.repeat(proseRepeat)
    + 'SENTINEL_PROSE_END the last sentence of the brief.',
  '',
  buildCompositionBlock(),
  '',
  '**REQUIRED OBJECTS IN THIS SCENE (each appears exactly as the scene description places it):**',
  '* **SENTINEL_ELEMENT_LINE** (animal) — about knee-high',
  '',
  '**SEASON:** Autumn. SENTINEL_SEASON foliage and daylight are autumn\'s throughout the book.',
  '',
  '**COMPOSITION GUIDELINES:**',
  '- SENTINEL_COMPOSITION all main characters are prominently featured.',
  '',
  '**ART STYLE:** ' + 'A painterly style with visible brushwork. '.repeat(styleRepeat),
  '',
  buildRequiredCastRule('ambient'),
  '',
  para('**DEPTH AND SIZE:**'),
  '',
  COUNTS_RULE,
].join('\n');

const MUST_KEEP = ['SENTINEL_ELEMENT_LINE', 'SENTINEL_SEASON', 'SENTINEL_COMPOSITION', '**ART STYLE:**'];

describe('cover shrink — the must-keep sections survive', () => {
  // A cap the ranked drops can reach: the prompt is over it by less than the
  // droppable blocks (COUNTS + DEPTH AND SIZE + the Composition bullets).
  const fitCap = (prompt: string) => prompt.length - 400;

  it('the drops fit it: every must-keep section, the cast and the WHOLE prose stay', async () => {
    const prompt = coverPrompt(20);
    const cap = fitCap(prompt);
    const out: string = await shrinkPromptForModel(prompt, cap, 'TEST cover', null);
    expect(out.length).toBeLessThanOrEqual(cap);
    for (const m of MUST_KEEP) expect(out).toContain(m);
    expect(out).toContain('SENTINEL_OUTFIT');
    expect(out).toContain('SENTINEL_PROSE_END the last sentence of the brief.');
  });

  it('when the drops are not enough, it fails loudly and never trims the prose', async () => {
    const prompt = coverPrompt(100);
    const cap = 7000;
    expect(prompt.length).toBeGreaterThan(cap + 2500); // drops alone cannot fit it
    await expect(shrinkPromptForModel(prompt, cap, 'TEST cover', null)).rejects.toThrow(/refusing to cut/);
  });

  it('when the must-keep tail alone cannot fit, it fails loudly instead of cutting it', async () => {
    const prompt = coverPrompt(2, 200);
    await expect(shrinkPromptForModel(prompt, 7000, 'TEST cover', null)).rejects.toThrow(/must-keep/);
  });

  // REQUIRED CAST is never cut (owner, 2026-09-25; staging
  // job_1790277448294_5herh01j7 lost it on p3, p10, p14 and the back cover).
  it('REQUIRED CAST survives every shrink, the drops go to other blocks', async () => {
    const prompt = coverPrompt(20);
    const out: string = await shrinkPromptForModel(prompt, fitCap(prompt), 'TEST cover', null);
    expect(out).toContain(buildRequiredCastRule('ambient'));
  });
  it('REQUIRED CAST is on the never-cut list and no longer a cut step', async () => {
    const images = await import('../../server/lib/images.js');
    expect(images.PROMPT_NEVER_CUT.map((k: any) => k.label)).toContain('REQUIRED CAST');
    expect(images.PROMPT_CUT_ORDER.map((k: any) => k.label)).not.toContain('REQUIRED CAST');
  });

  it('with no REQUIRED OBJECTS block, SEASON still opens the protected tail', async () => {
    const prompt = coverPrompt(20).replace(/\*\*REQUIRED OBJECTS[^\n]*\n\* \*\*SENTINEL_ELEMENT_LINE[^\n]*\n/, '');
    expect(prompt).not.toContain('REQUIRED OBJECTS');
    const out: string = await shrinkPromptForModel(prompt, fitCap(prompt), 'TEST no objects', null);
    expect(out).toContain('SENTINEL_PROSE_END the last sentence of the brief.');
    for (const m of ['SENTINEL_SEASON', 'SENTINEL_COMPOSITION', '**ART STYLE:**']) expect(out).toContain(m);
  });
});
