import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { revertReviewCastRegressions } = require('../../server/lib/beatsPipeline.js');
const { extractSceneMetadata } = require('../../server/lib/sceneMetadata.js');

// Measured origin: staging job_1789207854566_l43qgl34w. Five staging stories,
// 83 pages: 4 pages lost declared cast across the scene review. Two were the
// review correctly moving a secondary out of `characters[]` (p13, p16); one was
// the review un-declaring the whole cast while its prose still named a sixth
// person (p7); one removed cast AND de-named them in the prose, leaving a
// self-consistent brief (p15). The backstop must fire on p7 only.

const brief = (prose: string, meta: Record<string, unknown>) =>
  `${prose}\n---METADATA---\n${JSON.stringify(meta)}\n`;

// p7 shape: the Art Director declared the cast; the rewrite emptied
// `characters[]` while the prose still names a secondary.
const AD_P7 = brief('The main character and four companions stand at the rim facing the secondary character.', {
  characters: [{ name: 'Lead' }, { name: 'Second' }],
  objects: ['CHR001'],
});
const REWRITE_P7 = brief('The secondary character stands at the rim facing five figures.', {
  characters: [],
  objects: ['CHR001'],
});

// p13 shape: the rewrite moved the secondary from `characters[]` to `objects[]`,
// which is what the field rules ask for. No fault is left behind.
const AD_P13 = brief('The main character faces the secondary character.', {
  characters: [{ name: 'Lead' }, { name: 'CHR001' }],
  objects: [],
});
const REWRITE_P13 = brief('The main character faces the secondary character.', {
  characters: [{ name: 'Lead' }],
  objects: ['CHR001'],
});

const mkPages = () => [
  { pageNumber: 7, brief: REWRITE_P7, reviewRewrote: true },
  { pageNumber: 13, brief: REWRITE_P13, reviewRewrote: true },
];
const mkIn = () => [
  { pageNumber: 7, brief: AD_P7 },
  { pageNumber: 13, brief: AD_P13 },
];

describe('revertReviewCastRegressions — a rewrite may not un-declare cast its own prose names', () => {
  it('reverts a page whose rewrite INTRODUCED cast_unlisted, restoring the Art Director brief', () => {
    const expansions = mkPages();
    const reverted = revertReviewCastRegressions({
      expansions,
      briefsIn: mkIn(),
      introduced: [{ pageNumber: 7, type: 'cast_unlisted' }],
    });
    expect(reverted).toEqual([7]);
    expect(expansions[0].brief).toBe(AD_P7);
    expect(expansions[0].reviewRewrote).toBe(false);
    expect((expansions[0] as any).reviewRejected).toBe('cast_unlisted');
  });

  it('keeps the rewrite on a page with no introduced cast_unlisted (the secondary-routing removal)', () => {
    const expansions = mkPages();
    const reverted = revertReviewCastRegressions({
      expansions,
      briefsIn: mkIn(),
      introduced: [{ pageNumber: 7, type: 'cast_unlisted' }],
    });
    expect(reverted).not.toContain(13);
    expect(expansions[1].brief).toBe(REWRITE_P13);
    expect(expansions[1].reviewRewrote).toBe(true);
    expect((expansions[1] as any).reviewRejected).toBeUndefined();
  });

  it('reverts nothing when the review introduced no faults at all', () => {
    const expansions = mkPages();
    expect(revertReviewCastRegressions({ expansions, briefsIn: mkIn(), introduced: [] })).toEqual([]);
    expect(expansions[0].brief).toBe(REWRITE_P7);
    expect(expansions[1].brief).toBe(REWRITE_P13);
  });

  it('ignores introduced faults of every other type — only cast_unlisted withdraws a rewrite', () => {
    const expansions = mkPages();
    const reverted = revertReviewCastRegressions({
      expansions,
      briefsIn: mkIn(),
      introduced: [
        { pageNumber: 7, type: 'interaction_multiple_actions' },
        { pageNumber: 13, type: 'vb_element_overflow' },
        { pageNumber: 13, type: 'cast_id_unresolved' },
      ],
    });
    expect(reverted).toEqual([]);
    expect(expansions[0].brief).toBe(REWRITE_P7);
  });

  it('prunes sceneDiffs and changed so the stored report does not claim a withdrawn rewrite', () => {
    const expansions = mkPages();
    const sceneDiffs = [
      { pageNumber: 7, before: AD_P7, after: REWRITE_P7 },
      { pageNumber: 13, before: AD_P13, after: REWRITE_P13 },
    ];
    const changed = [7, 13];
    revertReviewCastRegressions({
      expansions, briefsIn: mkIn(), introduced: [{ pageNumber: 7, type: 'cast_unlisted' }], sceneDiffs, changed,
    });
    expect(sceneDiffs.map(d => d.pageNumber)).toEqual([13]);
    expect(changed).toEqual([13]);
  });

  it('is a no-op when the page has no snapshot, or the review left it untouched', () => {
    const untouched = [{ pageNumber: 7, brief: AD_P7 }];
    expect(revertReviewCastRegressions({
      expansions: untouched, briefsIn: mkIn(), introduced: [{ pageNumber: 7, type: 'cast_unlisted' }],
    })).toEqual([]);

    const noSnapshot = [{ pageNumber: 7, brief: REWRITE_P7 }];
    expect(revertReviewCastRegressions({
      expansions: noSnapshot, briefsIn: [], introduced: [{ pageNumber: 7, type: 'cast_unlisted' }],
    })).toEqual([]);
    expect(noSnapshot[0].brief).toBe(REWRITE_P7);
  });

  it('survives missing/garbage arguments rather than throwing mid-pipeline', () => {
    expect(revertReviewCastRegressions()).toEqual([]);
    expect(revertReviewCastRegressions({})).toEqual([]);
    expect(revertReviewCastRegressions({ expansions: null, briefsIn: null, introduced: null })).toEqual([]);
    expect(revertReviewCastRegressions({
      expansions: mkPages(), briefsIn: mkIn(), introduced: [{ type: 'cast_unlisted' }],
    })).toEqual([]);
  });

  it('returns reverted pages ascending', () => {
    const expansions = [
      { pageNumber: 13, brief: REWRITE_P13 },
      { pageNumber: 7, brief: REWRITE_P7 },
    ];
    const reverted = revertReviewCastRegressions({
      expansions,
      briefsIn: mkIn(),
      introduced: [{ pageNumber: 13, type: 'cast_unlisted' }, { pageNumber: 7, type: 'cast_unlisted' }],
    });
    expect(reverted).toEqual([7, 13]);
  });
});

