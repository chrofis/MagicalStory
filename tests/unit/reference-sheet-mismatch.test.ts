/**
 * The three reference-sheet faults measured in staging story
 * job_1789147573901_m3uam0nxi (2026-09-11):
 *
 *  1. `vb_sheet_layout_mismatch` three times in one run (9 cells for 3
 *     requested, 2 for 3, 6 for 2). On the 2-for-3 sheet the detector merged
 *     three stacked panels into one "cell" and the identification call named
 *     it for a single element, so the stored reference for that entry showed a
 *     signpost, a cave wall and a boulder at once.
 *  2. `vb_state_cells_rerender` / `vb_state_cells_still_bad` with a WORD-FOR-
 *     WORD identical reason — the re-render was never told what failed.
 *  3. Both state cells of a creature entry drew four children and a dog,
 *     because its description named them to convey the creature's size.
 */
import { describe, it, expect, beforeAll } from 'vitest';

const { rejectMultiPanelAssignments } = require('../../server/lib/sheetGrid');
const { buildReferenceSheetPrompt } = require('../../server/lib/referenceSheets');
const prompts = require('../../server/services/prompts');

beforeAll(async () => { await prompts.loadPromptTemplates(); });

describe('grid mismatch — a merged cell yields no reference', () => {
  it('drops the element whose cell holds several panels (2 cells drawn for 3 elements)', () => {
    // Cell A merged three stacked panels; cell B is the blank margin column.
    const { map, dropped } = rejectMultiPanelAssignments([0, null, null], [3, 1]);
    expect(map).toEqual([null, null, null]);
    expect(dropped).toEqual([{ element: 0, cell: 0, panels: 3 }]);
  });

  it('keeps single-panel cells when the model drew MORE cells than asked (9 for 3)', () => {
    const map = [4, 0, 8];
    const { map: safe, dropped } = rejectMultiPanelAssignments(map, new Array(9).fill(1));
    expect(safe).toEqual(map);
    expect(dropped).toEqual([]);
  });

  it('drops only the untrustworthy assignment (6 cells drawn for 2 elements)', () => {
    const { map, dropped } = rejectMultiPanelAssignments([1, 4], [1, 2, 1, 1, 1, 1]);
    expect(map).toEqual([null, 4]);
    expect(dropped.map(d => d.element)).toEqual([0]);
  });

  it('never invents a drop for an unmatched element', () => {
    const { map, dropped } = rejectMultiPanelAssignments([null, 2], [1, 1, 1]);
    expect(map).toEqual([null, 2]);
    expect(dropped).toEqual([]);
  });
});

describe('re-render carries the gate reason', () => {
  const el = [{ id: 'ART001', name: 'Prop', type: 'artifact', description: 'a small wooden box' }];

  it('quotes the judge reason it was given', () => {
    const reason = 'The object in the second image is a darker shade than in the first';
    const prompt = buildReferenceSheetPrompt(el, 'watercolor', null, reason);
    expect(prompt).toContain(reason);
    expect(prompt).toMatch(/PREVIOUS ATTEMPT REJECTED/);
  });

  it('says nothing about a previous attempt on a first render', () => {
    const prompt = buildReferenceSheetPrompt(el, 'watercolor', null);
    expect(prompt).not.toMatch(/PREVIOUS ATTEMPT/i);
  });
});

describe('cell prompt bans scale props', () => {
  it('instructs that only the element itself is drawn', () => {
    const prompt = buildReferenceSheetPrompt(
      [{ id: 'CHR001', name: 'Creature', type: 'animal', description: 'a winged creature' }],
      'watercolor',
      null,
    );
    expect(prompt).toMatch(/Only the element itself is drawn/);
    expect(prompt).toMatch(/size or scale/);
    expect(prompt).toMatch(/is never drawn/);
  });

  // Regression: staging job_1789147573901_m3uam0nxi, Lab experiments 1191/1192.
  // Naming what an object attaches to fixed its identity — and the cell then
  // drew the mounting too. The mention is for recognition, never for the frame.
  it('bans drawing what the description says the element attaches to', () => {
    const prompt = buildReferenceSheetPrompt(
      [{ id: 'ART001', name: 'a fitting', type: 'fitting', description: 'a small housing on a bracket' }],
      'watercolor',
      null,
    );
    expect(prompt).toMatch(/attaches to, is part of, or is used with, is never drawn/);
  });
});

