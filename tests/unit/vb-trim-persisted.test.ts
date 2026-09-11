/**
 * VB TRIM WRITE-BACK — the assignment trim (and the invented-peer age clamp)
 * must reach the TRANSCRIPT, because every later reader re-parses it.
 *
 * Bug (staging job_1788957347999_ijseol49a, 2026-09-09): `trimVbAssignments`
 * ran on beatsPipeline's own parsed copy; `beatsReviewReport.vbAssignmentTrim`
 * reported VEH002 stripped from pages 8 and 18, yet the stored
 * `data.visualBible` and the outline's ---VISUAL BIBLE--- JSON still listed
 * both pages, because storyJobPipeline re-parsed the untouched transcript.
 * Every `vb_element_overflow` in Lab 1157/1179 "survived" for that reason.
 *
 * The fix: `syncVisualBibleSection` projects the mutated fields back into the
 * transcript JSON, so `extractVisualBible()` yields the trimmed bible by
 * construction; `vbTrimLostPages` is the pre-save assertion.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { syncVisualBibleSection } = require_('../../server/lib/beatsPipeline');
const { trimVbAssignments, vbTrimLostPages, rankPageElements, VB_ELEMENT_BUDGET } = require_('../../server/lib/vbElementBudget');
const { UnifiedStoryParser } = require_('../../server/lib/outlineParser/unified');
const { applySecondaryAgeBand, commissionedChildBand } = require_('../../server/lib/inventedAgeBand');
const { buildCharacterDescription } = require_('../../server/lib/visualBible');

const PLAN = [
  { pageNumber: 1, planLine: 'wide — the girl — she crosses the bridge — she leaves town' },
  { pageNumber: 2, planLine: 'medium — the girl and the ferryman — he lifts the lantern over the rope coil — the way is lit' },
  { pageNumber: 3, planLine: 'close-up — the girl — her hand on the cold gate — the gate is locked' },
];

/** The writer's JSON shape: `pages`, raw `states`, a numeric `age`. Page 2 carries FOUR elements. */
const BIBLE_JSON = {
  secondaryCharacters: [
    // An invented child the bible itself declares a PEER of the commissioned
    // children, stated too old — the checkSecondaryAges shape (no inference).
    { id: 'CHR001', name: 'the ferryman', age: 10, peer: 'yes', sex: 'boy', build: 'wiry', hair: 'grey', pages: [2] },
  ],
  animals: [],
  artifacts: [
    { id: 'ART001', name: 'the brass lantern', type: 'lantern', description: 'a dented brass lantern', pages: [2] },
    { id: 'ART002', name: 'the rope coil', type: 'rope', description: 'a coil of tarred rope', pages: [2] },
    { id: 'ART003', name: "the girl's canvas satchel", type: 'bag', description: 'a canvas satchel', pages: [1, 2, 3],
      states: [
        { name: 'closed', delta: 'flap buckled', pages: [1], held: false },
        { name: 'open', delta: 'flap thrown back', pages: [2], held: false },
        { name: 'dropped', delta: 'lying in the mud', pages: [3], held: false },
      ] },
  ],
  vehicles: [],
  locations: [
    { id: 'LOC001', name: 'the old stone bridge', setting: 'river', signatureElement: 'moss', pages: [1] },
  ],
};

function transcript(json = BIBLE_JSON) {
  return [
    '---CLOTHING REQUIREMENTS---',
    '```json\n' + JSON.stringify({ clothingRequirements: {} }) + '\n```',
    '',
    '---VISUAL BIBLE---',
    '```json\n' + JSON.stringify(json, null, 2) + '\n```',
    '',
    '---COVER SCENE HINTS---',
    'front: the girl on the bridge',
  ].join('\n');
}

const count = (vb: any, page: number) => rankPageElements(page, {}, vb).length;
const parse = (text: string) => new UnifiedStoryParser(text).extractVisualBible();

