/**
 * Every plate call site sends the book's FULL art style (owner, 2026-09-25).
 *
 * The story-run plates (vantage, per-page, trial) always sent resolveArtStyle.
 * The Test Lab empty_scene stage, the cover plate (coverIterate) and the
 * iterate plate (images.js renderStoryPagePlate) sent a stripped
 * "empty-scene" variant that collapsed pixar to "Never photographic." and
 * dropped the word "watercolor" — so the Lab tested a prompt production never
 * sends. The stripped variant is deleted.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const SRC = (rel: string) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');

describe('plate art style', () => {
  it('the stripped empty-scene style resolver is gone', () => {
    const pb = require_('../../server/lib/promptBuilders');
    expect(pb.resolveArtStyleForEmptyScene).toBeUndefined();
    for (const f of ['server/lib/testlab.js', 'server/lib/coverIterate.js', 'server/lib/images.js', 'storyJobPipeline.js']) {
      expect(SRC(f), f).not.toContain('resolveArtStyleForEmptyScene');
    }
  });

  it('the Lab plate stage resolves the style the way production does', () => {
    expect(SRC('server/lib/testlab.js')).toContain("const plateStyle = resolveArtStyle(params.artStyleOverride || ctx.artStyle || 'pixar') || '';");
    expect(SRC('storyJobPipeline.js')).toContain("const artStyleDesc = resolveArtStyle(inputData.artStyle || 'pixar', repPageData.pageImageBackend) || '';");
  });

  it('the Lab plate text is plate text: resolvePagePlate, never the stored built prompt or the scene description', () => {
    const src = SRC('server/lib/testlab.js');
    expect(src).toContain("pageNumber: ctx.pageNumber, sceneMetadata: meta, visualBible: ctx.visualBible, outlinePlate: '',");
    expect(src).not.toContain('meta.emptyScenePrompt || ctx.scene.emptyScenePrompt || ctx.scene.sceneDescription');
  });

  it('the cover and iterate plates send the full style', () => {
    expect(SRC('server/lib/coverIterate.js')).toContain("const artStyleDesc = resolveArtStyle(artStyle || 'pixar') || '';");
    expect(SRC('server/lib/images.js')).toContain("const artStyleDesc = resolveArtStyle(storyData.artStyle || 'pixar') || '';");
  });

  it('the full style keeps the medium the stripped one lost', () => {
    const { resolveArtStyle } = require_('../../server/lib/promptBuilders');
    expect(resolveArtStyle('watercolor')).toMatch(/watercolor/i);
    expect(resolveArtStyle('pixar')).toMatch(/3D animated/);
  });
});
