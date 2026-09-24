import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// REQUIRED OBJECTS, SEASON and COMPOSITION GUIDELINES ARE MUST-KEEP (owner,
// 2026-09-23). A cover with no REQUIRED OBJECTS block had its protected tail
// start at ART STYLE — and the template places the cover's element block, SEASON
// and COMPOSITION right before it, at the very end of the trimmable head. The
// last-resort prose trim ate them first: staging job_1789853503332_riqncqg1i's
// back cover shipped with all three gone. They are now in the protected tail on
// every prompt; if the tail alone cannot fit, the shrink throws instead.
// (Every cover now carries REQUIRED OBJECTS like a page; the cover's separate
// KEY STORY ELEMENTS block was deleted the same day.)

// @ts-expect-error - JS module without types
import { shrinkPromptForModel } from '../../server/lib/images.js';
// @ts-expect-error - JS module without types
import { COUNTS_RULE, buildCompositionBlock } from '../../server/lib/promptBuilders.js';

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
    + 'Gulls wheel above the stone wall and the tide runs out slowly. '.repeat(proseRepeat),
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
  para('**REQUIRED CAST:**'),
  '',
  para('**DEPTH AND SIZE:**'),
  '',
  COUNTS_RULE,
].join('\n');

const MUST_KEEP = ['SENTINEL_ELEMENT_LINE', 'SENTINEL_SEASON', 'SENTINEL_COMPOSITION', '**ART STYLE:**'];

describe('cover shrink — the must-keep sections survive', () => {
  it('when the drops are not enough, the prose is trimmed and the three must-keep sections stay whole', async () => {
    const prompt = coverPrompt(100);
    const cap = 7000;
    expect(prompt.length).toBeGreaterThan(cap + 2500); // drops alone cannot fit it
    const out: string = await shrinkPromptForModel(prompt, cap, 'TEST cover', null);
    expect(out.length).toBeLessThanOrEqual(cap);
    for (const m of MUST_KEEP) expect(out).toContain(m);
    // the page's cast survives too
    expect(out).toContain('SENTINEL_OUTFIT');
  });

  it('when the must-keep tail alone cannot fit, it fails loudly instead of cutting it', async () => {
    const prompt = coverPrompt(2, 200);
    await expect(shrinkPromptForModel(prompt, 7000, 'TEST cover', null)).rejects.toThrow(/must-keep/);
  });

  it('with no REQUIRED OBJECTS block, SEASON still opens the protected tail', async () => {
    const prompt = coverPrompt(100).replace(/\*\*REQUIRED OBJECTS[^\n]*\n\* \*\*SENTINEL_ELEMENT_LINE[^\n]*\n/, '');
    expect(prompt).not.toContain('REQUIRED OBJECTS');
    const out: string = await shrinkPromptForModel(prompt, 7000, 'TEST no objects', null);
    for (const m of ['SENTINEL_SEASON', 'SENTINEL_COMPOSITION', '**ART STYLE:**']) expect(out).toContain(m);
  });
});
