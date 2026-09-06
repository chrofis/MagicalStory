import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

// OBJECT STATES — one physical thing is ONE Visual Bible entry however the
// story alters it, with each altered look a short delta in `states[]` carrying
// its own dotted id (`ART001.2`).
//
// The defect this locks down (staging job_1788681313413_xqmtk2gcs): one prop
// was written as TWO artifact entries. Each got its own reference render, the
// two renders disagreed structurally (one had a lid, a carved face and a
// carrying loop; the other had none of them), and the per-page objects[]
// alternated between them — three visually distinct forms across one book, and
// two pages where a character held a prop that had no handle to be held by.
//
// Four sites used a dotted handle as a raw LOOKUP KEY and failed SILENTLY on
// it. All four are covered below, plus the structural guarantee that every
// state of one object renders in a single call, plus the old (state-less)
// shape still working unchanged.

const require_ = createRequire(import.meta.url);
const { baseVbId, vbIdFacet, VB_ID_PATTERN } = require_('../../server/lib/vbIdGuard');
const {
  normaliseObjectStates, objectStates, objectStateFor, getElementReferenceImagesForPage,
  updateElementReferenceImage, MAX_OBJECT_STATES,
} = require_('../../server/lib/visualBible');
const { buildReferenceSheetBatches, expandElementStateCells, assertStateCellsCoLocated } =
  require_('../../server/lib/referenceSheets');
const { objectIds } = require_('../../server/lib/vbElementBudget');
const { addLogListener, removeLogListener } = require_('../../server/utils/logger');
const { keyForVbReference } = require_('../../server/lib/r2');

// @ts-expect-error - JS module without types
import { buildImagePrompt } from '../../server/lib/promptBuilders.js';

// ── Fixtures. Archetypal, not from any story. ───────────────────────────────
const STATED = {
  id: 'ART001',
  name: 'hollowed carved vessel with a lid',
  type: 'carved vessel',
  size: 'fits in two cupped hands',
  description:
    'a pale cream and grey hollowed vessel, the top third cut away as a separate lid that sits back on top, small triangular openings cut through the front wall, a brown twine loop threaded through two holes near the rim as a carrying handle',
  states: [
    { id: 'ART001.1', name: 'cracked', delta: 'a jagged vertical split down one side wall, the cut edges parted', pages: [5] },
    { id: 'ART001.2', name: 'mended', delta: 'a strip of clear tape along the split on the side wall', pages: [6] },
    { id: 'ART001.3', name: 'lit', delta: 'a small light source burns inside, light through the cut openings', pages: [7, 8] },
  ],
  appearsInPages: [5, 6, 7, 8],
  referenceImageUrl: 'https://r2/base.jpg',
};

// The old shape: no `states` key at all, exactly as every stored story has it.
const PLAIN = {
  id: 'ART002',
  name: 'woven carrying basket',
  type: 'basket',
  size: 'carried in both arms',
  description: 'a shallow basket woven from pale split willow with a rolled rim',
  appearsInPages: [5, 6],
  referenceImageUrl: 'https://r2/plain.jpg',
};

// The ceiling: 4 states, the unaltered look first (the authoring templates
// require that order, and the default-state rule reads it).
const MAXED_STATES = [
  { id: 'ART001.1', name: 'whole', delta: 'intact, the lid seated and the side wall unbroken', pages: [4] },
  ...STATED.states.map((st, i) => ({ ...st, id: `ART001.${i + 2}` })),
];

const bible = () => ({
  mainCharacters: [{ id: 'CHR001', name: 'Ada' }],
  secondaryCharacters: [], animals: [], vehicles: [], clothing: [], locations: [],
  artifacts: [JSON.parse(JSON.stringify(STATED)), JSON.parse(JSON.stringify(PLAIN))],
});

const scene = (objects: string[]) =>
  `A quiet room.\n\n---METADATA---\n${JSON.stringify({
    sceneIntent: 'test',
    characters: [{ name: 'Ada', position: 'center', depth: 'midground' }],
    shot: 'medium',
    objects,
    textPosition: 'bottom-left',
  })}`;

const promptFor = (objects: string[], vb: any = bible()) =>
  buildImagePrompt(scene(objects), { language: 'en' }, null, vb, 7, null, {});