// Regression: staging job_1789147573901_m3uam0nxi, Lab experiments 1189/1190.
// A cell rendered the everyday object the entry's bare geometry describes
// rather than the object the entry names.
describe('cell prompt requires the drawing to read as the named element', () => {
  it('binds every cell to its own identity, not to a lookalike', () => {
    const prompt = buildReferenceSheetPrompt(
      [{ id: 'ART001', name: 'a hand tool', type: 'hand tool', description: 'a short shaft with a flat head' }],
      'watercolor',
      null,
    );
    expect(prompt).toMatch(/Each cell reads as the element it is named as/);
    expect(prompt).toMatch(/also fit a commoner everyday object, the cell shows the named one/);
  });

  it('does not re-add drawing the thing a description compares the element to', () => {
    const prompt = buildReferenceSheetPrompt(
      [{ id: 'ART001', name: 'a piece of tableware', type: 'tableware', description: 'a shallow round dish' }],
      'watercolor',
      null,
    );
    expect(prompt).toMatch(/size or scale/);
    expect(prompt).toMatch(/is never drawn/);
    expect(prompt).not.toMatch(/draw the thing it is compared to/i);
  });
});

// ── Staging job_1789348171785_9oxos7dwv (2026-09-14) ─────────────────────────
// The book's central prop shipped with NO reference cell at all (no
// referenceImageUrl, empty cellGates, no "The attached reference images
// include…" line on any page prompt), so the image model re-invented it page by
// page — a dull mottled stone, a glossy red egg, a speckled one, and two eggs
// on one page. Cause: the identification reply was valid JSON followed by prose
// ("Unexpected non-whitespace character after JSON at position 94") and the
// catch returned an all-null map, costing EVERY element of the batch its
// reference.
const { parseCellIdentification } = require('../../server/lib/sheetGrid');
const { fillMissingReferencesSolo, MAX_SOLO_REFERENCE_RERENDERS, identifySheetCellsWithRetry } = require('../../server/lib/referenceSheets');

describe('identification reply is parsed tolerantly', () => {
  const json = '{"assignments":[{"element":1,"label":"B"},{"element":2,"label":"A"}]}';
  const expected = [1, 0];

  it('parses a bare JSON object', () => {
    expect(parseCellIdentification(json, 2, 2).map).toEqual(expected);
  });

  it('parses a ```json fenced block', () => {
    expect(parseCellIdentification('```json\n' + json + '\n```', 2, 2).map).toEqual(expected);
  });

  it('parses JSON behind leading prose', () => {
    expect(parseCellIdentification('Here is the mapping you asked for:\n' + json, 2, 2).map).toEqual(expected);
  });

  it('parses JSON followed by trailing prose (the measured failure)', () => {
    const reply = json + '\n\nNote: cell C shows {nothing} that was requested.';
    expect(parseCellIdentification(reply, 2, 2).map).toEqual(expected);
  });

  it('still refuses a reply with no JSON at all', () => {
    expect(() => parseCellIdentification('I cannot tell which cell is which.', 2, 2)).toThrow();
  });

  it('still refuses malformed JSON', () => {
    expect(() => parseCellIdentification('{"assignments": [{"element": 1, ', 2, 2)).toThrow();
  });
});

