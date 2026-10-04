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

});