const requiredObjectsBlock = (prompt: string) => {
  const m = prompt.match(/\*\*REQUIRED OBJECTS[^*]*\*\*:?\s*([\s\S]*?)(?=\n\n|$)/i);
  return m ? m[1] : '';
};

// ── 1. The grammar ─────────────────────────────────────────────────────────
describe('baseVbId / vbIdFacet — one grammar for a dotted handle', () => {
  it('strips the facet suffix to the parent id', () => {
    expect(baseVbId('ART001.2')).toBe('ART001');
    expect(baseVbId('LOC005.1')).toBe('LOC005');
    expect(baseVbId('ART001')).toBe('ART001');
    expect(baseVbId('art001.3')).toBe('ART001');
    expect(baseVbId('  ART001.3  ')).toBe('ART001');
  });

  it('returns null for anything that is not a handle', () => {
    expect(baseVbId('a carved vessel')).toBeNull();
    expect(baseVbId('XYZ001')).toBeNull();
    expect(baseVbId('')).toBeNull();
    expect(baseVbId(null)).toBeNull();
    expect(baseVbId(undefined)).toBeNull();
    expect(baseVbId('ART001.2 and more')).toBeNull();
  });

  it('reads the facet index, and only from a dotted handle', () => {
    expect(vbIdFacet('ART001.3')).toBe(3);
    expect(vbIdFacet('ART001')).toBeNull();
    expect(vbIdFacet('not an id')).toBeNull();
  });

  it('the dotted ART form is legal in the shared id pattern', () => {
    expect('ART001.3'.match(new RegExp(VB_ID_PATTERN.source, 'g'))).toEqual(['ART001.3']);
  });
});

// ── 2. The schema ──────────────────────────────────────────────────────────
describe('normaliseObjectStates', () => {
  it('renumbers ids onto the parent, so a mis-numbered state cannot become a foreign key', () => {
    const out = normaliseObjectStates(
      [{ id: 'ART007.9', name: 'lit', delta: 'a light burns inside' }], 'ART001');
    expect(out[0].id).toBe('ART001.1');
  });

  it('drops rows with no delta, and caps the list', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ name: `s${i}`, delta: `change ${i}` }));
    expect(normaliseObjectStates(many, 'ART001')).toHaveLength(MAX_OBJECT_STATES);
    expect(normaliseObjectStates([{ name: 'empty' }, { name: 'ok', delta: 'x' }], 'ART001')).toHaveLength(1);
  });

  it('yields [] for every non-state shape — the old stored bible included', () => {
    expect(normaliseObjectStates(undefined, 'ART001')).toEqual([]);
    expect(normaliseObjectStates(null, 'ART001')).toEqual([]);
    expect(normaliseObjectStates('lit', 'ART001')).toEqual([]);
    expect(normaliseObjectStates([{ delta: 'x' }], 'not-an-id')).toEqual([]);
  });

  it('objectStates/objectStateFor never throw on the old shape', () => {
    expect(objectStates(PLAIN)).toEqual([]);
    expect(objectStates(null)).toEqual([]);
    expect(objectStateFor(PLAIN, 'ART002')).toBeNull();
    expect(objectStateFor(PLAIN, 'ART002.1')).toBeNull();
    expect(objectStateFor(STATED, 'ART001.3')?.name).toBe('lit');
    expect(objectStateFor(STATED, 'ART001')).toBeNull();
    expect(objectStateFor(STATED, 'ART001.9')).toBeNull();
    expect(objectStateFor(STATED, 'ART002.1')).toBeNull();
  });
});

