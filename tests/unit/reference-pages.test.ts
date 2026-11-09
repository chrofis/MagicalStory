/**
 * Reference pages (owner, 2026-11-09, prod job_1794231161354_l3n2o3afm p6): a redraw told "as on
 * pages 4, 5 and 7" gets those pages' pictures as ONE captioned reference sheet, an extra slot above
 * the normal packing. docs/decisions.md 2026-11-09.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import sharp from 'sharp';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const rp: any = nodeRequire('../../server/lib/referencePages.js');
const grok: any = nodeRequire('../../server/lib/grok.js');
const read = (p: string) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

const solid = async (r: number, g: number, b: number, w = 300, h = 400) =>
  `data:image/jpeg;base64,${(await sharp({ create: { width: w, height: h, channels: 3, background: { r, g, b } } }).jpeg().toBuffer()).toString('base64')}`;
const buf = (dataUrl: string) => Buffer.from(dataUrl.split(',')[1], 'base64');

describe('composeReferencePagesSheet', () => {
  it('puts every page in ONE image at the page aspect, each under a printed caption', async () => {
    const pages = [
      { pageNumber: 4, imageData: await solid(200, 30, 30) },
      { pageNumber: 5, imageData: await solid(30, 200, 30) },
      { pageNumber: 7, imageData: await solid(30, 30, 200) },
    ];
    const sheet: Buffer = await rp.composeReferencePagesSheet(pages, '3:4');
    const meta = await sharp(sheet).metadata();
    expect(meta.width).toBe(768);
    expect(meta.height).toBe(1024);
    // 3 pages -> 2x2 grid. Each cell's top strip is the black caption; the caption text makes it
    // contain bright pixels too, which an empty black bar would not.
    const { data, info } = await sharp(sheet).raw().toBuffer({ resolveWithObject: true });
    const px = (x: number, y: number) => { const i = (y * info.width + x) * info.channels; return [data[i], data[i + 1], data[i + 2]]; };
    const cell = { w: 384, h: 512 };
    for (const [cx, cy] of [[0, 0], [1, 0], [0, 1]]) {
      let dark = 0, bright = 0;
      for (let y = cy * cell.h + 2; y < cy * cell.h + 24; y++) {
        for (let x = cx * cell.w + 2; x < cx * cell.w + cell.w - 8; x++) {
          const [r, g, b] = px(x, y);
          if (r + g + b < 120) dark++; else if (r + g + b > 600) bright++;
        }
      }
      expect(dark).toBeGreaterThan(500);
      expect(bright).toBeGreaterThan(20);
    }
    // the picture sits under the caption: the red page 4 in the first cell, the green page 5 in the second
    const [r1, g1] = px(190, 300); const [r2, g2] = px(190 + 384, 300);
    expect(r1).toBeGreaterThan(150); expect(g1).toBeLessThan(90);
    expect(g2).toBeGreaterThan(150); expect(r2).toBeLessThan(90);
  });

  it('refuses malformed input instead of guessing', async () => {
    const ok = await solid(1, 2, 3);
    await expect(rp.composeReferencePagesSheet([], '3:4')).rejects.toThrow(/no pages/);
    expect(() => rp.normaliseReferencePages([{ pageNumber: 0, imageData: ok }])).toThrow(/pageNumber/);
    expect(() => rp.normaliseReferencePages([{ pageNumber: 4 }])).toThrow(/imageData/);
    expect(() => rp.normaliseReferencePages([{ pageNumber: 4, imageData: ok }, { pageNumber: 4, imageData: ok }])).toThrow(/twice/);
    expect(rp.normaliseReferencePages(null)).toEqual([]);
    expect(rp.normaliseReferencePages([])).toEqual([]);
  });
});

describe('the REFERENCE PAGES prompt block', () => {
  it('is present, generic and names the pages only when pages are sent', () => {
    const base = 'PROMPT BODY';
    expect(rp.withReferencePages(base, [])).toBe(base);
    expect(rp.withReferencePages(base, null)).toBe(base);
    const out = rp.withReferencePages(base, [4, 5, 7]);
    expect(out.startsWith(base)).toBe(true);
    expect(out).toContain('**REFERENCE PAGES:**');
    expect(out).toContain('page 4, page 5, page 7');
    expect(out).toMatch(/exactly as it appears there \(shape, colour, texture, size\)/);
    expect(out).toMatch(/never paint a caption/);
  });
  it('rides through the ONE page-prompt closure, before a baked title', () => {
    const src = read('server/lib/pageRenderCall.js');
    expect(src).toContain('referencePageNumbers');
    expect(src).toMatch(/withBakedTitle\(withReferencePages\(buildImagePrompt\(/);
  });
});

describe('packReferences: the sheet is one extra slot, the cap fails loudly', () => {
  it('takes one slot on top of the packing and comes last', async () => {
    const sheet = `data:image/jpeg;base64,${(await sharp({ create: { width: 768, height: 1024, channels: 3, background: { r: 9, g: 9, b: 9 } } }).jpeg().toBuffer()).toString('base64')}`;
    const prev = await solid(10, 20, 30, 768, 1024);
    const out = await grok.packReferences({ previousImage: prev, referencePagesSheet: sheet }, { aspectRatio: '3:4' });
    expect(out).toHaveLength(2);
    expect(out[1]).toBe(sheet);
  });

  it('with no sheet the packing is unchanged', async () => {
    const prev = await solid(10, 20, 30, 768, 1024);
    expect(await grok.packReferences({ previousImage: prev }, { aspectRatio: '3:4' })).toHaveLength(1);
  });

  it('throws, naming the unsent slot, when xAI\'s hard cap is already reached', async () => {
    const sheet = await solid(9, 9, 9, 768, 1024);
    const plate = await solid(1, 1, 1, 768, 1024);
    const prev = await solid(2, 2, 2, 768, 1024);
    const chars = [1, 2, 3].map(i => ({ name: `C${i}`, photoUrl: `data:image/png;base64,${'x'}`, photoType: 'standard' }));
    const photo = (await sharp({ create: { width: 200, height: 300, channels: 3, background: { r: 80, g: 80, b: 80 } } }).png().toBuffer()).toString('base64');
    for (const c of chars) c.photoUrl = `data:image/png;base64,${photo}`;
    // plate + previous + 3 characters in own slots (maxSlots 5) = 5 = GROK_EDIT_MAX_REFS: no room left
    const call = grok.packReferences(
      { sceneBackground: plate, previousImage: prev, characterPhotos: chars, referencePagesSheet: sheet },
      { aspectRatio: '3:4', maxSlots: 5 });
    await expect(call).rejects.toThrow(/Not sent: the reference pages sheet/);
    await expect(call).rejects.toMatchObject({ name: 'ReferencePagesError', localFault: true });
    expect(grok.GROK_EDIT_MAX_REFS).toBe(5);
  });
});

describe('the sheet reaches every backend that can carry it, and refuses the one that cannot', () => {
  const images = read('server/lib/images.js');
  it('the dispatch hands it to both Grok packers and to the Gemini parts', () => {
    expect((images.match(/landmarkScene, referencePagesSheet \}/g) || []).length).toBe(2);
    expect(images).toContain('Added reference pages sheet');
  });
  it('Runware (character photos only) throws', () => {
    expect((images.match(/referencePages is not supported on the Runware backend/g) || []).length).toBe(2);
  });
  it('a local fault is never answered by another provider', () => {
    expect(images).toMatch(/err\?\.localFault !== true/);
  });
  it('generateImageOnly threads the option, iterate composes it and returns the page numbers', () => {
    expect(images).toMatch(/referencePagesSheet,\r?\n  \}\);/);
    expect(images).toContain('composeReferencePagesSheet(referencePages, sceneAspect)');
    expect(images).toMatch(/referencePageNumbers,\r?\n    method: 'iterate'/);
    expect(images).toMatch(/referencePages is not supported with iterativePlacement/);
  });
});

describe('Test Lab iterate stage', () => {
  const lab = read('server/lib/testlab.js');
  const stage = lab.slice(lab.indexOf('async function runIterateStage'), lab.indexOf('async function runRepairRoundStage'));
  it('loads each named page\'s ACTIVE picture from the same story and forwards it', () => {
    expect(stage).toContain('params.referencePages');
    expect(stage).toContain('loadActivePageImage(ctx.storyId, pageNumber)');
    expect(stage).toMatch(/referencePages \} : \{\}\)/);
    expect(stage).toContain('evaluationFeedback: params.feedback || null');
  });
  it('returns the reference page numbers on the stage result', () => {
    expect(stage).toContain('referencePages: result.referencePageNumbers || []');
  });
});
