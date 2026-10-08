import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const PB = require_('../../server/lib/promptBuilders.js');
const { reviewPlanChanges } = require_('../../server/lib/planCounters.js');
const { checkCreatureScale } = require_('../../server/lib/creatureScaleCheck.js');
const { checkDeclaredEmotion } = require_('../../server/lib/emotionCheck.js');
const { buildTextStagePictureSpecs } = require_('../../server/lib/sceneMetadata.js');
const fs = require_('node:fs');
const path = require_('node:path');

// job_1791489793707_2ir6nl5kw (staging dragon run, 2026-10-08) leftovers.

describe('plan order (Q13) is a must-fix finding', () => {
  it('ranks check 13 must, so the re-plan may change a protected page for it', () => {
    expect(PB.replanRank({ kind: 'check', check: 13 })).toBe('must');
    // the questions the 2026-09-09 / 09-10 rulings keep advisory stay advisory
    for (const q of [1, 5, 9, 10, 11]) expect(PB.replanRank({ kind: 'check', check: q })).toBe('also');
  });
  it('the planner is told an object put in a place is staged there until it is taken out', () => {
    const t = fs.readFileSync(path.join(__dirname, '../../prompts/story-beats.txt'), 'utf8');
    expect(t).toMatch(/puts in a place on one page and takes out of it on a later page/);
  });
});

describe('a change that answers several findings is judged by all of them', () => {
  const review = (answers: string) => reviewPlanChanges({
    changes: PB.parsePlanChanges(`---CHANGES---
Page 14: new material the egg lying in the nest — ${answers} — the egg must already lie in the nest
Changes: 1`).changes,
    standing: [], returned: [], castNames: ['Kiaan', 'Levin'],
    protectedPages: new Map([[14, "Kiaan's own action"]]), rankOf: PB.replanRank,
  });
  it('the p14 change (CHECK[9] and CHECK[13]) is no longer refused as noted-only', () => {
    expect(review('CHECK[9] and CHECK[13]').refusals).toEqual([]);
    expect(review('CHECK[13]').refusals).toEqual([]);
  });
  it('still refused when every finding it names is noted', () => {
    expect(review('CHECK[9] and CHECK[1]').refusals.map((r: any) => r.rule)).toEqual(['protected']);
  });
});

describe('writer picture spec carries every figure face and gaze, creatures included', () => {
  const META = {
    sceneIntent: 'Levin holds the book up to the dragon.',
    characters: [{ name: 'Levin', clothing: 'standard', expression: 'face not visible', looksAt: 'ART002' }],
    objects: ['LOC001', 'ANI001', 'ART002'],
    creatures: [{ id: 'ANI001', depth: 'midground', looksAt: 'ART002', expression: 'brows drawn down, mouth firmly closed', emotion: 'angry' }],
  };
  const brief = 'Over the shoulder.\n---METADATA---\n' + JSON.stringify(META);
  const story = {
    visualBible: {
      locations: [{ id: 'LOC001', name: 'the meadow' }],
      artifacts: [{ id: 'ART002', name: 'picture book' }],
      animals: [{ id: 'ANI001', name: 'Glutta', species: 'dragon', coloring: 'crimson' }],
    },
    clothingRequirements: {},
  };
  it('lists the creature with its Face and Looks at, not by name only', () => {
    const spec = buildTextStagePictureSpecs([{ pageNumber: 13, brief }], story).get(13);
    expect(spec).toMatch(/Glutta[^\n]*Face: brows drawn down, mouth firmly closed/);
    expect(spec).toMatch(/Glutta[^\n]*Looks at: picture book/);
  });
  it('gives a cast member the gaze too', () => {
    const spec = buildTextStagePictureSpecs([{ pageNumber: 13, brief }], story).get(13);
    expect(spec).toMatch(/- Levin[^\n]*Looks at: picture book/);
  });
});

describe('extras do not wear the cast garment colours (image population line)', () => {
  it('ambient, sparse and crowd lines name the garment colour', () => {
    for (const pop of ['ambient', 'sparse', 'crowd']) {
      expect(PB.buildRequiredCastRule(pop)).toMatch(/hair, build, outfit or garment colour/);
    }
  });
});