// ── 3. SITE #3/#4 — matchesEntry, the silent-vanish site ───────────────────
describe('REQUIRED OBJECTS — a dotted handle reaches the block', () => {
  it('a dotted ART id does not vanish from REQUIRED OBJECTS', () => {
    const block = requiredObjectsBlock(promptFor(['ART001.3']));
    expect(block).toContain('hollowed carved vessel');
  });

  it('carries the state as a clause AFTER the type, never inside the bold name', () => {
    const block = requiredObjectsBlock(promptFor(['ART001.3']));
    const line = block.split('\n').find(l => l.includes('hollowed carved vessel'))!;
    expect(line).toMatch(/\*\*[^*]+\*\*\s*\(object\)/);
    // the bold name is the checklist label — the state must not be in it
    const bold = line.match(/\*\*([^*]+)\*\*/)![1];
    expect(bold).not.toMatch(/light|burns|inside/i);
    // ...and the delta rides after the type, beside `size`
    expect(line).toContain('fits in two cupped hands');
    expect(line).toMatch(/light source burns inside/);
  });

  // The cap matches the word budget the authoring templates ask for, so a
  // compliant delta survives whole. The words are numbered so the cut is exact.
  const numbers = (n: number) =>
    ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven',
     'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen'].slice(0, n).join(' ');

  const withDelta = (delta: string) => {
    const vb = bible();
    vb.artifacts[0].states[2].delta = delta;
    const warnings: string[] = [];
    const listener = (level: string, line: string) => { if (level === 'warn') warnings.push(line); };
    addLogListener(listener);
    let line: string;
    try {
      line = requiredObjectsBlock(promptFor(['ART001.3'], vb))
        .split('\n').find(l => l.includes('hollowed carved vessel'))!;
    } finally { removeLogListener(listener); }
    return { line, warnings };
  };

  it('a delta at the template word budget (15) survives untrimmed, and silent', () => {
    const { line, warnings } = withDelta(numbers(15));
    expect(line).toContain('fifteen');
    expect(warnings.filter(w => /State clause/.test(w))).toHaveLength(0);
  });

  it('caps the clause at 15 words so it cannot regrow into a description', () => {
    const { line } = withDelta(numbers(16));
    expect(line).toContain('fifteen');
    expect(line).not.toContain('sixteen');
  });

  it('a cut delta WARNS - the dropped tail may hold what tells one state from another', () => {
    const { warnings } = withDelta(numbers(16));
    const w = warnings.find(x => /State clause/.test(x));
    expect(w).toBeDefined();
    expect(w).toContain('ART001.3');   // which object, which state
    expect(w).toContain('lit');        // the state's name
    expect(w).toContain('16');         // the authored word count
    expect(w).toContain(numbers(16));  // the full authored text, for diagnosis
  });

  it('a BARE id on a stated object emits no clause (the unaltered look)', () => {
    const line = requiredObjectsBlock(promptFor(['ART001']))
      .split('\n').find(l => l.includes('hollowed carved vessel'))!;
    expect(line).not.toMatch(/light source burns/);
    expect(line).toContain('fits in two cupped hands');
  });

  it('the bracket form carries the dotted suffix too — "[ART001.3]"', () => {
    const block = requiredObjectsBlock(promptFor(['carved vessel [ART001.3]']));
    expect(block).toContain('hollowed carved vessel');
  });

  it('BACKWARD COMPAT — a state-less entry is unchanged by all of this', () => {
    const line = requiredObjectsBlock(promptFor(['ART002']))
      .split('\n').find(l => l.includes('woven carrying basket'))!;
    expect(line).toContain('carried in both arms');
    expect(line.match(/—/g) || []).toHaveLength(1); // only the size rider
  });

  it('no raw VB id survives into the prompt', () => {
    const prompt = promptFor(['ART001.3', 'ART002']);
    expect(prompt).not.toMatch(/\bART00\d(?:\.\d)?\b/);
  });
});

