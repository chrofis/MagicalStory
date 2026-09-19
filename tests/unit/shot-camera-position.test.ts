/**
 * THE SHOT FIELD CARRIES TWO AXES, AND EACH IS ASKED FOR AND COUNTED ON ITS OWN.
 *
 * 1b53f4d0f (2026-09-19) widened `shot` from four words to eight: four camera
 * DISTANCES (close-up … ultra-wide) and four camera POSITIONS
 * (over-the-shoulder, high-angle, low-angle, aerial). The vocabulary permitted
 * an angle from that commit on, but nothing asked for one and nothing counted
 * one, and the field is one-of — a page declaring `high-angle` has spent its
 * word and states no distance.
 *
 * Measured baseline, staging, all stored `shot` values (1,504 across 107
 * stories): medium 46.5%, wide 34.4%, close-up 13.0%, ultra-wide 3.8%, and six
 * values in total carrying any camera position at all (0.4%). Every page of
 * every book was drawn at eye level.
 *
 * Two behaviours are pinned here, never the wording of any prompt:
 *   A. the regression the widening introduced — SHOT_VARIETY counted all eight
 *      words together, so medium/wide/aerial passed a rule that is about
 *      camera DISTANCE on two distances;
 *   B. a book with no camera position anywhere produces a finding.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';

const require_ = createRequire(import.meta.url);
const { SHOTS, SHOT_TYPES, SHOT_AXIS, DISTANCE_SHOTS, POSITION_SHOTS, SHOT_POSITIONS } =
  require_('../../server/lib/shotVocabulary');
const { runPlanCounters } = require_('../../server/lib/planCounters');
const PB = require_('../../server/lib/promptBuilders');
const { loadPromptTemplates } = require_('../../server/services/prompts');

const CAST = ['Ana', 'Ben'];
const line = (shot: string, who: string) =>
  `${shot} — ${who} — something happens — something is now true`;
const page = (n: number, planLine: string) => ({ pageNumber: n, planLine, beat: 'a beat' });

/** The counters take a declared per-page roster; these pages name Ana and Ben. */
const rosterFor = (pages: any[]) =>
  new Map(pages.map(p => [Number(p.pageNumber), {
    people: CAST.filter(n => String(p.planLine).includes(n)),
    things: [] as string[],
  }]));

const codesFor = (pages: any[]) =>
  runPlanCounters({ roster: rosterFor(pages), pages, commissionedNames: CAST })
    .findings.map((f: any) => f.code);

describe('the vocabulary declares which question each word answers', () => {
  it('every shot carries an axis, and the two axes partition the eight words', () => {
    for (const s of SHOTS) expect(['distance', 'position'], s.id).toContain(s.axis);
    expect(DISTANCE_SHOTS).toEqual(['close-up', 'medium', 'wide', 'ultra-wide']);
    expect(POSITION_SHOTS).toEqual(['over-the-shoulder', 'high-angle', 'low-angle', 'aerial']);
    expect([...DISTANCE_SHOTS, ...POSITION_SHOTS].sort()).toEqual([...SHOT_TYPES].sort());
    expect(SHOT_AXIS['aerial']).toBe('position');
    expect(SHOT_AXIS['close-up']).toBe('distance');
  });

  it('the counters read that axis rather than keeping a second list of angles', () => {
    const src = require_('fs').readFileSync(
      require_('path').join(process.cwd(), 'server/lib/planCounters.js'), 'utf8');
    expect(src).toContain('SHOT_AXIS');
    for (const id of POSITION_SHOTS) {
      expect(src, `planCounters hand-lists \`${id}\` instead of reading the axis`)
        .not.toContain(`'${id}'`);
    }
  });
});