describe('the brief prompts keep a worn item off a page its wearer is not on', () => {
  it('both Art Director templates say so', () => {
    for (const f of ['scene-briefs-all.txt', 'scene-expansion.txt']) {
      const t = fs.readFileSync(path.join(__dirname, '../../prompts', f), 'utf8');
      expect(t, f).toMatch(/only on a page where someone in the picture wears or holds it/);
    }
  });
});

describe('creature size from the judge boxes (D-34)', () => {
  const creatures = [{ id: 'ANI001', name: 'Glutta', givenTimes: [{ name: 'Levin', times: 3.1 }, { name: 'Max', times: 3.5 }] }];
  // job_1791489793707_2ir6nl5kw p8 as the judge filed it: Glutta 0.70 of the frame, Levin 0.60, Max 0.63
  const matches = [
    { figure: 1, reference: 'Levin', body_bbox: [0.05, 0.32, 0.25, 0.92] },
    { figure: 2, reference: 'Max', body_bbox: [0.23, 0.29, 0.43, 0.92] },
    { figure: 3, reference: 'Glutta', body_bbox: [0.48, 0.09, 0.99, 0.79] },
  ];
  const figures = [
    { id: 1, zone: 'left-foreground', clipped_by: 'none' },
    { id: 2, zone: 'center-foreground', clipped_by: 'none' },
    { id: 3, zone: 'right-midground', clipped_by: 'none' },
  ];
  it('files a MAJOR creature_scale when the dragon is drawn barely taller than the children', () => {
    const f = checkCreatureScale({ creatures, matches, figures });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ type: 'creature_scale', severity: 'MAJOR', character: 'Glutta' });
  });
  it('files nothing when the creature is drawn near its given multiple', () => {
    const big = matches.map(m => (m.reference === 'Glutta' ? { ...m, body_bbox: [0.4, 0.02, 0.99, 0.98] } : m));
    // Glutta 0.96 / Levin 0.60 = 1.6, more than half of 3.1
    expect(checkCreatureScale({ creatures, matches: big, figures })).toEqual([]);
  });
  it('skips a creature cut by the frame, and one far behind the figures', () => {
    const clipped = matches.map(m => (m.reference === 'Glutta' ? { ...m, body_bbox: [0.48, 0, 0.99, 0.79] } : m));
    expect(checkCreatureScale({ creatures, matches: clipped, figures })).toEqual([]);
    const far = figures.map(f => (f.id === 3 ? { ...f, zone: 'center-background' } : f));
    expect(checkCreatureScale({ creatures, matches, figures: far })).toEqual([]);
  });
  it('ignores a creature given under twice a figure (a small companion)', () => {
    const small = [{ id: 'ANI002', name: 'Glutta', givenTimes: [{ name: 'Levin', times: 0.5 }] }];
    expect(checkCreatureScale({ creatures: small, matches, figures })).toEqual([]);
  });
  it('creatureHeightMultiples states the given multiple as a number from the band and the cast', () => {
    const vb = { animals: [{ id: 'ANI001', name: 'Glutta', scaleClass: 'twice-adult-height' }] };
    const out = PB.creatureHeightMultiples(vb, ['ANI001'], [{ name: 'Levin', age: 5, height: 110 }]);
    expect(out).toHaveLength(1);
    expect(out[0].givenTimes[0].times).toBeGreaterThan(2.5);
  });
});

describe('a creature declared emotion is compared (smiling dragon on a sad page)', () => {
  it('files an emotion finding for a creature row whose face reads the opposite', () => {
    const f = checkDeclaredEmotion({
      declared: [{ name: 'Glutta', emotion: 'sad', expression: 'eyes lowered, mouth turned down' }],
      inventory: { figures: [], objects: [{ what: 'dragon', body_bbox: [0.4, 0.1, 0.9, 0.8], emotion: 'happy' }] },
      matches: [{ figure: 1, reference: 'Glutta', body_bbox: [0.4, 0.1, 0.9, 0.8] }],
    });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ type: 'emotion', severity: 'CRITICAL', character: 'Glutta' });
  });
  it('evalPipeline hands the checker the creatures of the page as well as its cast', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../server/lib/evalPipeline.js'), 'utf8');
    const i = src.indexOf('checkDeclaredEmotion({');
    expect(i).toBeGreaterThan(0);
    expect(src.slice(i, i + 1200)).toContain('gazeCreatures(declaredSceneMeta');
  });
});
