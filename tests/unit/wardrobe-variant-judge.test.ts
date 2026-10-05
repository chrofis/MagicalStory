/**
 * THE OFF-GARMENT SHEET IS JUDGED BY THE JUDGE THAT APPROVED ITS BASE
 * (owner, 2026-10-04; tasks/bugs.json wardrobe-variant-judged-by-row-judges).
 *
 * Staging job_1791040103540_atbttop6w: Kiaan's jacket-off sheet was redressed
 * twice and rejected twice at 1/10 by evaluateSheetSplit — the Pass-1 row
 * judges, which the approved base sheet itself fails (crop, outfit). No off
 * sheet was stored and p11/p12/p16 were drawn from the jacket-wearing sheet.
 * Pinned:
 *   1  the variant gate is the Pass-2 style judge (the base's own Pass-1 sheet as
 *      Image 2) plus one garment-gone check per removed garment
 *      (evaluateVariantSheet; the TASK 10 it first shipped with was read as an
 *      exemption and is gone);
 *      evaluateSheetSplit is gone from the variant path;
 *   2  generator and critic state one rule, GARMENT_OFF_SHEET_RULE;
 *   3  costumed sheets get variants: derivation, projection, both resolvers;
 *   4  a page with no off sheet is recorded (off_sheet_missing).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const cjs = createRequire(import.meta.url);
const SHEET = cjs('../../server/lib/character2x4Sheet.js');
const WV = cjs('../../server/lib/wardrobeVariants.js');
const SA = cjs('../../server/lib/storyAvatars.js');
const NE = cjs('../../server/lib/notEvaluated.js');
const { getStyledAvatarForClothing } = cjs('../../server/lib/entityConsistency.js');
const { loadPromptTemplates, PROMPT_TEMPLATES } = cjs('../../server/services/prompts.js');

const SRC = fs.readFileSync(path.join(__dirname, '../../server/lib/character2x4Sheet.js'), 'utf8').replace(/\r\n/g, '\n');
const fnText = (name: string) => {
  const s = SRC.indexOf(`async function ${name}(`);
  return SRC.slice(s, SRC.indexOf('\n}\n', s));
};

describe('1 — the variant is judged by the pass-2 style judge plus a garment-gone task', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('redressSheetVariant calls evaluateVariantSheet (style judge pass 2 + per-garment checks) with the base Pass-1 sheet and the removed garments, never the row judges', () => {
    const body = fnText('redressSheetVariant');
    expect(body).toMatch(/evaluateVariantSheet\(result\.imageData, \{\s*facePhoto, realisticSheet, artStyle/);
    expect(body).toMatch(/removedGarments: items/);
    expect(body).not.toMatch(/evaluateSheetSplit/);
  });

  it('no Pass-1 sheet or face photo to judge against = no variant, before any paid edit', async () => {
    const prev = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = prev || 'test-key';
    try {
      const out = await SHEET.redressSheetVariant('data:image/jpeg;base64,AAAA', {
        characterName: 'A', authoredWardrobe: 'jacket off; shirt outermost', removedItems: ['jacket'],
        facePhoto: 'data:image/jpeg;base64,BBBB', realisticSheet: null,
      });
      expect(out).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = prev;
    }
  });

  it('the style judge carries no garment-off task; each removed garment is its own one-question check', () => {
    const t = String(PROMPT_TEMPLATES.sheet2x4StyleEval);
    expect(t).not.toMatch(/TASK 10|removedScore|GARMENTS_REMOVED/);
    expect(SHEET.garmentsRemovedTask).toBeUndefined();
    const c = String(PROMPT_TEMPLATES.sheetGarmentGoneCheck);
    expect(c).toContain('is {GARMENT} visible');
    expect(c).toContain('{PARTS}');
  });

  it('the generator states the same rule (generator ↔ critic)', () => {
    const p = SHEET.buildRedressPrompt('jacket off; shirt outermost', ['autumn jacket']);
    expect(p).toContain('Taken off: autumn jacket.');
    expect(p).toContain(SHEET.GARMENT_OFF_SHEET_RULE);
  });
});

describe('3 — costumed sheets get off variants too', () => {
  const VB = { clothing: [{ id: 'CLO001', name: 'pirate coat', wornBy: 'Mia', description: 'a grey wool pirate coat' }] };
  const REQS = { Mia: { costumed: { used: true, costume: 'pirate', description: 'A white blouse; a grey wool pirate coat; black trousers; boots.' }, standard: { used: false } } };
  const off = { id: 'CLO001', owner: 'Mia', state: 'off', wearer: null, location: 'over the rail', redressNote: 'The coat is off; the white blouse is outermost.', keptGarments: [{ type: 'blouse', colour: 'white', details: '' }] };

  it('derivation asks for costumed--off:<ids> for a costumed character', () => {
    const { requirements } = WV.deriveWardrobeVariantRequirements({
      visualBible: VB, scenes: [{ pageNumber: 4, sceneMetadata: { characters: ['Mia'], wornItems: [off] } }],
      clothingRequirements: REQS, characters: [{ name: 'Mia' }],
    });
    expect(requirements.map((r: any) => `${r.characterNames[0]}:${r.clothingCategory}:${r.baseCategory}`))
      .toEqual(['Mia:costumed--off:CLO001:costumed']);
  });

  it("the page's own declared clothing decides the base category", () => {
    const reqs = { Mia: { costumed: { used: true, description: 'x' }, standard: { used: true, description: 'A coat; jeans.' } } };
    const { requirements } = WV.deriveWardrobeVariantRequirements({
      visualBible: VB,
      scenes: [{ pageNumber: 2, sceneMetadata: { characters: ['Mia'], characterClothing: { Mia: 'standard' }, wornItems: [off] } }],
      clothingRequirements: reqs, characters: [{ name: 'Mia' }],
    });
    expect(requirements.map((r: any) => r.clothingCategory)).toEqual(['standard--off:CLO001']);
  });

  it('the story projection keeps the costumed off sheet under the bare costumed slot key', () => {
    const out = SA.projectStoryCharacterAvatars([{ name: 'Mia', avatars: { styledAvatars: { watercolor: {
      costumed: { pirate: 'https://x/costume.jpg' }, 'costumed--off:CLO001': 'https://x/off.jpg',
    } } } }], 'watercolor');
    expect(out.Mia).toEqual({ costumed: 'https://x/costume.jpg', 'costumed--off:CLO001': 'https://x/off.jpg' });
  });

  it('the page resolver serves it, and stamps the missing-sheet marker when there is none', () => {
    const ref: any = { name: 'Mia', clothingCategory: 'costumed:pirate', wornOffIds: ['CLO001'] };
    const hit = SA.resolveSheetForRef({ costumed: 'https://x/costume.jpg', 'costumed--off:CLO001': 'https://x/off.jpg' }, ref);
    expect(hit.slotKey).toBe('costumed--off:CLO001');
    const ref2: any = { name: 'Mia', clothingCategory: 'costumed:pirate', wornOffIds: ['CLO001'] };
    const miss = SA.resolveSheetForRef({ costumed: 'https://x/costume.jpg' }, ref2);
    expect(miss.uri).toBe('https://x/costume.jpg');
    expect(ref2.wornStateFallback).toEqual({ offIds: ['CLO001'], wanted: 'costumed--off:CLO001' });
  });

  it('the repair-side lookup serves the costumed off sheet before the costume', async () => {
    const character = { name: 'Mia', avatars: { styledAvatars: { watercolor: {
      costumed: { pirate: 'data:image/jpeg;base64,COSTUME' }, 'costumed--off:CLO001': 'data:image/jpeg;base64,OFF',
    } } } };
    expect(await getStyledAvatarForClothing(character, 'watercolor', 'costumed--off:CLO001')).toBe('data:image/jpeg;base64,OFF');
    expect(await getStyledAvatarForClothing(character, 'watercolor', 'costumed')).toBe('data:image/jpeg;base64,COSTUME');
  });
});

describe('4 — a page with no off sheet is recorded', () => {
  it('collectNotEvaluated rolls the marker into off_sheet_missing for that page', () => {
    const report = NE.collectNotEvaluated([
      { pageNumber: 12, referencePhotos: [{ name: 'Kiaan', wornStateFallback: { offIds: ['CLO001'], wanted: 'styled-standard--off:CLO001' } }] },
      { pageNumber: 13, referencePhotos: [{ name: 'Kiaan' }] },
    ]);
    expect(report.pages).toHaveLength(1);
    expect(report.pages[0]).toMatchObject({ pageNumber: 12, entries: [{ dimension: 'wardrobe_state_reference', reason: 'off_sheet_missing' }] });
    expect(report.pages[0].entries[0].detail).toContain('styled-standard--off:CLO001');
  });
});
