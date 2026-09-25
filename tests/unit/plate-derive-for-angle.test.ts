import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const {
  plateClass,
  PLATE_BASE_CLASS,
  PLATE_DERIVED_SHOTS,
  buildPlateDeriveInstruction,
  SHOT_TYPES,
  SHOTS,
} = require('../../server/lib/shotVocabulary');

// Owner, 2026-09-21: "we should redo the plate if it is off a lot. A medium and
// wide might still work, as well as an over-the-shoulder. But a medium plate for
// a high-angle or for an ultra-wide is bound to fail." And on how:
// "use the plate as an input and say this is a medium shot, prepare it for a
// different angle so that the structure stays the same."
//
// The line is NOT the distance/position axis — over-the-shoulder is a POSITION
// and shares fine, because the shoulder is a figure and a plate is
// background-only. What cannot share is a shot that moves the HORIZON
// (high/low-angle, aerial) or grows the COVERAGE (ultra-wide).
//
// Measured over the 10 staging stories carrying vantages, 157 pages: 5 pages
// (3.2%) draw on a plate built for a camera that cannot hold them; honouring
// this costs 3 extra plates on 39 (+7.7%).
//
// These pin the classification and the derive contract, never the wording of
// the instruction.

const SRC = (rel: string) =>
  fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8').split('\r\n').join('\n');

describe('which shots may share a backdrop plate', () => {
  it('shares the base plate for the three eye-level distances', () => {
    for (const id of ['close-up', 'medium', 'wide']) expect(plateClass(id)).toBe(PLATE_BASE_CLASS);
  });

  it('shares the base plate for over-the-shoulder — the owner ruled it works', () => {
    expect(plateClass('over-the-shoulder')).toBe(PLATE_BASE_CLASS);
    expect(PLATE_DERIVED_SHOTS.has('over-the-shoulder')).toBe(false);
  });

  it('derives its own plate for every shot that moves the horizon or grows the coverage', () => {
    for (const id of ['high-angle', 'low-angle', 'aerial', 'ultra-wide']) {
      expect(plateClass(id), id).toBe(id);
      expect(PLATE_DERIVED_SHOTS.has(id), id).toBe(true);
    }
  });

  it('is not the distance/position axis', () => {
    // over-the-shoulder is a position that shares; ultra-wide a distance that
    // does not. Anyone re-deriving this from `axis` would get both wrong.
    const { SHOT_AXIS } = require('../../server/lib/shotVocabulary');
    expect(SHOT_AXIS['over-the-shoulder']).toBe('position');
    expect(plateClass('over-the-shoulder')).toBe(PLATE_BASE_CLASS);
    expect(SHOT_AXIS['ultra-wide']).toBe('distance');
    expect(plateClass('ultra-wide')).toBe('ultra-wide');
  });

  it('treats an unknown, absent or malformed shot as plate-sharing', () => {
    for (const junk of ['', null, undefined, 'sideways', 0, {}]) {
      expect(plateClass(junk as never)).toBe(PLATE_BASE_CLASS);
    }
  });

  it('names only shots that exist', () => {
    for (const id of PLATE_DERIVED_SHOTS) expect(SHOT_TYPES).toContain(id);
  });

  it('classifies every known shot as exactly one of the two', () => {
    for (const id of SHOT_TYPES) {
      const c = plateClass(id);
      expect(c === PLATE_BASE_CLASS || c === id, id).toBe(true);
    }
  });
});

