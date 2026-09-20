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
  // TEN PAGES, NOT FOUR (2026-09-20). The position floor became TIERED with the
  // distribution table: a book of eight pages or fewer is asked for no angle at
  // all, so a four-page fixture no longer trips this counter — by design, so a
  // six-page trial is never sent back for an over-the-shoulder page. Ten pages
  // sits in the middle tier, which owes two positions.
  const eyeLevel = [
    page(1, line('wide', 'Ana')),
    page(2, line('close-up', 'Ben')),
    page(3, line('medium', 'Ana and Ben')),
    page(4, line('ultra-wide', 'Ana')),
    page(5, line('close-up', 'Ben')),
    page(6, line('wide', 'Ana')),
    page(7, line('medium', 'Ben')),
    page(8, line('ultra-wide', 'Ana and Ben')),
    page(9, line('close-up', 'Ana')),
    page(10, line('medium', 'Ben')),
  ];
  /** The book with its last N pages replaced by angled ones. */
  const angled = (...shots: string[]) => [
    ...eyeLevel.slice(0, eyeLevel.length - shots.length),
    ...shots.map((shot, i) => page(eyeLevel.length - shots.length + i + 1, line(shot, 'Ana'))),
  ];

  it('a book of eight pages or fewer is asked for no camera position at all', () => {
    expect(codesFor(eyeLevel.slice(0, 8))).not.toContain('SHOT_NO_CAMERA_POSITION');
  });

  it('fires when no page declares a camera position', () => {
    expect(codesFor(eyeLevel)).toContain('SHOT_NO_CAMERA_POSITION');
  });

  it('one angled page is not enough at this length — the tier asks for two', () => {
    expect(codesFor(angled('high-angle'))).toContain('SHOT_NO_CAMERA_POSITION');
    expect(codesFor(angled('high-angle', 'low-angle'))).not.toContain('SHOT_NO_CAMERA_POSITION');
  });

  it('is answered by any of the four positions', () => {
    for (const id of POSITION_SHOTS) {
      expect(codesFor(angled(id, id)), `\`${id}\` did not satisfy the counter`)
        .not.toContain('SHOT_NO_CAMERA_POSITION');
    }
  });

  it('names the angled pages it found, and none when the book is all eye level', () => {
    const f = runPlanCounters({ roster: rosterFor(eyeLevel), pages: eyeLevel, commissionedNames: CAST })
      .findings.find((x: any) => x.code === 'SHOT_NO_CAMERA_POSITION');
    expect(f.pages).toEqual([]);
  });

  // REVERSED 2026-09-20 (owner). It reported as "also noted" from 2026-09-19,
  // on the reasoning that a must-fix would spend a re-plan round on every book
  // until the planner reached for a position unprompted. It never did: 3 pages
  // in 180 across the eleven staging books of the following fortnight, because
  // nothing in the prompt asked for one. The prompt now states the table these
  // counters measure, and the finding is must-fix.
  it('is a must-fix code', () => {
    expect(PB.replanRank({ code: 'SHOT_NO_CAMERA_POSITION' })).toBe('must');
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

  it('the template fills the distribution rather than spelling it out', () => {
    // The position list reaches the planner inside {SHOT_DISTRIBUTION} since
    // 2026-09-20: one sentence states the words AND how many pages owe one, and
    // that count is page-count aware, so the template cannot hold a literal.
    const { PROMPT_TEMPLATES } = require_('../../server/services/prompts');
    expect(String(PROMPT_TEMPLATES.storyBeats)).toContain('{SHOT_DISTRIBUTION}');
    expect(String(PROMPT_TEMPLATES.storyBeats)).not.toContain('{SHOT_POSITIONS}');
  });
});