describe('identification retries once', () => {
  // The real wrapper, driven through its `identify` test seam — no model call
  // is made anywhere in this suite.
  const good = { map: [0, 1], missing: [], unused: [] };
  const seam = (replies: any[]) => {
    const calls = { n: 0 };
    const identify = async () => {
      const r = replies[calls.n++];
      if (r instanceof Error) throw r;
      return r;
    };
    return { calls, identify };
  };

  it('a first failure followed by a good reply yields the map', async () => {
    const { calls, identify } = seam([new Error('identification reply is not valid JSON: x'), good]);
    const out = await identifySheetCellsWithRetry(null, [], [], null, { identify });
    expect(out).toEqual(good);
    expect(calls.n).toBe(2);
  });

  it('a good first reply is not retried', async () => {
    const { calls, identify } = seam([good, good]);
    expect(await identifySheetCellsWithRetry(null, [], [], null, { identify })).toEqual(good);
    expect(calls.n).toBe(1);
  });

  it('two failures give up after exactly two calls', async () => {
    const { calls, identify } = seam([new Error('boom'), new Error('boom again')]);
    await expect(identifySheetCellsWithRetry(null, [], [], null, { identify })).rejects.toThrow('boom again');
    expect(calls.n).toBe(2);
  });
});

describe('an element with no cell is re-rendered solo', () => {
  const batch = [{ id: 'ART001', name: 'Egg' }, { id: 'ART002', name: 'Lamp' }, { id: 'ART003', name: 'Map' }, { id: 'ART004', name: 'Key' }];

  it('re-renders the missing element and keeps the rest untouched', async () => {
    const refs = ['cellA', null];
    const seen: string[] = [];
    const renderSolo = async (cells: any[]) => { seen.push(cells[0].name); return ['solo-' + cells[0].name]; };
    const out = await fillMissingReferencesSolo(refs, batch.slice(0, 2), renderSolo, {});
    expect(refs).toEqual(['cellA', 'solo-Lamp']);
    expect(seen).toEqual(['Lamp']);
    expect(out.rerendered).toBe(1);
    expect(out.recovered).toEqual(['Lamp']);
    expect(out.stillMissing).toEqual([]);
    expect(out.cappedOut).toEqual([]);
  });

  it('does nothing when every element already has a reference', async () => {
    const renderSolo = async () => { throw new Error('must not be called'); };
    const out = await fillMissingReferencesSolo(['a', 'b'], batch.slice(0, 2), renderSolo, {});
    expect(out.rerendered).toBe(0);
  });

  it('bounds the re-renders by the cap and names what was left out', async () => {
    const refs = [null, null, null, null];
    let calls = 0;
    const renderSolo = async (cells: any[]) => { calls++; return ['solo-' + cells[0].name]; };
    const out = await fillMissingReferencesSolo(refs, batch, renderSolo, { cap: 3 });
    expect(calls).toBe(3);
    expect(out.rerendered).toBe(3);
    expect(out.cappedOut).toEqual(['Key']);
    expect(refs[3]).toBeNull();
  });

  it('uses MAX_SOLO_REFERENCE_RERENDERS when no cap is given', async () => {
    expect(MAX_SOLO_REFERENCE_RERENDERS).toBe(3);
    const refs = [null, null, null, null];
    let calls = 0;
    const renderSolo = async (cells: any[]) => { calls++; return ['solo-' + cells[0].name]; };
    await fillMissingReferencesSolo(refs, batch, renderSolo, {});
    expect(calls).toBe(MAX_SOLO_REFERENCE_RERENDERS);
  });

  it('reports an element that still has nothing after its solo re-render', async () => {
    const refs = [null];
    const renderSolo = async () => { throw new Error('re-render returned no image'); };
    const out = await fillMissingReferencesSolo(refs, [batch[0]], renderSolo, {});
    expect(refs).toEqual([null]);
    expect(out.rerendered).toBe(1);
    expect(out.recovered).toEqual([]);
    expect(out.stillMissing).toEqual(['Egg']);
  });

  it('reports an element whose solo re-render came back empty', async () => {
    const refs = [null];
    const renderSolo = async () => [null];
    const out = await fillMissingReferencesSolo(refs, [batch[0]], renderSolo, {});
    expect(out.stillMissing).toEqual(['Egg']);
  });
});