// ── 4. SITE #5 — the reference image the page gets ─────────────────────────
describe('getElementReferenceImagesForPage — dotted handles resolve', () => {
  const withCells = () => {
    const vb = bible();
    vb.artifacts[0].states.forEach((s: any, i: number) => { s.referenceImageUrl = `https://r2/state${i + 1}.jpg`; });
    return vb;
  };

  it('a dotted handle still marks its parent as asked-for (the prop keeps a reference)', () => {
    // page 99 is in no appearsInPages — only `askedFor` can admit it
    const refs = getElementReferenceImagesForPage(bible(), 99, 4, ['ART001.3']);
    expect(refs.map((r: any) => r.id)).toContain('ART001');
  });

  it('hands the page the STATE cell of the object\'s one grid', () => {
    const refs = getElementReferenceImagesForPage(withCells(), 7, 4, ['ART001.3']);
    const row = refs.find((r: any) => r.id === 'ART001');
    expect(row.referenceImageUrl).toBe('https://r2/state3.jpg');
    expect(row.stateId).toBe('ART001.3');
    // the id stays the PARENT — one tracked element, one budget slot
    expect(row.id).toBe('ART001');
  });

  it('falls back to the base render when a state has no cell', () => {
    const refs = getElementReferenceImagesForPage(bible(), 7, 4, ['ART001.3']);
    expect(refs.find((r: any) => r.id === 'ART001').referenceImageUrl).toBe('https://r2/base.jpg');
  });

  it('a bare id resolves to the DEFAULT state cell — the first state', () => {
    const refs = getElementReferenceImagesForPage(withCells(), 7, 4, ['ART001']);
    const row = refs.find((r: any) => r.id === 'ART001');
    expect(row.referenceImageUrl).toBe('https://r2/state1.jpg');
    expect(row.stateId).toBe('ART001.1');
  });

  it('a stated object with NO base render still ships its state cell', () => {
    // there is no base cell any more, so this is the real stored shape
    const vb = withCells();
    vb.artifacts[0].referenceImageUrl = null;
    const refs = getElementReferenceImagesForPage(vb, 7, 4, ['ART001.3']);
    expect(refs.find((r: any) => r.id === 'ART001').referenceImageUrl).toBe('https://r2/state3.jpg');
  });

  it('BACKWARD COMPAT — a state-less entry resolves exactly as before', () => {
    const refs = getElementReferenceImagesForPage(bible(), 6, 4, ['ART002']);
    const row = refs.find((r: any) => r.id === 'ART002');
    expect(row.referenceImageUrl).toBe('https://r2/plain.jpg');
    expect(row.stateId).toBeNull();
  });
});

// ── 5. The element budget — one object is one element ─────────────────────
describe('vbElementBudget — a stated object costs ONE slot', () => {
  it('normalises every state handle to the same parent id', () => {
    expect(objectIds(['ART001.1', 'ART001.3', 'ART001'])).toEqual(['ART001']);
    expect(objectIds(['Signpost [ART004.2]'])).toEqual(['ART004']);
    expect(objectIds(['ART001.2', 'ART002'])).toEqual(['ART001', 'ART002']);
  });
});

