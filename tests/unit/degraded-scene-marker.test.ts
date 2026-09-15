import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fs = require('node:fs');
const {
  extractSceneMetadata,
  describeDegradedSceneMetadata,
} = require('../../server/lib/sceneMetadata.js');

const pipelineSrc: string = fs.readFileSync(
  new URL('../../storyJobPipeline.js', import.meta.url), 'utf8');

// Shaped like the real prose-only failure: the ---METADATA--- delimiter is
// there (we intended structured metadata) but the tail is unparseable JSON.
// This is what produced page 16 of job_1789420511893_zly5rcdej (score -40).
const BROKEN_SCENE = [
  'A girl in a red blouse and sash runs across the market square, a feathered hat',
  'still spinning in her outstretched hands. Stalls crowd the edges of the frame.',
  '',
  '---METADATA---',
  '{"characters": [{"name": "the main character", ',
].join('\n');

describe('a page that ships on prose alone is marked, not just logged', () => {
  it('the recovery path sets isRecovered (and NOT isJsonFormat=false — the trap)', () => {
    const meta = extractSceneMetadata(BROKEN_SCENE);
    expect(meta).toBeTruthy();
    expect(meta.isRecovered).toBe(true);
    // The trap named in sceneMetadata.js: hunting for isJsonFormat === false
    // finds nothing, because the degraded object sets it TRUE.
    expect(meta.isJsonFormat).toBe(true);
    expect(meta.characters).toEqual([]);
    expect(meta.objects).toEqual([]);
    expect(meta.clothing).toBeNull();
    expect(meta.textPosition).toBeNull();
  });

  it('describeDegradedSceneMetadata names the inputs that are now empty', () => {
    const marker = describeDegradedSceneMetadata(extractSceneMetadata(BROKEN_SCENE));
    expect(marker).toBeTruthy();
    expect(marker.recovered).toBe(true);
    expect(marker.emptyInputs).toEqual(expect.arrayContaining([
      'characters', 'clothing', 'objects', 'interactions', 'textPosition',
    ]));
  });

  it('a normally parsed brief is NOT marked', () => {
    const good = [
      'Two figures on a wooden pier at dusk.',
      '',
      '---METADATA---',
      JSON.stringify({
        characters: [{ name: 'the main character' }],
        clothing: 'red blouse and sash',
        objects: [{ id: 'OBJ001', name: 'a hat' }],
      }),
    ].join('\n');
    const meta = extractSceneMetadata(good);
    expect(meta).toBeTruthy();
    expect(meta.isRecovered).toBeUndefined();
    expect(describeDegradedSceneMetadata(meta)).toBeNull();
    expect(describeDegradedSceneMetadata(null)).toBeNull();
  });

  // The whitelist in storyJobPipeline.js is the single gate on what reaches
  // stories.data.sceneImages — a field the mapping omits is dropped silently.
  // BOTH branches must carry it: the repair-pipeline branch and the
  // skipQualityEval (trial/lightweight) branch.
  it('the marker survives BOTH sceneImages whitelists', () => {
    const occurrences = pipelineSrc.split(
      'degradedScene: describeDegradedSceneMetadata(img.sceneMetadata)').length - 1;
    expect(occurrences).toBe(2);
    expect(pipelineSrc).toContain('  describeDegradedSceneMetadata,\n');
  });

  it('the marker is plain JSONB-safe data (survives the stories.data round-trip)', () => {
    const marker = describeDegradedSceneMetadata(extractSceneMetadata(BROKEN_SCENE));
    const stored = JSON.parse(JSON.stringify({ pageNumber: 16, degradedScene: marker }));
    expect(stored.degradedScene).toEqual(marker);
  });

  // Runs the ACTUAL rollup statement out of storyJobPipeline.js, so the report
  // logic is exercised rather than restated.
  it('the end-of-story report names the degraded page', () => {
    const m = pipelineSrc.match(
      /const degradedScenePages = \(allImages \|\| \[\][\s\S]*?\}\)\);/);
    expect(m).toBeTruthy();
    const rollup = new Function('allImages', `${m![0]} return degradedScenePages;`);
    const pages = rollup([
      { pageNumber: 15, degradedScene: null },
      { pageNumber: 16, degradedScene: describeDegradedSceneMetadata(extractSceneMetadata(BROKEN_SCENE)) },
    ]);
    expect(pages).toHaveLength(1);
    expect(pages[0].pageNumber).toBe(16);
    expect(pages[0].emptyInputs).toContain('clothing');
    expect(pipelineSrc).toContain('finalChecksReport.degradedScenes = degradedScenePages;');
  });

  it('the fallback log line states the consequences and names no stale model', () => {
    const src = fs.readFileSync(
      new URL('../../server/lib/sceneMetadata.js', import.meta.url), 'utf8');
    expect(src).toContain('DEGRADED PAGE — rendering on prose alone');
    expect(src).not.toContain('Sonnet emitted malformed metadata');
  });
});
