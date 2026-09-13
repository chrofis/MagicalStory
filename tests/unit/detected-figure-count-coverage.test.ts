import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Under the presence arithmetic, `detectedFigureCount` stops being a prompt
 * hint and becomes load-bearing: without it the EXPECTED CAST block carries a
 * roster and no count, and the derivation has nothing to compare.
 *
 * It used to reach buildExpectedCastBlock at exactly ONE of ~20
 * evaluateImageQuality call sites. The obstacle was never availability — the
 * pattern is eval-then-detect on the same bytes in the same block — it was
 * ordering. These pin the reordering and the feeds, per site.
 */
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

const order = (src: string, from: string, a: string, b: string) => {
  const base = src.indexOf(from);
  expect(base, `anchor not found: ${from}`).toBeGreaterThan(-1);
  const ia = src.indexOf(a, base);
  const ib = src.indexOf(b, base);
  expect(ia, `missing: ${a}`).toBeGreaterThan(-1);
  expect(ib, `missing: ${b}`).toBeGreaterThan(-1);
  return ia < ib;
};

describe('the eval is given a figure count wherever a detection exists', () => {
  it('images.js batch eval prefers the pre-computed shared detection', () => {
    const src = read('server/lib/images.js');
    expect(src).toMatch(/detectedFigures: img\.sharedBboxDetection\?\.figures \|\| img\.bboxDetection\?\.figures \|\| null/);
  });

  it('iteratePageCore detects BEFORE it evaluates', () => {
    const src = read('server/lib/images.js');
    expect(order(src, 'let iterDetection = null;', 'iterDetection = await detectAllBoundingBoxes(', 'iterQuality = await evaluateImageQuality(')).toBe(true);
    expect(src).toMatch(/detectedFigures: iterDetection\?\.figures \|\| null/);
  });

  it('the iterate eval also gets the rewritten page metadata', () => {
    // Without it the iterate roster silently loses every figure the brief
    // filed in objects[] — a VB secondary, an animal.
    expect(read('server/lib/images.js')).toMatch(/sceneMetadata: iterateSceneMetadata \|\| null/);
  });

  it('the cover direct path detects before it evaluates', () => {
    const src = read('server/lib/coverIterate.js');
    expect(order(src, 'let coverBboxDetection = null;', 'coverBboxDetection = await detectAllBoundingBoxes(', 'const qualityResult = await evaluateImageQuality(')).toBe(true);
    expect(src).toMatch(/detectedFigures: coverBboxDetection\?\.figures \|\| null/);
  });

  it('the composite cover path detects before it evaluates', () => {
    const src = read('server/lib/coverIterate.js');
    expect(order(src, 'if (imageResult.composite) {', 'compBbox = await detectAllBoundingBoxes(', 'const qualityResult = await evaluateImageQuality(')).toBe(true);
    expect(src).toMatch(/detectedFigures: compBbox\?\.figures \|\| null/);
  });

  it('the page regeneration route detects before it evaluates', () => {
    const src = read('server/routes/regeneration.js');
    expect(order(src, 'let regenDetection = null;', 'regenDetection = await detectAllBoundingBoxes(', 'regenQuality = await evaluateImageQuality(')).toBe(true);
    expect(src).toMatch(/detectedFigures: regenDetection\?\.figures \|\| null/);
  });

  it('the stored-image endpoints reuse the stored detection, no new call', () => {
    const src = read('server/routes/regeneration.js');
    const feeds = src.match(/detectedFigures: scene\.bboxDetection\?\.figures \|\| null/g) || [];
    expect(feeds.length).toBe(2);
  });

  it('every Test Lab eval stage states a figure count, explicitly null where there is none', () => {
    const src = read('server/lib/testlab.js');
    const evals = (src.match(/await evaluateImageQuality\(/g) || []).length;
    const feeds = (src.match(/detectedFigures:/g) || []).length;
    expect(evals).toBeGreaterThan(0);
    expect(feeds).toBe(evals);
  });

  it('a pinned Test Lab version never borrows the active version\'s count', () => {
    // The stored detection describes the ACTIVE image; a pinned target is a
    // different picture, and a count from the wrong picture is worse than none.
    const src = read('server/lib/testlab.js');
    expect(src).toMatch(/\(ctx\.versionIndex \?\? null\) === null\s*\n\s*\? \(ctx\.scene\.bboxDetection\?\.figures \|\| null\) : null/);
    expect(src).toMatch(/versionIndex === null\s*\n\s*\? \(ctx\.scene\.bboxDetection\?\.figures \|\| null\) : null/);
  });
});

describe('the count passed in is filtered before it reaches the roster', () => {
  it('evalPipeline filters a figures array it is handed', () => {
    const src = read('server/lib/evalPipeline.js');
    expect(src).toMatch(/Array\.isArray\(evalOptions\.detectedFigures\)\s*\n\s*\? require\('\.\/bboxDetection'\)\.countRealFigures\(evalOptions\.detectedFigures\)/);
  });

  it('a bare detectedFigureCount is still accepted from callers that have only a number', () => {
    expect(read('server/lib/evalPipeline.js')).toMatch(/\(evalOptions\.detectedFigureCount \?\? null\)/);
  });
});