describe('the derived plate is edited from the base, not generated fresh', () => {
  // 2026-09-25 (staging job_1790277448294_5herh01j7 p10): the shot
  // definitions speak of figures and subjects, and a SIZE for the current
  // picture ("shrinks to fill only the middle third") framed the old sheet,
  // mat included, as a picture-in-a-picture. Every derived shot has its own
  // camera move, and none sizes the current picture.
  it('gives every derived shot its own camera move, distinct from the others', () => {
    const moves = [...PLATE_DERIVED_SHOTS].map(id => buildPlateDeriveInstruction('medium', id));
    expect(new Set(moves).size).toBe(PLATE_DERIVED_SHOTS.size);
    for (const id of PLATE_DERIVED_SHOTS) {
      const target = SHOTS.find((s: { id: string }) => s.id === id);
      expect(buildPlateDeriveInstruction('medium', id), id).not.toContain(target.definition);
    }
  });

  it('never gives the current picture a size in the new frame', () => {
    for (const id of PLATE_DERIVED_SHOTS) {
      expect(buildPlateDeriveInstruction('medium', id), id).not.toMatch(/\b(?:third|half|quarter|shrinks?)\b/i);
    }
  });

  it('names the base shot it is coming from', () => {
    expect(buildPlateDeriveInstruction('medium', 'aerial')).toMatch(/medium shot/);
  });

  it('still works when the base plate has no shot of its own', () => {
    const instruction = buildPlateDeriveInstruction('', 'ultra-wide');
    expect(instruction).toMatch(/eye level/i);
  });

  it('states what must STAY, positively — a negation renders as nothing', () => {
    const instruction = buildPlateDeriveInstruction('medium', 'high-angle');
    for (const kept of ['shape', 'arrangement', 'colour', 'palette', 'season', 'light']) {
      expect(instruction, kept).toContain(kept);
    }
    expect(instruction).not.toMatch(/\b(?:do not|don't|never|without changing)\b/i);
  });

  it('never pins an object\'s position: in an edit that pins the camera it asks to move', () => {
    for (const shot of ['ultra-wide', 'high-angle', 'low-angle', 'aerial']) {
      expect(buildPlateDeriveInstruction('medium', shot), shot).not.toMatch(/\bposition\b/i);
    }
  });

  it('returns null for a shot it does not know', () => {
    expect(buildPlateDeriveInstruction('medium', 'sideways')).toBeNull();
  });
});

describe('the pipeline honours it', () => {
  const src = SRC('storyJobPipeline.js');

  it('picks a plate-sharing page as the vantage representative', () => {
    // Taking pageNumbers[0] blindly could paint the base from a high-angle page
    // and hand that horizon to the whole vantage.
    // Among the plate-sharing pages it prefers one in the vantage's common
    // declared light (sceneLight.js, 2026-09-24), so the fewest pages need a relit plate.
    expect(src).toContain('const basePages = group.pageNumbers.filter(pn => plateClass(shotOfPage(pn)) === PLATE_BASE_CLASS);');
    expect(src).toContain('basePages.find(pn => lightKey(lightOfPage(pn)) === commonLightKey)');
  });

  it('derives from the base plate image, not from a fresh generation', () => {
    expect(src).toMatch(/editImageWithPrompt\(\s*\n?\s*plateImage, instruction/);
  });

  // Dragon run 6 (2026-09-23): the derive went out with no art style and its
  // result was never judged; the base plate's retry was judged on pixels only.
  it('the derive carries the book art style', () => {
    expect(src).toMatch(/plateImage, instruction, MODEL_DEFAULTS\.emptyScenePlateModel, \[\], inputData\.artStyle/);
  });
  it('the derive is sent with the plate-derive template, not illustration-edit', () => {
    expect(src).toMatch(/plateImage, instruction, MODEL_DEFAULTS\.emptyScenePlateModel, \[\], inputData\.artStyle \|\| null, layoutAspect, \{ plateDerive: true \}\)/);
    expect(SRC('server/lib/testlab.js')).toMatch(/MODEL_DEFAULTS\.emptyScenePlateModel, \[\], ctx\.artStyle, null, \{ plateDerive: true \}\)/);
  });
  it('a derived plate is QC-judged at its own camera', () => {
    expect(src).toMatch(/validateEmptyScene\(derivedImage, null, `vantage-\$\{vantageId\}-\$\{cls\}`, derivedQcOpts\)/);
    expect(src).toMatch(/shot: cls,/);
  });
  it('no plate retry is judged on pixels only', () => {
    expect(src).not.toMatch(/validateEmptyScene\([^)]*skipVision: true/);
  });

  it('falls back to the base plate when the derive fails', () => {
    // Owner's call: the wrong camera on the right place beats no plate at all.
    expect(src).toContain('derivedForPage ? derivedForPage.imageData : plateImage');
    expect(src).toMatch(/keeps? the base plate/);
  });

  it('records which pages got a derived plate', () => {
    expect(src).toContain('plateDerivedFor');
  });

  // Run 6 (job_1790100385959_1nitlympp): p2 got a derived ultra-wide plate, but
  // the stored page carried no plateDerivedFor and listed the base plate's own
  // generation refs, so the derive could not be seen after the run.
  it('persists plateDerivedFor through every page whitelist', () => {
    expect(src.match(/plateDerivedFor: img\.plateDerivedFor \|\| sceneBackgrounds\[img\.pageNumber\]\?\.plateDerivedFor/g)).toHaveLength(2);
    expect(src).toContain('plateDerivedFor: emptySceneData?.plateDerivedFor');
    expect(src).toContain('plateDerivedFor: sceneBackgrounds[pageData.pageNumber]?.plateDerivedFor');
  });

  it('a derived plate records the base plate as its one reference', () => {
    expect(src).toContain('grokRefImages: derivedForPage ? [plateImage] : plateRefs');
  });

  it('reads a derived plate\'s population on its own, not as its base plate', () => {
    expect(src).toMatch(/bg\.plateDerivedFor \? `:\$\{bg\.plateDerivedFor\}`/);
  });
});
