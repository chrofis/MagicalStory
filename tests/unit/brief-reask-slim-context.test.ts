/**
 * THE RE-ASK'S SLIMMED CONTEXT (owner, 2026-09-30, "slim the re-ask's context").
 * Measured on staging (job_1790618717512_n9wrh5u0j, 5 flagged pages): the full
 * call-2 prompt the re-ask used to carry was 91k chars (30.4k tokens) to
 * correct 5 pages. promptBuilders.buildBriefReaskContext gives the re-ask the
 * call-2 template's own rules and output contract plus the Visual Bible, but
 * only the FLAGGED pages' plan lines/FIXED blocks — never the whole story or
 * every page's plan line. Pins behaviour, never prompt wording.
 * see docs/decisions.md 2026-09-30 "slim the brief re-ask's context"
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);
const PB = req('../../server/lib/promptBuilders');
const { loadPromptTemplates } = req('../../server/services/prompts');

beforeAll(async () => { await loadPromptTemplates(); });

const inputData = {
  language: 'en',
  characters: [{ name: 'Ana' }, { name: 'Ben' }],
  // Pin the text-zone gate (runtime.textZoneRulesActive rolls it per story
  // when unset) so the two prompts being compared are deterministic in size.
  layout: { textInImage: true },
};
// A 12-page book — big enough that "only the flagged pages" is a real cut.
const BEATS = Array.from({ length: 12 }, (_, i) => ({
  pageNumber: i + 1,
  planLine: `medium — Ana and Ben — they are on page ${i + 1} of a very long story arc that goes on and on with lots of detail about what happens — nothing changes`,
  jevFixed: { shot: 'medium', timeOfDay: 'dusk', indoor: false, cites: [], decidedIds: [], location: 'LOC001' },
}));
const VISUAL_BIBLE = JSON.stringify({ locations: [{ id: 'LOC001', name: 'quay', label: 'harbour quay' }] });
const FINAL_ARC = 'A'.repeat(20000); // stand-in for "the whole story" the full call-2 prompt carries
// buildAvailableAvatarsForPrompt's fallback picks RANDOM example entries when
// `options.availableAvatars` is omitted (promptBuilders.js ~7725) — an
// explicit string (as the real beatsPipeline caller always passes) keeps this
// size comparison deterministic.
const AVAILABLE_AVATARS = 'Ana: standard (red sweater, blue jeans, white sneakers)\nBen: standard (green jacket, grey trousers, brown boots)';

describe('buildBriefReaskContext — the slimmed re-ask context', () => {
  it('carries the call-2 rules and the Visual Bible', () => {
    const ctx = PB.buildBriefReaskContext(inputData, BEATS, [3], { visualBible: VISUAL_BIBLE, jevBackup: false, availableAvatars: AVAILABLE_AVATARS });
    expect(ctx).toContain("Simplify, don't elaborate");
    expect(ctx).toContain('harbour quay');
  });

  it('carries only the FLAGGED pages\' plan lines, not every page\'s', () => {
    const ctx = PB.buildBriefReaskContext(inputData, BEATS, [3], { visualBible: VISUAL_BIBLE, jevBackup: false, availableAvatars: AVAILABLE_AVATARS });
    expect(ctx).toContain('page 3 of a very long story arc');
    expect(ctx).not.toContain('page 1 of a very long story arc');
    expect(ctx).not.toContain('page 12 of a very long story arc');
  });

  it('several flagged pages: each one\'s plan line is present, the rest are not', () => {
    const ctx = PB.buildBriefReaskContext(inputData, BEATS, [2, 5, 9], { visualBible: VISUAL_BIBLE, jevBackup: false, availableAvatars: AVAILABLE_AVATARS });
    for (const n of [2, 5, 9]) expect(ctx).toContain(`page ${n} of a very long story arc`);
    for (const n of [1, 3, 4, 6, 7, 8, 10, 11, 12]) expect(ctx).not.toContain(`page ${n} of a very long story arc`);
  });

  it('never carries the whole story (FINAL_ARC) the full call-2 prompt does', () => {
    // buildSceneBriefsAllPrompt is the full prompt the re-ask used to pass
    // whole as its context; confirm it DOES carry the arc, so the slim
    // context's omission of it is a real cut, not an already-absent field.
    const full = PB.buildSceneBriefsAllPrompt(inputData, BEATS, { finalArc: FINAL_ARC, visualBible: VISUAL_BIBLE, availableAvatars: AVAILABLE_AVATARS });
    expect(full).toContain(FINAL_ARC);
    const ctx = PB.buildBriefReaskContext(inputData, BEATS, [3], { finalArc: FINAL_ARC, visualBible: VISUAL_BIBLE, jevBackup: false, availableAvatars: AVAILABLE_AVATARS });
    expect(ctx).not.toContain(FINAL_ARC);
  });

  it('is smaller than the full call-2 prompt by at least the dropped FINAL_ARC', () => {
    // The shared rule/output text (the "rules it needs") is deliberately kept
    // verbatim in both, so on a short fixture like this one it dominates —
    // the real saving (91k → far less, measured on staging) comes from a
    // full-length story and every page's plan line, which this fixture
    // stands in for with FINAL_ARC and the 11 non-flagged pages' lines. The
    // robust, fixture-size-independent invariant: the cut is AT LEAST the
    // 20,000-char arc the slim context drops entirely.
    const full = PB.buildSceneBriefsAllPrompt(inputData, BEATS, { finalArc: FINAL_ARC, visualBible: VISUAL_BIBLE, availableAvatars: AVAILABLE_AVATARS });
    const slim = PB.buildBriefReaskContext(inputData, BEATS, [3], { finalArc: FINAL_ARC, visualBible: VISUAL_BIBLE, jevBackup: false, availableAvatars: AVAILABLE_AVATARS });
    expect(full.length).toBeGreaterThan(0);
    expect(slim.length).toBeLessThan(full.length);
    expect(full.length - slim.length).toBeGreaterThanOrEqual(FINAL_ARC.length);
  });

  it('leaves no unfilled {PLACEHOLDER} token', () => {
    const ctx = PB.buildBriefReaskContext(inputData, BEATS, [3], { visualBible: VISUAL_BIBLE, jevBackup: false, availableAvatars: AVAILABLE_AVATARS });
    expect(ctx).not.toMatch(/\{[A-Z_]+\}/);
  });
});
