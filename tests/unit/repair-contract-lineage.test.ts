/**
 * THE EVALUATION CONTRACT FOLLOWS THE LINEAGE (owner, 2026-09-16).
 *
 * "Iterate is supposed to be a 2nd art director. The first art director could
 * not be fulfilled, might have asked something impossible... So we do like a 2nd
 * art director, get a better composition. We now must evaluate against this new
 * composition. ANY REPAIR AS WELL. Unless iterate is worse and we scrap iterate
 * and work with original version."
 *
 * Measured damage on job_1789506283204_3kxqshifx: p16 v2 scored -205 and p13 v2
 * -12, both inpaints over an ITERATE output that were graded against the
 * ORIGINAL brief the iterate had superseded.
 *
 * Behaviour pinned here, never wording:
 *  - a repair over an iterate output inherits the ITERATE contract
 *  - a repair over the original inherits the ORIGINAL (declares nothing of its
 *    own, so every consumer falls back to the page record)
 *  - a version that authored its own contract keeps it
 *  - reverting to an original-lineage version restores the original brief on the
 *    page, and an iterate-lineage winner promotes the rewrite's own cast — [] included
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const nodeRequire = createRequire(import.meta.url);

const { inheritSceneContract, resolveDeclaredCast } = nodeRequire('../../server/lib/repairLogic.js');

const ORIGINAL_BRIEF = 'The original brief: the hero stands on the jetty at dawn.';
const ITERATE_BRIEF = 'The rewritten brief: the hero kneels beside the boat, one moment, one focal point.';

const originalVersion = () => ({
  source: 'original',
  description: null,
  sceneMetadata: null,
  sceneCharacters: null,
});

const iterateVersion = () => ({
  source: 'iterate-round-1',
  description: ITERATE_BRIEF,
  sceneMetadata: { setting: 'jetty', objects: ['ART001.2'] },
  sceneCharacters: [{ name: 'Hero' }, { name: 'Ferryman' }],
});

describe('a repair inherits the contract of the version it edited', () => {
  it('an inpaint over an ITERATE output is judged against the iterate brief', () => {
    const inpaint: any = { pageNumber: 16, source: 'inpaint-round-2', imageData: 'x' };
    inheritSceneContract(inpaint, iterateVersion());
    expect(inpaint.description).toBe(ITERATE_BRIEF);
    expect(inpaint.sceneMetadata).toEqual({ setting: 'jetty', objects: ['ART001.2'] });
    expect(inpaint.sceneCharacters).toEqual([{ name: 'Hero' }, { name: 'Ferryman' }]);
    expect(inpaint.parentSource).toBe('iterate-round-1');
  });

  it('a char-fix over the ORIGINAL declares nothing, so the page record stands', () => {
    const charFix: any = { pageNumber: 13, source: 'char-fix-1', imageData: 'x' };
    inheritSceneContract(charFix, originalVersion());
    expect(charFix.description).toBeNull();
    expect(charFix.sceneMetadata).toBeNull();
    expect(charFix.sceneCharacters).toBeNull();
    // What the eval resolver then does with it: falls back to the original.
    expect(charFix.description || ORIGINAL_BRIEF).toBe(ORIGINAL_BRIEF);
  });

  it('a version that authored its OWN contract keeps it', () => {
    const iter: any = { source: 'iterate-round-2', description: 'a third composition', sceneCharacters: [] };
    inheritSceneContract(iter, iterateVersion());
    expect(iter.description).toBe('a third composition');
    // An EMPTY cast is a declaration, not an absence.
    expect(iter.sceneCharacters).toEqual([]);
  });

  it('inheritance chains: iterate -> inpaint -> char-fix all carry one brief', () => {
    const inpaint: any = { source: 'inpaint-round-1' };
    inheritSceneContract(inpaint, iterateVersion());
    const charFix: any = { source: 'char-fix-2' };
    inheritSceneContract(charFix, inpaint);
    expect(charFix.description).toBe(ITERATE_BRIEF);
  });

  it('no parent (the very first version) changes nothing', () => {
    const v: any = { source: 'original' };
    inheritSceneContract(v, null);
    expect(v.description).toBeUndefined();
  });
});

describe('reverting to the original version reverts the contract with it', () => {
  // The promotion the pipeline performs: best?.description || img.sceneDescription
  const promote = (best: any, img: any) => ({
    sceneDescription: best?.description || img.sceneDescription,
    sceneMetadata: best?.sceneMetadata || img.sceneMetadata,
    sceneCharacters: resolveDeclaredCast(best?.sceneCharacters, img.sceneCharacters),
  });
  const page = { sceneDescription: ORIGINAL_BRIEF, sceneMetadata: { setting: 'jetty-original' }, sceneCharacters: [{ name: 'Hero' }] };

  it('an ORIGINAL-lineage winner puts the ORIGINAL brief back on the page', () => {
    const originalInpaint: any = {};
    inheritSceneContract(originalInpaint, originalVersion());
    expect(promote(originalInpaint, page).sceneDescription).toBe(ORIGINAL_BRIEF);
    expect(promote(originalInpaint, page).sceneMetadata).toEqual({ setting: 'jetty-original' });
  });

  it('an ITERATE-lineage winner puts the REWRITE on the page', () => {
    const iterateInpaint: any = {};
    inheritSceneContract(iterateInpaint, iterateVersion());
    expect(promote(iterateInpaint, page).sceneDescription).toBe(ITERATE_BRIEF);
  });

  it('a winner that emptied its cast promotes the empty cast, not the page roster', () => {
    const emptied: any = { sceneCharacters: [] };
    inheritSceneContract(emptied, iterateVersion());
    expect(promote(emptied, page).sceneCharacters).toEqual([]);
  });

  it('a winner with no cast declaration promotes the page roster', () => {
    const none: any = {};
    inheritSceneContract(none, originalVersion());
    expect(promote(none, page).sceneCharacters).toEqual([{ name: 'Hero' }]);
  });
});
