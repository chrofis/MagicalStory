/**
 * Staging dragon run job_1790539784661_6mjcny1c7 (owner decisions 2026-09-28):
 *   2. a creature's body parts get their own authored field, `anatomy`, which
 *      reaches the description every reference cell paints and every cell gate reads;
 *   3. the state-consistency cell gate treats each listed state change as
 *      intended and runs on MODEL_DEFAULTS.vbStateCellGate;
 *   4. the `cute` creature tone governs a GROWN creature's face and expression
 *      only — its body and size stay adult. The grown bands are the code's own.
 * Pins behaviour; the wording lives in code.
 * see docs/decisions.md 2026-09-28
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';

import { trialWriterPrompt } from './helpers/trialWriterPrompt';
const req = createRequire(import.meta.url);
const fs = req('fs');
const path = req('path');
const VB = req('../../server/lib/visualBible');
const PB = req('../../server/lib/promptBuilders');
const RS = req('../../server/lib/referenceSheets');
const { MODEL_DEFAULTS } = req('../../server/config/models');
const { UnifiedStoryParser } = req('../../server/lib/outlineParser/unified.js');
const { loadPromptTemplates } = req('../../server/services/prompts');
const ROOT = path.resolve(__dirname, '../..');

const DRAGON = {
  id: 'ANI001', name: 'Ember', pages: [1, 2], scaleClass: 'twice-adult-height', species: 'dragon',
  coloring: 'red scales', anatomy: 'two large leathery wings, four legs, one long tail, two short horns',
  features: 'a golden scale on the chest',
};

describe('2 — anatomy: one authored slot, into the entry description', () => {
  it('the description a cell paints carries the anatomy, after the maturity and the colouring', () => {
    const d = VB.buildAnimalDescription(DRAGON);
    expect(d).toContain(DRAGON.anatomy);
    expect(d.startsWith('a fully grown adult dragon')).toBe(true);
    expect(d.indexOf(DRAGON.coloring)).toBeLessThan(d.indexOf(DRAGON.anatomy));
    expect(VB.buildAnimalDescription({ ...DRAGON, anatomy: undefined })).not.toContain('wings');
  });
  it('the beats parse path (the Art Director transcript) keeps it in the description', () => {
    const body = ['---VISUAL BIBLE---', '```json', JSON.stringify({ secondaryCharacters: [], animals: [DRAGON], artifacts: [], locations: [], vehicles: [], clothing: [] }), '```', ''].join('\n');
    const vb = new UnifiedStoryParser(body).extractVisualBible();
    expect(vb.animals[0].description).toContain(DRAGON.anatomy);
  });
  it('the element cell gate judges the cell against it', () => {
    const entry = { ...DRAGON, description: VB.buildAnimalDescription(DRAGON) };
    expect(RS.elementCellGatePrompt(entry, 'watercolor')).toContain(DRAGON.anatomy);
  });
  describe('both Visual Bible authoring sites fill the same spec', () => {
    const SITES = ['prompts/visual-bible.txt', 'prompts/story-trial-arc.txt'];
    let built: Record<string, string> = {};
    beforeAll(async () => {
      await loadPromptTemplates();
      built = {
        all: String(PB.buildVisualBibleCallPrompt({ title: 'T', language: 'en', characters: [{ id: 'c1', name: 'Mia', age: 3, gender: 'female', isMain: true }], mainCharacters: ['c1'] },
          [{ pageNumber: 1, plan: 'wide — Mia — Mia waves at the creature — x' }], {})),
        trial: String(trialWriterPrompt({ language: 'en', storyCategory: 'adventure', storyTheme: 'adventure', storyDetails: 'a dragon', trialMode: true,
          characters: [{ name: 'Mia', age: 3, gender: 'female', isMain: true }] }, 5)),
      };
    });
    it('declares the placeholder and hand-types no copy', () => {
      for (const rel of SITES) {
        const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
        expect(text.includes('"anatomy": "{ANIMAL_ANATOMY_SPEC}"'), rel).toBe(true);
        expect(text.includes(VB.ANIMAL_ANATOMY_SPEC), rel).toBe(false);
      }
      expect(VB.ANIMAL_ANATOMY_SPEC).not.toContain('"');            // a JSON string value in the schema
    });
    it('fills it into both built prompts', () => {
      for (const [site, p] of Object.entries(built)) {
        expect(p.includes(VB.ANIMAL_ANATOMY_SPEC), site).toBe(true);
        expect(p, site).not.toContain('{ANIMAL_ANATOMY_SPEC}');
      }
    });
  });
});

describe('3 — the state-consistency gate: listed changes are intended, on its own model', () => {
  const parent = { name: 'Ember', description: 'a fully grown adult dragon. red scales' };
  const cells = [{ stateName: 'unaltered', delta: 'vibrant red scales' }, { stateName: 'cold', delta: 'dull grey scales' }];
  it('the question tells the judge each listed change is intended and outranks the description in its cell', () => {
    const p = RS.stateCellsGatePrompt(parent, cells);
    expect(p).toContain('Each listed change is intended');
    expect(p).toMatch(/the state wins for that cell/);
    expect(p).toContain('2. cold: dull grey scales');
    expect(p).not.toMatch(/same shape, build, material and colour/);   // the clause that failed a named colour change
  });

  const urls: string[] = [];
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; urls.length = 0; vi.unstubAllEnvs(); });
  const stubGemini = () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    globalThis.fetch = (async (url: any) => {
      urls.push(String(url));
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"ok": true, "reason": "same object"}' }] } }] }) };
    }) as any;
  };
  it('the state gate runs on MODEL_DEFAULTS.vbStateCellGate; the element gate runs on MODEL_DEFAULTS.vbElementCellGate (flash since 2026-10-08)', async () => {
    stubGemini();
    await RS.checkStateCellsConsistency(['/9j/AAA', '/9j/BBB'], parent, cells);
    await RS.checkElementCellRender('/9j/AAA', { ...parent, type: 'animal' }, 'watercolor');
    expect(MODEL_DEFAULTS.vbStateCellGate).toBe('gemini-2.5-flash');
    expect(urls[0]).toContain(`/models/${MODEL_DEFAULTS.vbStateCellGate}:generateContent`);
    expect(MODEL_DEFAULTS.vbElementCellGate).toBe('gemini-2.5-flash');
    expect(urls[1]).toContain(`/models/${MODEL_DEFAULTS.vbElementCellGate}:generateContent`);
  });
});

describe('4 — cute tone: a grown creature keeps its adult body; the tone is its face', () => {
  const cute = () => PB.buildCreatureToneSection({ characters: [{ name: 'A', age: '3', isMain: true }] });
  it('names the grown bands from the code set that also gives the entry its maturity', () => {
    const t = cute();
    for (const band of VB.GROWN_CREATURE_SCALE_CLASSES) expect(t).toContain(band);
    expect(t).toMatch(/the cute tone governs its face only/);
    expect(t).toMatch(/keeps a grown adult's build, body proportions and full size/);
  });
  it('keeps the rounded body and the child-sized lean for creatures smaller than a grown-up only', () => {
    const t = cute();
    const smaller = t.indexOf('A creature smaller than a grown-up');
    expect(smaller).toBeGreaterThan(-1);
    expect(t.indexOf('rounded forms throughout')).toBeGreaterThan(smaller);
    expect(t.indexOf("near the child's own")).toBeGreaterThan(smaller);
    expect(t).toContain('may tower gently over a child');                 // the 2026-09-26 relaxation stays
  });
  it('leaves the other two levels untouched', () => {
    const five = PB.buildCreatureToneSection({ characters: [{ name: 'A', age: '5', isMain: true }] });
    const eight = PB.buildCreatureToneSection({ characters: [{ name: 'A', age: '8', isMain: true }] });
    expect(five).not.toContain('face and expression only');
    expect(eight).not.toContain('face and expression only');
  });
});

describe('2026-10-08 — a grown creature whose species states a mature age still gets the build clause', () => {
  // job_1791489793707_2ir6nl5kw ANI001 "Old Dragon", twice-adult-height: the lead was skipped
  // because "old" counts as a stated age, and the cell came back a juvenile.
  const OLD = { ...DRAGON, species: 'Old Dragon' };
  it('"Old Dragon" at a grown band states adult body proportions', () => {
    expect(VB.buildAnimalDescription(OLD).startsWith('Old Dragon with adult body proportions.')).toBe(true);
  });
  it('a YOUNG species word at a grown band is left alone', () => {
    expect(VB.buildAnimalDescription({ ...DRAGON, species: 'baby giant' }).startsWith('baby giant.')).toBe(true);
  });
  it('the element gate asks about the stated age/build and about extra material', () => {
    const q = RS.elementCellGatePrompt({ ...OLD, description: VB.buildAnimalDescription(OLD) }, 'watercolor');
    expect(q).toMatch(/age or build match/);
    expect(q).toMatch(/nothing else/);
  });
  it('the cell prompt states the mature-body and single-material rules', () => {
    const txt = fs.readFileSync(path.join(ROOT, 'prompts/reference-sheet.txt'), 'utf8');
    expect(txt).toMatch(/grown, adult or old has a mature body/);
    expect(txt).toMatch(/Only the material the description names is drawn/);
  });
});