describe('sceneIntent survives the parse into fullData', () => {
  it('carries sceneIntent through to sceneMetadata.fullData (it was dropped by the allowlist)', () => {
    const meta = extractSceneMetadata(brief('The main character stands in the doorway.', {
      sceneIntent: 'The main character stands in the doorway, looking out.',
      characters: [{ name: 'Lead', clothing: 'standard', position: 'center' }],
      objects: [],
    }));
    expect(meta).toBeTruthy();
    expect(meta.fullData.sceneIntent).toBe('The main character stands in the doorway, looking out.');
  });

  it('a brief with no sceneIntent is safe — absent reads as not declared, never undefined-crashes', () => {
    const meta = extractSceneMetadata(brief('The main character stands in the doorway.', {
      characters: [{ name: 'Lead', clothing: 'standard', position: 'center' }],
      objects: [],
    }));
    expect(meta).toBeTruthy();
    expect(meta.fullData.sceneIntent ?? null).toBeNull();
  });

  it('the fullData allowlist is the drop site — pin sceneIntent into it by source', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'server/lib/sceneMetadata.js'), 'utf8');
    const block = src.slice(src.indexOf('fullData: {'), src.indexOf('fullData: {') + 1400);
    expect(block).toMatch(/sceneIntent:/);
  });
});

describe('scene-review check 5a — a collective reference to the cast names them', () => {
  const rule = fs.readFileSync(path.join(process.cwd(), 'prompts/scene-review.txt'), 'utf8')
    .split('\n').find(l => l.includes('[cast_not_in_plan]')) || '';

  it('5a still exists and still strips a character the plan line does not cover', () => {
    expect(rule).toBeTruthy();
    expect(rule).toMatch(/still an import/i);
  });

  it('5a exempts a plan line that refers to the cast collectively (behaviour, not wording)', () => {
    expect(rule).toMatch(/collective/i);
    expect(rule).toMatch(/keep them/i);
  });

  it('5a names no story — archetypes only', () => {
    for (const name of ['Fiona', 'Amrein', 'Sarah', 'Saira', 'Facundo', 'Lorena', 'pirate']) {
      expect(rule).not.toContain(name);
    }
  });
});
