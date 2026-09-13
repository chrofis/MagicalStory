import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveEvalSceneHint } = require('../../server/lib/sceneMetadata.js');

// BEHAVIOUR PINNED: the semantic evaluator judges a page image against THE SAME
// SPEC THE GENERATOR RECEIVED — the reviewed Art Director brief
// (`scene.sceneDescription`, which buildImagePrompt consumes at
// storyJobPipeline.js:4027) — never the upstream plan line.
//
// The Art Director deliberately trims cast and simplifies action to keep an
// image readable (by design, owner-confirmed). image-semantic.txt calls
// SCENE_HINT "the authoritative source", so a plan line there scores every
// deliberate trim as a full-severity semantic defect on a correct page.
//
// This regressed once already: c0928a079 (2026-08-31) fixed it on the premise
// "pages never set outlineExtract"; 824fb02d9 (2026-09-02) then stored
// `outlineExtract: "PLAN: <planLine>"` on every beats page, which won the
// inline `||` chain. Measured on staging 2026-09-13: every page of every beats
// story. Assert the RULE, not any prompt wording.

const PLAN = 'PLAN: wide — Fiona and the whole family run through rain toward the museum door';
const BRIEF = 'Inside the dim exhibition hall, Fiona — an adult woman with neck-length straight hair — lifts the rolled chart.\n---METADATA---\n{"characters":["Fiona"]}';

describe('resolveEvalSceneHint — evaluator spec == generator spec', () => {
  it('a beats page is judged against the reviewed AD brief, not the PLAN line', () => {
    const generatorSpec = BRIEF; // what buildImagePrompt() is handed
    const evaluatorSpec = resolveEvalSceneHint({
      evaluationType: 'scene',
      sceneDescription: BRIEF,
      outlineExtract: PLAN,
      sceneHint: 'Fiona and the family run through the rain',
    });
    expect(evaluatorSpec).toBe(generatorSpec);
  });

  it('a PLAN line is never used for a page, even with no brief at all', () => {
    const hint = resolveEvalSceneHint({
      evaluationType: 'scene',
      sceneDescription: null,
      outlineExtract: PLAN,
      sceneHint: null,
    });
    expect(hint).toBeNull();
  });

  it('an iterate rewrite of the brief wins over the page brief', () => {
    const rewritten = 'Rewritten brief: Fiona alone at the skirting board.';
    expect(resolveEvalSceneHint({
      evaluationType: 'scene',
      entryDescription: rewritten,
      sceneDescription: BRIEF,
      outlineExtract: PLAN,
    })).toBe(rewritten);
  });

  it('a cover still takes its outlineExtract — that IS the brief it was generated from', () => {
    const coverBrief = 'Front cover: the five characters on the museum steps under a red umbrella.';
    expect(resolveEvalSceneHint({
      evaluationType: 'cover',
      outlineExtract: coverBrief,
      sceneDescription: 'unused',
    })).toBe(coverBrief);
  });

  it('blank-ish values do not count as a spec', () => {
    expect(resolveEvalSceneHint({
      evaluationType: 'scene',
      sceneDescription: '   ',
      outlineExtract: PLAN,
      sceneHint: BRIEF,
    })).toBe(BRIEF);
    expect(resolveEvalSceneHint({})).toBeNull();
  });
});

describe('the two eval call sites pass the generator spec, not the plan line', () => {
  // Shape-level guard on the wiring itself: neither repairPipeline's eval
  // inputs nor regeneration's eval routes may rebuild the old inline chain
  // that put `outlineExtract` ahead of the brief for a page.
  const fs = require('node:fs');
  const files = [
    '../../server/lib/repairPipeline.js',
    '../../server/routes/regeneration.js',
  ];
  for (const f of files) {
    it(`${f.split('/').pop()} resolves sceneHint through the shared resolver`, () => {
      const src = fs.readFileSync(new URL(f, import.meta.url), 'utf8');
      expect(src).toContain('resolveEvalSceneHint');
      // The exact regressed expression: outlineExtract first, unconditionally.
      expect(src).not.toMatch(/sceneHint:\s*\w+\.scene\?\.outlineExtract\s*\|\|/);
    });
  }
});
