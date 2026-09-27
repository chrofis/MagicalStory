/**
 * GROUP STAGING — more than three characters in one frame (owner, 2026-09-27).
 *
 * The Art Director's rule 4 asked for a group of more than three at one depth
 * in a wider shot, or seen from behind as it moves away, and no critic checked
 * it. Staging job_1790446348343_z3fw660ie: p1 and p6 five on a `medium` (p6
 * scored 9), p16 five on a `wide` rendered as a posed row of faces (15).
 *
 * Pinned: the brief check's two types, read from structured fields only, the
 * cover and planned-close-up exemptions, and that ONE constant
 * (shotVocabulary.GROUP_STAGING_RULE) reaches every site that authors or
 * reviews a brief. Never the rule's wording. Offline and free.
 */
import { describe, it, beforeAll, expect } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const PB = require_('../../server/lib/promptBuilders');
const { checkPage, REVIEWABLE, renderFindingsBlock, checkScenes } = require_('../../server/lib/sceneBriefCheck');
const { GROUP_STAGING_RULE, GROUP_WIDER_SHOTS, SHOT_TYPES } = require_('../../server/lib/shotVocabulary');
const IB = require_('../../server/lib/iterateBeat');
const { loadPromptTemplates } = require_('../../server/services/prompts');

const NAMES = ['Ada', 'Ben', 'Cleo', 'Dan', 'Eve'];
const row = (name: string, extra: Record<string, unknown> = {}) =>
  ({ name, clothing: 'standard', position: 'center midground', depth: 'midground', looksAt: 'away', ...extra });
const brief = (meta: Record<string, unknown>) =>
  `The group stands together.\n\n---METADATA---\n${JSON.stringify({
    sceneIntent: 'The group stands together.', objects: [], timeOfDay: 'afternoon', weather: 'clear', ...meta,
  })}`;
const types = (pageNumber: number, meta: Record<string, unknown>, planLine = '') =>
  checkPage({ pageNumber, planLine, brief: brief(meta) }, NAMES, null, {})
    .map((f: any) => f.type).filter((t: string) => t.startsWith('group_'));

describe('group_shot_too_close', () => {
  it('fires on five characters in a medium shot (the p1 / p6 shape)', () => {
    const chars = NAMES.map((n, i) => row(n, { looksAt: NAMES[(i + 1) % 5] }));
    expect(types(6, { shot: 'medium', characters: chars })).toEqual(['group_shot_too_close']);
  });

  it('reads the shot the way classifyShot does — a non-breaking hyphen is still a close-up', () => {
    const chars = NAMES.slice(0, 4).map((n, i) => row(n, { looksAt: NAMES[(i + 1) % 4] }));
    expect(types(3, { shot: 'close‑up', characters: chars })).toContain('group_shot_too_close');
  });

  it('leaves three characters, a wider shot, and an unrecognised shot alone', () => {
    expect(types(2, { shot: 'medium', characters: NAMES.slice(0, 3).map(n => row(n)) })).toEqual([]);
    for (const shot of GROUP_WIDER_SHOTS) {
      expect(types(2, { shot, characters: NAMES.map(n => row(n)) })).not.toContain('group_shot_too_close');
    }
    expect(types(2, { shot: 'dutch tilt', characters: NAMES.map(n => row(n)) })).toEqual([]);
  });

  it('accepts a closer shot when the whole group is seen from behind', () => {
    const chars = NAMES.map(n => row(n, { perspective: 'back view' }));
    expect(types(4, { shot: 'medium', characters: chars })).toEqual([]);
  });

  it('keeps a close-up the plan line asks for (CLOSEUP_KEPT_RULE)', () => {
    const chars = NAMES.slice(0, 4).map((n, i) => row(n, { looksAt: NAMES[(i + 1) % 4] }));
    expect(types(3, { shot: 'close-up', characters: chars }, 'close-up — Ada, Ben, Cleo, Dan — x — y')).toEqual([]);
    expect(types(3, { shot: 'close-up', characters: chars }, 'medium — Ada, Ben, Cleo, Dan — x — y')).toEqual(['group_shot_too_close']);
  });

  it('every wider shot is a real shot', () => {
    for (const s of GROUP_WIDER_SHOTS) expect(SHOT_TYPES).toContain(s);
  });
});

describe('group_facing_viewer', () => {
  it('fires when most of the group looks at the place with nobody turned away (the p1 shape)', () => {
    const chars = NAMES.map(n => row(n, { looksAt: 'LOC001' }));
    expect(types(1, { shot: 'wide', characters: chars })).toEqual(['group_facing_viewer']);
  });

  it('fires on a literal viewer gaze on a story page', () => {
    const chars = NAMES.slice(0, 4).map(n => row(n, { looksAt: 'viewer' }));
    expect(types(16, { shot: 'wide', characters: chars })).toEqual(['group_facing_viewer']);
  });

  it('a group seen from behind, or looking at each other, a thing or away, is not flagged', () => {
    expect(types(1, { shot: 'wide', characters: NAMES.map(n => row(n, { looksAt: 'LOC001', perspective: 'back view' })) })).toEqual([]);
    expect(types(1, { shot: 'wide', characters: NAMES.map((n, i) => row(n, { looksAt: NAMES[(i + 1) % 5] })) })).toEqual([]);
    expect(types(1, { shot: 'wide', characters: NAMES.map(n => row(n, { looksAt: 'ART001' })) })).toEqual([]);
    expect(types(1, { shot: 'wide', characters: NAMES.map(n => row(n, { looksAt: 'away' })) })).toEqual([]);
  });

  it('half the group is not most of it', () => {
    const chars = NAMES.slice(0, 4).map((n, i) => row(n, { looksAt: i < 2 ? 'LOC001' : 'Ada' }));
    expect(types(1, { shot: 'wide', characters: chars })).toEqual([]);
  });

  it('an aerial shot is exempt: every head is seen from above', () => {
    expect(types(1, { shot: 'aerial', characters: NAMES.map(n => row(n, { looksAt: 'LOC001' })) })).toEqual([]);
  });
});