describe('SHOT_VARIETY is about camera DISTANCE, not about eight words', () => {
  // The regression: before the axis, a third word of ANY kind satisfied it.
  it('still fires on a book with only two distances, even when a page is angled', () => {
    const pages = [
      page(1, line('wide', 'Ana')),
      page(2, line('medium', 'Ben')),
      page(3, line('aerial', 'Ana and Ben')),
      page(4, line('wide', 'Ana')),
    ];
    expect(codesFor(pages)).toContain('SHOT_VARIETY');
  });

  it('is clean once a third DISTANCE appears', () => {
    const pages = [
      page(1, line('wide', 'Ana')),
      page(2, line('medium', 'Ben')),
      page(3, line('close-up', 'Ana')),
      page(4, line('aerial', 'Ana and Ben')),
    ];
    expect(codesFor(pages)).not.toContain('SHOT_VARIETY');
  });

  it('reports the distances it counted, and the angled pages separately', () => {
    const pages = [
      page(1, line('wide', 'Ana')),
      page(2, line('low-angle', 'Ben')),
      page(3, line('close-up', 'Ana')),
    ];
    const r = runPlanCounters({ roster: rosterFor(pages), pages, commissionedNames: CAST });
    expect(r.stats.distancesUsed.sort()).toEqual(['close-up', 'wide']);
    expect(r.stats.angledPages).toEqual([2]);
  });
});

describe('SHOT_NO_CAMERA_POSITION — a book drawn entirely at eye level', () => {
  const eyeLevel = [
    page(1, line('wide', 'Ana')),
    page(2, line('close-up', 'Ben')),
    page(3, line('medium', 'Ana and Ben')),
    page(4, line('ultra-wide', 'Ana')),
  ];

  it('fires when no page declares a camera position', () => {
    expect(codesFor(eyeLevel)).toContain('SHOT_NO_CAMERA_POSITION');
  });

  it('is answered by a single angled page — the floor is one, not a quota', () => {
    const withAngle = [...eyeLevel.slice(0, 3), page(4, line('high-angle', 'Ana'))];
    expect(codesFor(withAngle)).not.toContain('SHOT_NO_CAMERA_POSITION');
  });

  it('is answered by any of the four positions', () => {
    for (const id of POSITION_SHOTS) {
      const pages = [...eyeLevel.slice(0, 3), page(4, line(id, 'Ana'))];
      expect(codesFor(pages), `\`${id}\` did not satisfy the counter`)
        .not.toContain('SHOT_NO_CAMERA_POSITION');
    }
  });

  it('names no page — it is a property of the whole book, like SHOT_VARIETY', () => {
    const f = runPlanCounters({ roster: rosterFor(eyeLevel), pages: eyeLevel, commissionedNames: CAST })
      .findings.find((x: any) => x.code === 'SHOT_NO_CAMERA_POSITION');
    expect(f.pages).toEqual([]);
  });

  // A must-fix finding spends a re-plan round on every book that trips it, and
  // every book stored today trips this one. Not must-fix without an owner call.
  it('is not a must-fix code', () => {
    expect(PB.replanRank({ code: 'SHOT_NO_CAMERA_POSITION' })).toBe('also');
    expect(PB.replanRank({ code: 'NO_FOCAL_PAGE' })).toBe('must');
  });
});

describe('the planner is asked for a camera position', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('the built beats prompt names every position, from the one vocabulary', () => {
    const prompt = PB.buildBeatsPrompt(
      { title: 'A Book', characters: [{ id: 'c1', name: 'Ana', age: 8 }], mainCharacters: ['c1'], language: 'en', pages: 8 },
      8, { finalArc: 'a settled arc' });
    expect(prompt).toBeTruthy();
    expect(prompt).not.toContain('{SHOT_POSITIONS}');
    expect(prompt).toContain(SHOT_POSITIONS);
    for (const id of POSITION_SHOTS) {
      expect(prompt, `the planner is never offered \`${id}\``).toContain(id);
    }
  });

  it('the template fills the list rather than spelling it out', () => {
    const { PROMPT_TEMPLATES } = require_('../../server/services/prompts');
    expect(String(PROMPT_TEMPLATES.storyBeats)).toContain('{SHOT_POSITIONS}');
  });
});
