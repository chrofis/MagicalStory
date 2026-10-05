/**
 * Every route that renders a page builds its prompt through
 * pageRenderCall.makePageImagePrompt (code review 2026-10-04 S1/S2). The
 * user-facing page regenerate called bare buildImagePrompt: it sent the Visual
 * Bible prose Grok pages deliberately drop, claimed no reference for the grid it
 * attached, and built a different grid (6 cells, landmarks included) from the
 * story run's. The trial streaming path hand-built the same options.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const pageRender = require_('../../server/lib/pageRenderCall.js');

const src = (p: string) => readFileSync(p, 'utf8');
const callsBare = (code: string) => /(^|[^.\w])buildImagePrompt\s*\(/.test(code.replace(/\/\/.*$/gm, ''));

describe('page prompt routes', () => {
  it('regeneration.js and the story pipeline do not call buildImagePrompt directly', () => {
    expect(callsBare(src('server/routes/regeneration.js'))).toBe(false);
    expect(callsBare(src('storyJobPipeline.js'))).toBe(false);
  });
  it('regeneration.js builds its page grid through buildPageVbGrid, never with landmarks in it', () => {
    const code = src('server/routes/regeneration.js');
    expect(code).toContain('buildPageVbGrid');
    expect(code).not.toMatch(/buildVisualBibleGrid\(\s*\w+,\s*\w+\s*\)/);
  });
  it('buildPageVbGrid with no visual bible yields no cells and no grid', async () => {
    const out = await pageRender.buildPageVbGrid({ visualBible: null, pageNumber: 1, sceneMetadata: null, hasPlate: true });
    expect(out).toEqual({ kept: [], visualBibleGrid: null });
  });
});