describe('syncVisualBibleSection — the trim reaches the transcript', () => {
  it('a fresh parse of the untouched transcript is over budget (the bug precondition)', () => {
    const vb = parse(transcript());
    expect(count(vb, 2)).toBe(4);
    expect(count(vb, 2)).toBeGreaterThan(VB_ELEMENT_BUDGET);
  });

  it('after trim + write-back, extractVisualBible() on the new transcript yields <= budget and the loser no longer lists the page', () => {
    const text = transcript();
    const vb = parse(text);
    const trim = trimVbAssignments(vb, PLAN, { castNames: ['the girl'] });
    expect(trim.pagesOverBudgetBefore).toBe(1);
    expect(trim.pagesOverBudgetAfter).toBe(0);
    // The satchel is the only entry not named in page 2's plan line.
    expect(trim.stripped).toEqual([expect.objectContaining({ id: 'ART003', page: 2 })]);
    expect(trim.droppedStates).toEqual([{ id: 'ART003.2', parent: 'ART003' }]);

    const synced = syncVisualBibleSection(text, vb);
    expect(synced).not.toBe(text);

    const reparsed = parse(synced);
    expect(count(reparsed, 2)).toBe(VB_ELEMENT_BUDGET);
    const satchel = reparsed.artifacts.find((a: any) => a.id === 'ART003');
    expect(satchel.appearsInPages).toEqual([1, 3]);
    expect(satchel.pages).toEqual([1, 3]);
    // The emptied state is gone and the dotted ids re-minted dense, exactly as in memory.
    expect(satchel.states.map((s: any) => [s.id, s.name, s.pages])).toEqual([
      ['ART003.1', 'closed', [1]],
      ['ART003.2', 'dropped', [3]],
    ]);
    expect(satchel.states.map((s: any) => [s.id, s.name, s.pages])).toEqual(
      vb.artifacts.find((a: any) => a.id === 'ART003').states.map((s: any) => [s.id, s.name, s.pages]),
    );
    // Untouched entries and sibling sections survive verbatim.
    expect(reparsed.artifacts.find((a: any) => a.id === 'ART001').appearsInPages).toEqual([2]);
    expect(reparsed.locations[0].appearsInPages).toEqual([1]);
    expect(new UnifiedStoryParser(synced).extractClothingRequirements()).toEqual({});
    expect(synced).toContain('---COVER SCENE HINTS---\nfront: the girl on the bridge');
    // The write-back is idempotent against a second parse-and-sync.
    expect(syncVisualBibleSection(synced, reparsed)).toBe(syncVisualBibleSection(synced, reparsed));
    expect(parse(syncVisualBibleSection(synced, reparsed))).toEqual(reparsed);
  });

  it("applySecondaryAgeBand's clamp survives a re-parse", () => {
    const text = transcript();
    const vb = parse(text);
    const band = commissionedChildBand([{ name: 'the girl', age: '6' }]);
    const applied = applySecondaryAgeBand(vb.secondaryCharacters, band, buildCharacterDescription);
    expect(applied).toHaveLength(1);
    expect(applied[0].id).toBe('CHR001');
    const clampedTo = applied[0].clampedTo;
    expect(clampedTo).not.toBe(10);

    const reparsed = parse(syncVisualBibleSection(text, vb));
    const ferryman = reparsed.secondaryCharacters.find((c: any) => c.id === 'CHR001');
    expect(ferryman.age).toBe(clampedTo);
    expect(ferryman.secondaryAgeClamped).toEqual({ statedAge: 10, clampedTo, band: [band.low, band.high] });
    expect(ferryman.description).not.toMatch(/\b10\b/);
  });

  it('returns the text unchanged when there is no rewritable section', () => {
    const noSection = '---CLOTHING REQUIREMENTS---\n```json\n{}\n```\n';
    expect(syncVisualBibleSection(noSection, parse(transcript()))).toBe(noSection);
    const noJson = '---VISUAL BIBLE---\nprose only\n---COVER SCENE HINTS---\nx';
    expect(syncVisualBibleSection(noJson, parse(transcript()))).toBe(noJson);
    expect(syncVisualBibleSection(transcript(), null)).toBe(transcript());
  });
});

describe('vbTrimLostPages — the pre-save assertion', () => {
  it('fires on a mismatched pair: trim says clean, the bible about to be saved is not', () => {
    const untrimmed = parse(transcript());
    const report = { pagesOverBudgetBefore: 1, pagesOverBudgetAfter: 0, stripped: [{ id: 'ART003', page: 2 }], droppedStates: [] };
    expect(vbTrimLostPages(untrimmed, report)).toEqual([2]);
  });

  it('is silent on a consistent pair, and when there is nothing to check', () => {
    const text = transcript();
    const vb = parse(text);
    const trim = trimVbAssignments(vb, PLAN, { castNames: ['the girl'] });
    expect(vbTrimLostPages(vb, trim)).toEqual([]);
    expect(vbTrimLostPages(parse(syncVisualBibleSection(text, vb)), trim)).toEqual([]);
    // No trim ran (unified path, or the bible stage failed) → nothing to assert.
    expect(vbTrimLostPages(parse(text), null)).toEqual([]);
    // The trim itself reported a page it could not clear → not a loss, not reported here.
    expect(vbTrimLostPages(parse(text), { ...trim, pagesOverBudgetAfter: 1 })).toEqual([]);
  });
});
