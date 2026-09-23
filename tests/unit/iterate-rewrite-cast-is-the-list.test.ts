/**
 * THE REWRITE'S LIST IS THE CAST, AND THE REWRITE KEEPS ITS PARENT'S IDS.
 *
 * Staging job_1790100385959_1nitlympp (dragon run 6) p17. The page's v0 brief
 * stages two creatures and no people. The iterate repair's rewrite listed only
 * those two creatures in `characters[]`, but its `wornItems[].owner` rows and a
 * `diagnosis` line named the four boys. The iterate cast was built by
 * getCharactersInScene, whose structured step matched nobody and fell through
 * to a whole-text name scan: all four boys were rendered as references with a
 * HEIGHT ORDER block, and the final presence check raised a false CRITICAL
 * "Levin absent … EXPECTED CAST of 4". The same rewrite moved both creature ids
 * out of `objects[]` (into `characters[]` by name, which REQUIRED OBJECTS does
 * not read), and the hatchling lost its reference cell.
 *
 * Owner decision 2026-09-23: "Trust the rewrite's list."
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require_ = createRequire(import.meta.url);
const { castOfRewrittenBrief, getCharactersInScene, extractSceneMetadata } = require_('../../server/lib/sceneMetadata');
const { carryParentObjects } = require_('../../server/lib/iterateBeat');
const { buildImagePrompt } = require_('../../server/lib/promptBuilders');

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

// The run's roster (names, ages, genders verbatim).
const ROSTER = [
  { name: 'Levin', id: 1786902471660, age: '5', gender: 'male' },
  { name: 'Julian', id: 1786902747333, age: '3', gender: 'male' },
  { name: 'Max', id: 1786904058132, age: '3', gender: 'male' },
  { name: 'Kiaan', id: 1786904387136, age: '3', gender: 'male' },
];

// The run's Visual Bible entries for this page (ids, names, page tables verbatim).
const VB = {
  animals: [
    { id: 'ANI002', name: 'Turi', description: 'waist-high young dragon with rust-red smooth scales', size: 'stands hip-high to an adult', pages: [6, 7, 9, 10, 11, 12, 13, 17] },
    { id: 'ANI003', name: 'Flämmli', description: 'baby dragon as big as a cat with bright orange smooth scales', size: "about as long as an adult's forearm", pages: [17] },
  ],
  artifacts: [
    { id: 'ART002', name: 'large dragon egg', description: 'dragon egg about as big as a human head', pages: [3, 4, 6, 7, 8, 9, 11, 16, 17] },
    { id: 'ART004', name: 'rust-brown quilted gilet', description: 'rust-brown sleeveless front-zip body warmer', pages: [4, 5, 9, 11, 12] },
    { id: 'ART005', name: 'purple hooded sweatshirt', description: 'purple long-sleeve hooded sweatshirt', pages: [4, 9] },
    { id: 'ART006', name: 'forest green fleece jacket', description: 'forest green zip-up fleece jacket', pages: [1, 2, 4, 7, 10, 11, 12, 15, 16] },
  ],
  locations: [{ id: 'LOC002', name: 'Lindenhof square', description: 'square with linden trees and a low stone wall', pages: [17] }],
  secondaryCharacters: [],
};

const PARENT_OBJECTS = ['LOC002.5', 'ART002.2', 'ANI002', 'ANI003'];

// The stored v1 rewrite's metadata, with the fields this bug turns on verbatim:
// a creatures-only `characters[]`, a `diagnosis` naming Julian, and three
// `wornItems[]` rows owned by Kiaan, Max and Levin.
const P17_REWRITE_META = {
  sceneIntent: 'Flämmli stands fully free of the cracked eggshell on wet autumn leaves and sneezes a tiny glowing yellow spark that shoots out of the right side of the image. Turi crouches beside him on the left and watches closely.',
  diagnosis: ["Evaluator: two separate storyRelevant actions (Flämmli sneezing and Julian holding arm out). Cause: previous fix added Julian to frame for the sleeve target, but the plan-line cast is Turi and Flämmli only, and the page shows one action. Fix: remove Julian, keep Flämmli's sneeze as the single action."],
  characters: [
    { name: 'Flämmli', clothing: 'none', position: 'center foreground on wet autumn leaves', depth: 'foreground', looksAt: 'away' },
    { name: 'Turi', clothing: 'none', position: 'left foreground, crouching beside Flämmli', depth: 'foreground', looksAt: 'Flämmli' },
  ],
  shot: 'medium',
  objects: ['LOC002.1', 'ART002.2'],
  interactions: [
    { character: 'Flämmli', object: 'spark', where: 'sneezes a tiny glowing yellow spark out of the right side of the image', action: 'sneezing', hands: false, storyRelevant: true, priority: 'essential' },
  ],
  wornItems: [
    { id: 'ART004', owner: 'Kiaan', state: 'worn', location: "on Kiaan's torso" },
    { id: 'ART005', owner: 'Max', state: 'worn', location: "on Max's torso" },
    { id: 'ART006', owner: 'Levin', state: 'worn', location: "on Levin's torso" },
  ],
};

const PROSE = 'Flämmli — a baby dragon as big as a cat — stands fully upright on the wet autumn leaves, free of the cracked slate-grey eggshell. Turi crouches low on the left, his snout close to Flämmli. Flämmli sneezes; a single tiny glowing yellow spark shoots out of frame to the right.';
const brief = (meta: any) => `${PROSE}\n\n---METADATA---\n${JSON.stringify(meta, null, 2)}`;
const names = (cast: any[] | null) => (cast || []).map(c => c.name);

describe('the rewrite\'s characters[] is the cast', () => {
  it('p17 REGRESSION — a creatures-only list with boys in a garment and a diagnosis line is NO people', () => {
    expect(castOfRewrittenBrief(brief(P17_REWRITE_META), ROSTER)).toEqual([]);
  });

  it('CONTROL — the old derivation reproduces the defect on the same brief', () => {
    // Pins that the fixture really is the failing shape: the name scan finds
    // all four boys, none of whom the rewrite put in the picture.
    expect(names(getCharactersInScene(brief(P17_REWRITE_META), ROSTER)).sort()).toEqual(['Julian', 'Kiaan', 'Levin', 'Max']);
  });

  it('an EMPTY list is no people, not "no list given"', () => {
    expect(castOfRewrittenBrief(brief({ ...P17_REWRITE_META, characters: [] }), ROSTER)).toEqual([]);
  });

  it('a list naming roster people is exactly those people, in roster order', () => {
    const meta = { ...P17_REWRITE_META, characters: [...P17_REWRITE_META.characters, { name: 'Max', clothing: 'standard' }, { name: 'Levin', clothing: 'standard' }] };
    expect(names(castOfRewrittenBrief(brief(meta), ROSTER))).toEqual(['Levin', 'Max']);
  });

  it('a brief with NO characters array is "did not say" (null), never "nobody"', () => {
    // Without the key the metadata does not parse and the prose-only recovery
    // fabricates `characters: []`; that must not read as a declared empty cast.
    const { characters, ...noList } = P17_REWRITE_META;
    expect(extractSceneMetadata(brief(noList)).isRecovered).toBe(true);
    expect(castOfRewrittenBrief(brief(noList), ROSTER)).toBeNull();
    expect(castOfRewrittenBrief('Three boys run across the square.', ROSTER)).toBeNull();
  });

  it('the p17 cast produces no HEIGHT ORDER, AGE block or reference-card legend for the boys', () => {
    const d = brief({ ...P17_REWRITE_META, objects: carryParentObjects({ rewriteObjects: P17_REWRITE_META.objects, parentObjects: PARENT_OBJECTS }).objects });
    const cast = castOfRewrittenBrief(d, ROSTER);
    const prompt = buildImagePrompt(d, { language: 'de-ch', artStyle: 'watercolor', characters: ROSTER, layout: { textInImage: true } }, cast, VB, 17, [], {}) as string;
    expect(prompt).not.toContain('HEIGHT ORDER');
    for (const boy of ['Levin', 'Julian', 'Max', 'Kiaan']) expect(prompt).not.toContain(boy);
  });

  it('CONTROL — the old cast put all four boys into HEIGHT ORDER', () => {
    const d = brief(P17_REWRITE_META);
    const cast = getCharactersInScene(d, ROSTER);
    const prompt = buildImagePrompt(d, { language: 'de-ch', artStyle: 'watercolor', characters: ROSTER, layout: { textInImage: true } }, cast, VB, 17, [], {}) as string;
    expect(prompt).toContain('HEIGHT ORDER');
  });

  it('the iterate call site builds its cast from the rewrite\'s list and never name-scans', () => {
    const src = read('server/lib/images.js');
    const start = src.indexOf('async function iteratePageCore(');
    const body = src.slice(start, src.indexOf('\nasync function ', start + 10));
    expect(body).toContain('const sceneCharacters = castOfRewrittenBrief(newSceneDescription, characters);');
    expect(body).not.toMatch(/getCharactersInScene\(/);
  });
});

describe('the rewrite keeps its parent\'s creature and object ids in objects[]', () => {
  it('p17 REGRESSION — both creature ids come back; the rewrite\'s facets stand', () => {
    const out = carryParentObjects({ rewriteObjects: P17_REWRITE_META.objects, parentObjects: PARENT_OBJECTS });
    expect(out.objects).toEqual(['LOC002.1', 'ART002.2', 'ANI002', 'ANI003']);
    expect(out.carried).toEqual(['ANI002', 'ANI003']);
  });

  it('with the ids carried, REQUIRED OBJECTS lists both creatures again', () => {
    const before = buildImagePrompt(brief(P17_REWRITE_META), { language: 'de-ch', artStyle: 'watercolor', characters: ROSTER, layout: { textInImage: true } }, [], VB, 17, [], {}) as string;
    const carried = { ...P17_REWRITE_META, objects: carryParentObjects({ rewriteObjects: P17_REWRITE_META.objects, parentObjects: PARENT_OBJECTS }).objects };
    const after = buildImagePrompt(brief(carried), { language: 'de-ch', artStyle: 'watercolor', characters: ROSTER, layout: { textInImage: true } }, [], VB, 17, [], {}) as string;
    const block = (p: string) => { const i = p.indexOf('REQUIRED OBJECTS'); return i < 0 ? '' : p.slice(i, i + 900); };
    expect(block(before)).not.toContain('**Flämmli** (animal)');
    expect(block(after)).toContain('**Turi** (animal)');
    expect(block(after)).toContain('**Flämmli** (animal)');
  });

  it('the carried list round-trips through the brief metadata parser', () => {
    const carried = carryParentObjects({ rewriteObjects: P17_REWRITE_META.objects, parentObjects: PARENT_OBJECTS }).objects;
    expect(extractSceneMetadata(brief({ ...P17_REWRITE_META, objects: carried })).objects).toEqual(['LOC002.1', 'ART002.2', 'ANI002', 'ANI003']);
  });

  it('free-text parent citations are never carried as pseudo-ids', () => {
    const out = carryParentObjects({ rewriteObjects: ['ART002'], parentObjects: ['a pile of leaves', 'ART002.2', 'ANI003'] });
    expect(out.objects).toEqual(['ART002', 'ANI003']);
  });
});