describe('covers', () => {
  it('a cover facing the viewer is never group_facing_viewer (COVER_GAZE_EXCEPTION)', () => {
    const chars = NAMES.map(n => row(n, { looksAt: 'viewer' }));
    expect(types(-1, { shot: 'wide', characters: chars })).toEqual([]);
  });

  it('a cover is still held to the wider shot, and is not offered the back-view alternative', () => {
    const chars = NAMES.map(n => row(n, { looksAt: 'viewer' }));
    const f = checkPage({ pageNumber: -3, planLine: '', brief: brief({ shot: 'medium', characters: chars }) }, NAMES, null, {})
      .find((x: any) => x.type === 'group_shot_too_close');
    expect(f).toBeTruthy();
    expect(f.detail).not.toMatch(/back view/);
  });
});

describe('the findings reach the scene review, and the rewrite only where it can answer', () => {
  it('both types are REVIEWABLE and rendered into BRIEF FAULTS', () => {
    expect(REVIEWABLE.has('group_shot_too_close')).toBe(true);
    expect(REVIEWABLE.has('group_facing_viewer')).toBe(true);
    const res = checkScenes([{ pageNumber: 6, planLine: '', brief: brief({ shot: 'medium', characters: NAMES.map(n => row(n, { looksAt: 'LOC001' })) }) }], NAMES, null, {});
    const block = renderFindingsBlock(res.byPage);
    expect(block).toContain('[group_shot_too_close]');
    expect(block).toContain('[group_facing_viewer]');
  });

  it('the iterate rewrite gets the facing half only — its `shot` is carried from the parent', () => {
    expect(IB.INTRODUCED_TYPES.has('group_facing_viewer')).toBe(true);
    expect(IB.INTRODUCED_TYPES.has('group_shot_too_close')).toBe(false);
  });
});

describe('one constant reaches every site that authors or reviews a brief', () => {
  const inputData: any = {
    title: 'The Five on the Pier',
    characters: NAMES.map((name, i) => ({ id: `c${i}`, name, age: 8, gender: 'girl' })),
    mainCharacters: ['c0'], language: 'en', languageLevel: 'medium', pages: 4,
    storyCategory: 'adventure', storyType: 'adventure', storyDetails: 'x', artStyle: 'watercolor',
    relationships: {}, relationshipTexts: {},
  };
  const BEATS = [{ pageNumber: 1, planLine: 'medium — Ada, Ben, Cleo, Dan, Eve — x — y' }];
  const VB: any = { artifacts: [], locations: [], vehicles: [], animals: [], secondaryCharacters: [], clothing: [] };
  let built: Record<string, string>;

  beforeAll(async () => {
    await loadPromptTemplates();
    built = {
      'AD all-pages': String(PB.buildSceneExpansionAllPrompt(inputData, BEATS, {})),
      'AD per-page': String(PB.buildSceneExpansionPrompt(1, 'page text', inputData.characters, 'en', VB, '', null, {})),
      'iterate strict': String(PB.buildSceneDescriptionPrompt(1, 'page text', inputData.characters, '', 'en', VB, [], 'standard', '', '',
        { planLine: BEATS[0].planLine }, { fixIssues: ['x'] }, { freeIterate: false })),
      'iterate free': String(PB.buildSceneDescriptionPrompt(1, 'page text', inputData.characters, '', 'en', VB, [], 'standard', '', '',
        { planLine: BEATS[0].planLine }, { fixIssues: ['x'] }, { freeIterate: true })),
      'scene review': String(PB.buildSceneReviewPrompt(inputData, [{ pageNumber: 1, brief: brief({ shot: 'medium', characters: NAMES.map(n => row(n)) }) }], { beats: BEATS })),
    };
  });

  it('every built prompt carries GROUP_STAGING_RULE and no unfilled {GROUP_STAGING}', () => {
    for (const [site, prompt] of Object.entries(built)) {
      expect(prompt.includes(GROUP_STAGING_RULE), `${site} lacks the group rule`).toBe(true);
      expect(prompt.includes('{GROUP_STAGING}'), `${site} ships the placeholder`).toBe(false);
    }
  });

  it('the scene review carries check [group_staging]', () => {
    expect(built['scene review']).toContain('[group_staging]');
  });

  it('the rule names exactly the wider shots the code check accepts', () => {
    for (const s of GROUP_WIDER_SHOTS) expect(GROUP_STAGING_RULE).toContain('`' + s + '`');
  });
});