// ── 6. THE KEYSTONE — one render call per object ──────────────────────────
describe('reference sheet — every state of one object renders in ONE call', () => {
  const el = (id: string, type: string, extra: any = {}) =>
    ({ id, name: `thing ${id}`, type, description: `a ${id} thing`, appearsInPages: [1, 2], ...extra });

  it('expands a stated object into ONE cell per state — no separate base cell', () => {
    const cells = expandElementStateCells({ ...STATED, type: 'artifact' });
    expect(cells.map((c: any) => c.id)).toEqual(['ART001.1', 'ART001.2', 'ART001.3']);
    // each state cell describes the BASE plus only its delta, so the cells
    // cannot disagree about how the object is built
    expect(cells[2].description).toContain('a separate lid that sits back on top');
    expect(cells[2].description).toContain('light source burns inside');
    // distinguishable names for the cell-identification fallback
    expect(new Set(cells.map((c: any) => c.name)).size).toBe(3);
  });

  it('4 states expand to exactly 4 cells — a 2x2 grid, never a 5-cell column', () => {
    const cells = expandElementStateCells({ ...STATED, type: 'artifact', states: MAXED_STATES });
    expect(cells).toHaveLength(4);
    expect(cells.map((c: any) => c.id))
      .toEqual(['ART001.1', 'ART001.2', 'ART001.3', 'ART001.4']);
    expect(cells.some((c: any) => c.id === 'ART001')).toBe(false);
  });

  it('BACKWARD COMPAT — a state-less element expands to itself, untouched', () => {
    const plain = { ...PLAIN, type: 'artifact' };
    expect(expandElementStateCells(plain)).toEqual([plain]);
    expect(expandElementStateCells({ id: 'CHR001', name: 'x', type: 'character' })).toHaveLength(1);
  });

  it('puts the whole object in a SINGLE batch — never split across calls', () => {
    const batches = buildReferenceSheetBatches(
      [{ ...STATED, type: 'artifact' }, el('ART003', 'artifact'), el('ART004', 'artifact'),
       el('ART005', 'artifact'), el('ART006', 'artifact'), el('CHR002', 'character')],
      null, 4,
    );
    const owning = batches.filter((b: any[]) => b.some(c => baseVbId(c.id) === 'ART001'));
    expect(owning).toHaveLength(1);
    expect(owning[0].map((c: any) => c.id)).toEqual(['ART001.1', 'ART001.2', 'ART001.3']);
    // one call per batch, so the whole object is one call
    expect(owning[0].length).toBe(3);
  });

  it('the CEILING renders in ONE call - 4 states = 4 cells = one batch', () => {
    const maxed = { ...STATED, type: 'artifact', states: MAXED_STATES };
    // A multi-state object is routed to a batch of its OWN: `maxPerBatch`
    // chunks only the ordinary elements, so the ceiling is not bounded by it.
    const batches = buildReferenceSheetBatches(
      [maxed, el('ART003', 'artifact'), el('ART004', 'artifact'), el('CHR002', 'character')], null, 4,
    );
    const owning = batches.filter((b: any[]) => b.some(c => baseVbId(c.id) === 'ART001'));
    expect(owning).toHaveLength(1);
    expect(owning[0].map((c: any) => c.id))
      .toEqual(['ART001.1', 'ART001.2', 'ART001.3', 'ART001.4']);
    // and nothing else shares that call
    expect(owning[0]).toHaveLength(4);
  });

  it('normaliseObjectStates admits 4 states, and a 5th is dropped', () => {
    const five = Array.from({ length: 5 }, (_, i) => ({ name: `s${i}`, delta: `change ${i}` }));
    const out = normaliseObjectStates(five, 'ART001');
    expect(out).toHaveLength(4);
    expect(out.map((st: any) => st.id)).toEqual(['ART001.1', 'ART001.2', 'ART001.3', 'ART001.4']);
  });

  it('the batch is built BEFORE any image call, and refuses a split', () => {
    expect(() => assertStateCellsCoLocated([
      [{ id: 'ART001' }, { id: 'ART001.1' }],
      [{ id: 'ART001.2' }],
    ])).toThrow(/single call/);
    expect(() => assertStateCellsCoLocated([[{ id: 'ART001' }, { id: 'ART001.1' }], [{ id: 'ART003' }]]))
      .not.toThrow();
  });

  it('every element still lands in exactly one batch', () => {
    const input = [{ ...STATED, type: 'artifact' }, el('ART003', 'artifact'), el('CHR002', 'character')];
    const ids = buildReferenceSheetBatches(input, null, 4).flat().map((c: any) => c.id);
    expect(new Set(ids.map((i: string) => baseVbId(i)))).toEqual(new Set(['ART001', 'ART003', 'CHR002']));
  });
});

// ── 7. The state cell is written onto its state row ───────────────────────
describe('updateElementReferenceImage — dotted writes land on the state', () => {
  it('writes a state cell onto the state, leaving the base render alone', () => {
    const vb = bible();
    updateElementReferenceImage(vb, 'ART001.2', 'data:image/png;base64,xx', 'https://r2/s2.jpg');
    expect(vb.artifacts[0].states[1].referenceImageUrl).toBe('https://r2/s2.jpg');
    expect(vb.artifacts[0].referenceImageUrl).toBe('https://r2/base.jpg');
  });

  it('BACKWARD COMPAT — a bare id still writes the entry itself', () => {
    const vb = bible();
    updateElementReferenceImage(vb, 'ART002', 'data:image/png;base64,xx', 'https://r2/new.jpg');
    expect(vb.artifacts[1].referenceImageUrl).toBe('https://r2/new.jpg');
    expect(vb.artifacts[1].referenceImageGenerated).toBe(true);
  });

  it('a state the entry does not declare is dropped, not thrown', () => {
    const vb = bible();
    expect(() => updateElementReferenceImage(vb, 'ART002.1', 'data:image/png;base64,xx', 'https://r2/x.jpg'))
      .not.toThrow();
    expect(vb.artifacts[1].referenceImageUrl).toBe('https://r2/plain.jpg');
  });

  it('the R2 key has no second extension, and bare-id keys are unchanged', () => {
    expect(keyForVbReference('s1', 'ART001.2')).toBe('stories/s1/vb/ART001_2.jpg');
    expect(keyForVbReference('s1', 'ART001')).toBe('stories/s1/vb/ART001.jpg');
  });
});
