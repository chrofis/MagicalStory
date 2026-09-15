import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * An iterate repair REWRITES the brief, and the rewrite is a new contract:
 * its cast can legitimately differ from the plan it supersedes. iteratePageCore
 * already re-derives that cast (`newSceneCharacters`) and the repair action
 * already returns it; final assembly already promotes `best.sceneCharacters` to
 * the page. The one object in the middle — the version the round loop builds —
 * dropped both fields, so the rewrite's DESCRIPTION reached the page and its
 * CAST did not.
 *
 * Measured on job_1789207854566_l43qgl34w p15: the rewrite named six people,
 * the page record kept `[Fiona]`, and the final image was judged against a
 * roster of 2 with 6 figures drawn — an `extra_character` CRITICAL for its own
 * commissioned cast. Every stored version on that job reads sceneCharacters:null.
 */
const SRC = fs.readFileSync(path.join(process.cwd(), 'server/lib/repairPipeline.js'), 'utf8');

describe('the rewritten scene contract travels with the version', () => {
  it('the round version carries the repair result cast', () => {
    expect(SRC).toMatch(/sceneCharacters: Array\.isArray\(repairResult\.sceneCharacters\) \? repairResult\.sceneCharacters : null/);
  });

  it('the round version carries the repair result metadata', () => {
    expect(SRC).toMatch(/sceneMetadata: repairResult\.sceneMetadata \|\| null/);
  });

  it('the cast is declared-or-unknown, never coalesced by truthiness', () => {
    // `repairResult.sceneCharacters || null` would swallow a rewrite that
    // legitimately empties the cast — `[]` is truthy in JS, so it survives
    // `||`, but any later `|| page.sceneCharacters` would then discard it.
    expect(SRC).not.toMatch(/sceneCharacters: repairResult\.sceneCharacters \|\| null/);
  });

  it('the iterate action still returns both fields into that object', () => {
    expect(SRC).toMatch(/sceneMetadata: result\.newSceneMetadata \|\| null/);
    expect(SRC).toMatch(/sceneCharacters: result\.newSceneCharacters \|\| null/);
  });

  it('final assembly still promotes the picked version contract to the page', () => {
    expect(SRC).toMatch(/sceneCharacters: best\?\.sceneCharacters \|\| img\.sceneCharacters/);
    expect(SRC).toMatch(/sceneMetadata: best\?\.sceneMetadata \|\| img\.sceneMetadata/);
  });
});

describe('iteratePageCore re-derives and returns the rewritten cast', () => {
  const IMG = fs.readFileSync(path.join(process.cwd(), 'server/lib/images.js'), 'utf8');

  it('derives the cast from the REWRITTEN brief, not the original', () => {
    expect(IMG).toMatch(/getCharactersInScene\(newSceneDescription, characters\)/);
  });

  it('returns it under the contract name the pipeline reads', () => {
    expect(IMG).toMatch(/newSceneCharacters: sceneCharacters/);
  });
});
