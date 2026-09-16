/**
 * `scaleClass` — the authored scale band on every Visual Bible element, and
 * THE SINGLE SOURCE OF SCALE TRUTH (owner, 2026-09-15, reversing the
 * machine-facing-only design shipped the same morning).
 *
 * WHY THIS EXISTS. On job_1789420511893_zly5rcdej page 8 a chestnut whose
 * `size` correctly read "the size of a thumb" rendered football-sized as the
 * nearest object to camera: a correct free-text size changed nothing, because
 * nothing in CODE read a sentence. The corpus of every stored bible on staging
 * and production (168 sized entries, 151 distinct strings) said the rest: 14
 * carried metric units the prompt banned, 12 were German or Italian where the
 * prompt asked for English, and ~10 were bare adjectives ("gross", "klein",
 * "mittelgross, elegant") stating no scale at all. Free text is unverifiable
 * and drifts; a closed band is always present and renders one canonical phrase.
 *
 * Four invariants are pinned here, and they are behaviour, not wording:
 *   1. the WHITELIST parse admits the field on all five element collections
 *      (an unlisted field is dropped silently — that is how VEH001 lost its
 *      size entirely);
 *   2. an unknown value becomes `null` and is NEVER coerced to a nearest band,
 *      while a LEGACY six-value token resolves onto the granular list so a
 *      bible authored on 2026-09-15 stays routable;
 *   3. the band's PHRASE reaches the image model and the raw token never does;
 *   4. a bible stored before the enum falls back to its free-text `size` — the
 *      capability decisions.md 2026-09-06/09/11/14 measured may not be lost.
 */
import { describe, it, expect, vi } from 'vitest';

// @ts-ignore - CommonJS
const VB = require('../../server/lib/visualBible');
// @ts-ignore - CommonJS
const PB = require('../../server/lib/promptBuilders');
// @ts-ignore - CommonJS
const { log } = require('../../server/utils/logger');

const { parseVisualBible, parseNewVisualBibleEntries, normaliseScaleClass, resolveScaleClass,
        scalePhrase, elementScaleNote, SCALE_CLASSES, SCALE_PHRASES, SCALE_CLASS_SPEC, LEGACY_SCALE_CLASSES,
        isLargeScaleClass } = VB;

const bible = (data: any) =>
  '---VISUAL BIBLE---\n```json\n' + JSON.stringify(data) + '\n```';

const FULL = {
  secondaryCharacters: [{ id: 'CHR001', name: 'Tobias', pages: [1], scaleClass: 'head' }],
  animals: [{ id: 'ANI001', name: 'Fünkli', pages: [1], species: 'cat', scaleClass: 'knee' }],
  artifacts: [{
    id: 'ART001', label: 'roasted chestnut', name: 'roasted chestnut', pages: [1],
    type: 'food', scaleClass: 'fingertip',
    description: 'a split roasted chestnut, glossy brown'
  }],
  locations: [{ id: 'LOC001', name: 'the quay', pages: [1], setting: 'outdoor', scaleClass: 'landmark' }],
  vehicles: [{
    id: 'VEH001', label: 'wooden sailing ship', name: 'wooden sailing ship', pages: [1],
    colorAndDetails: 'a three-masted hull in tarred oak', signatureElement: 'a red pennant',
    scaleClass: 'house'
  }],
};

describe('scaleClass — the closed enum', () => {
  it('is the thirteen bands, ascending, each with exactly one render phrase', () => {
    expect(SCALE_CLASSES).toEqual([
      'fingertip', 'palm', 'hand', 'melon', 'forearm', 'arm',
      'knee', 'hip', 'chest', 'adult', 'double', 'house', 'landmark'
    ]);
    // ONE source of truth: the token list IS the phrase map's key list, so a
    // band can never exist without a wording or carry two of them.
    expect(Object.keys(SCALE_PHRASES)).toEqual(SCALE_CLASSES);
    for (const band of SCALE_CLASSES) {
      expect(typeof SCALE_PHRASES[band], band).toBe('string');
      expect(SCALE_PHRASES[band].length, band).toBeGreaterThan(8);
    }
    // every phrase is distinguishable — no two bands read the same
    expect(new Set(Object.values(SCALE_PHRASES)).size).toBe(SCALE_CLASSES.length);
  });

  /**
   * THE 2026-09-16 DEFECT, PINNED. The ladder mixed a SIZE comparison
   * (forearm/arm: "as big as that limb") with a HEIGHT comparison
   * (knee/hip/chest: "reaches that part") under one body-part vocabulary, and
   * collided on `head`: the writer of job_1789506283204_3kxqshifx classed a
   * football-sized dragon egg `head` meaning head-SIZED and every page was
   * told the egg was as big as a standing adult.
   *
   * These are BEHAVIOURAL, not wording, assertions: a small object's band must
   * render a phrase that never claims adult stature, and the adult-height band
   * must render a phrase that does.
   */
  it('a head-sized object has a band of its own, and it is not an adult-height phrase', () => {
    expect(SCALE_CLASSES).toContain('melon');
    const melon = scalePhrase('melon') as string;
    expect(melon).toMatch(/head/i);           // it is the head-SIZED band
    expect(melon).not.toMatch(/tall|stands|high/i);
    // and it sorts below the limb bands, above the hand bands
    expect(SCALE_CLASSES.indexOf('melon')).toBeGreaterThan(SCALE_CLASSES.indexOf('hand'));
    expect(SCALE_CLASSES.indexOf('melon')).toBeLessThan(SCALE_CLASSES.indexOf('forearm'));
  });

  it('every SIZE band says size and every HEIGHT band says height', () => {
    const SIZE = ['fingertip', 'palm', 'hand', 'melon', 'forearm', 'arm'];
    const HEIGHT = ['knee', 'hip', 'chest', 'adult', 'double', 'house', 'landmark'];
    expect([...SIZE, ...HEIGHT]).toEqual(SCALE_CLASSES);
    for (const band of SIZE) {
      // a size band never claims stature — that is the sentence that oversized
      // the egg on four pages
      expect(SCALE_PHRASES[band], band).not.toMatch(/tall|stands .*-high|adults high/i);
    }
    for (const band of HEIGHT) {
      expect(SCALE_PHRASES[band], band).toMatch(/tall|high|height|horizon/i);
    }
    // the top of the height ladder is named for the adult, never for a body
    // part that doubles as a size referent
    expect(SCALE_CLASSES).not.toContain('head');
    expect(scalePhrase('adult')).toMatch(/as tall as a standing adult/);
  });

  it('states every band against a standing adult, never in units', () => {
    // An illustration has no absolute scale: a metric phrase would be a number
    // the renderer cannot act on, which is half of what the free-text corpus
    // got wrong.
    for (const band of SCALE_CLASSES) {
      expect(SCALE_PHRASES[band], band).not.toMatch(/\d|\bcm\b|\bmetre|\bmeter|\binch|\bfoot\b|\bfeet\b/i);
    }
  });

  it('lowercases and trims an authored value', () => {
    expect(normaliseScaleClass('  Forearm ', 'ART001')).toBe('forearm');
    expect(normaliseScaleClass('HAND', 'ART001')).toBe('hand');
    expect(normaliseScaleClass('Landmark', 'LOC001')).toBe('landmark');
  });

  it('never coerces an unknown token to a nearest band', () => {
    // Adjectives name no band, and neither does a near-miss spelling. Every
    // string here is one the stored corpus actually contained as a `size`.
    for (const bad of ['huge', 'massive', 'tiny', 'ship', 'hand-sized', 'houses', 'gross', 'mittelgross', '']) {
      expect(normaliseScaleClass(bad, 'ART001'), bad).toBeNull();
    }
  });

  it('returns null rather than throwing for a missing or non-string value', () => {
    expect(normaliseScaleClass(undefined, 'ART001')).toBeNull();
    expect(normaliseScaleClass(null, 'ART001')).toBeNull();
    expect(normaliseScaleClass(3, 'ART001')).toBeNull();
    expect(normaliseScaleClass({}, 'ART001')).toBeNull();
  });
});

/**
 * BACKWARD COMPATIBILITY — bibles authored on 2026-09-15 under the morning's
 * six-value enum are stored, and repair / iterate / regeneration / cover paths
 * re-read them months later. An unmapped token would make a stored element
 * unroutable, so each legacy band resolves onto the granular list.
 */
describe('scaleClass — the retired six-value enum still resolves', () => {
  it('maps each legacy band onto exactly one granular band', () => {
    expect(LEGACY_SCALE_CLASSES).toEqual({
      person: 'hip', vehicle: 'double', building: 'house', landscape: 'landmark', head: 'adult'
    });
    // `hand` and `arm` survived the rewrite under their own names
    expect(resolveScaleClass('hand')).toBe('hand');
    expect(resolveScaleClass('arm')).toBe('arm');
    for (const [legacy, granular] of Object.entries(LEGACY_SCALE_CLASSES)) {
      expect(resolveScaleClass(legacy), legacy).toBe(granular);
      expect(resolveScaleClass(String(legacy).toUpperCase()), legacy).toBe(granular);
      expect(scalePhrase(legacy), legacy).toBe(SCALE_PHRASES[granular as string]);
    }
  });

  it("a stored `head` keeps the phrase it has always rendered, never a reinterpretation", () => {
    // An author who meant head-sized cannot be told apart from one who meant
    // adult-height, so the stored token is NOT re-pointed at `melon`.
    expect(resolveScaleClass('head')).toBe('adult');
    expect(scalePhrase('head')).toBe(SCALE_PHRASES.adult);
  });

  it('leaves plate routing unchanged for a legacy-classed element', () => {
    // The whole point of the mapping: the three large legacy bands are exactly
    // the three large granular bands, so nothing already stored changes route.
    for (const large of ['vehicle', 'building', 'landscape', 'double', 'house', 'landmark']) {
      expect(isLargeScaleClass(large), large).toBe(true);
    }
    for (const small of ['hand', 'arm', 'person', 'fingertip', 'palm', 'melon', 'forearm', 'knee', 'hip', 'chest', 'head', 'adult']) {
      expect(isLargeScaleClass(small), small).toBe(false);
    }
    expect(isLargeScaleClass(null)).toBe(false);
    expect(isLargeScaleClass('enormous')).toBe(false);
  });
});

describe('scaleClass — the Visual Bible whitelist parse', () => {
  it('admits the field on all five element collections', () => {
    const vb = parseVisualBible(bible(FULL));
    expect(vb.secondaryCharacters[0].scaleClass).toBe('adult'); // stored 'head', the legacy alias
    expect(vb.animals[0].scaleClass).toBe('knee');
    expect(vb.artifacts[0].scaleClass).toBe('fingertip');
    expect(vb.locations[0].scaleClass).toBe('landmark');
    expect(vb.vehicles[0].scaleClass).toBe('house');
  });

  it('admits it on entries the story text adds mid-book too', () => {
    const section = '---NEW VISUAL BIBLE ENTRIES---\n```json\n' + JSON.stringify({
      artifacts: [{ id: 'ART009', name: 'iron key', pages: [5], scaleClass: 'palm', description: 'a key' }],
      vehicles: [{ id: 'VEH009', name: 'hay cart', pages: [5], colorAndDetails: 'a cart', signatureElement: 'a wheel', scaleClass: 'double' }],
    }) + '\n```';
    const entries = parseNewVisualBibleEntries(section);
    expect(entries.artifacts[0].scaleClass).toBe('palm');
    expect(entries.vehicles[0].scaleClass).toBe('double');
  });

  it('leaves a stored bible that predates the field at null, not at a guess', () => {
    const legacy = JSON.parse(JSON.stringify(FULL));
    for (const coll of ['secondaryCharacters', 'animals', 'artifacts', 'locations', 'vehicles']) {
      for (const e of (legacy as any)[coll]) delete e.scaleClass;
    }
    legacy.artifacts[0].size = 'the size of a thumb';
    const vb = parseVisualBible(bible(legacy));
    expect(vb.artifacts[0].scaleClass).toBeNull();
    expect(vb.vehicles[0].scaleClass).toBeNull();
    expect(vb.locations[0].scaleClass).toBeNull();
    // and the entry is otherwise intact — a missing class is not an error, and
    // the stored free-text size is NOT stripped from existing data
    expect(vb.artifacts[0].size).toBe('the size of a thumb');
    expect(vb.vehicles[0].name).toBe('wooden sailing ship');
  });

  it('drops an unknown value to null and says so in the log', () => {
    const spy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    try {
      const bad = JSON.parse(JSON.stringify(FULL));
      bad.artifacts[0].scaleClass = 'enormous';
      const vb = parseVisualBible(bible(bad));
      expect(vb.artifacts[0].scaleClass).toBeNull();
      const said = spy.mock.calls.map(c => String(c[0])).join('\n');
      expect(said).toContain('ART001');
      expect(said).toContain('enormous');
    } finally {
      spy.mockRestore();
    }
  });
});

/**
 * THE RENDER CONTRACT. Code reads the TOKEN, the image model reads the PHRASE,
 * and never both: a bare band name ("vehicle", "house") is exactly the kind of
 * category word the one-authored-label rule keeps out of an image prompt.
 */
describe('elementScaleNote — the enum renders, the token never does', () => {
  it('renders the band as its one canonical phrase', () => {
    expect(elementScaleNote({ scaleClass: 'fingertip' })).toBe('small enough to sit on a fingertip');
    expect(elementScaleNote({ scaleClass: 'house' })).toBe('several adults high, the size of a house');
    // the raw token is never the note
    for (const band of SCALE_CLASSES) {
      expect(elementScaleNote({ scaleClass: band }), band).not.toBe(band);
    }
  });

  it('falls back to a pre-enum bible\'s stored free-text size', () => {
    // This is the backward-compatibility contract, in its smallest form: a
    // finished story's bible carries only `size`, and a repair or a cover
    // repaint months from now must still state the scale it shipped with.
    expect(elementScaleNote({ size: 'the size of a thumb' })).toBe('the size of a thumb');
    expect(elementScaleNote({ scaleClass: null, size: '  body length about four metres  ' }))
      .toBe('body length about four metres');
    expect(elementScaleNote({ scaleClass: 'enormous', size: 'the size of a thumb' })).toBe('the size of a thumb');
  });

  it('prefers the band over a stored size when a bible carries both', () => {
    expect(elementScaleNote({ scaleClass: 'palm', size: 'the size of a thumb' }))
      .toBe(SCALE_PHRASES.palm);
  });

  it('is null when an element states no scale at all', () => {
    expect(elementScaleNote({})).toBeNull();
    expect(elementScaleNote(null)).toBeNull();
    expect(elementScaleNote({ scaleClass: null, size: '   ' })).toBeNull();
  });
});

describe('the built page prompt carries the PHRASE and never the token', () => {
  const brief = (objects: string[]) =>
    'The main character stands on the quay holding a roasted chestnut.'
    + '\n\n---METADATA---\n' + JSON.stringify({
      sceneIntent: 'the chestnut is offered',
      characters: [{ name: 'Mira', position: 'center', depth: 'midground' }],
      shot: 'wide',
      objects,
      textPosition: 'bottom-left',
    });

  const inputData: any = {
    title: 'The Quay', characters: [{ id: 'c1', name: 'Mira', age: 8, gender: 'girl' }],
    mainCharacters: ['c1'], language: 'en', languageLevel: 'medium', pages: 4,
    artStyle: 'watercolor', relationships: {}, relationshipTexts: {},
  };
  const build = (vb: any) => String(PB.buildImagePrompt(brief(['ART001']), inputData, null, vb, 1, null, {}));

  it('states the authored band as its phrase on the REQUIRED OBJECTS line', () => {
    const prompt = build(parseVisualBible(bible(FULL)));
    expect(prompt).toContain('small enough to sit on a fingertip');
  });

  it('never emits the raw token, the field name, or a bare band word', () => {
    const prompt = build(parseVisualBible(bible(FULL)));
    expect(prompt).not.toMatch(/scaleClass/i);
    // The bands that are also ordinary category words are the dangerous ones:
    // "house"/"landmark"/"double" printed bare would read as the object itself.
    // the REQUIRED OBJECTS bullet, not the scene prose that also names it
    const line = prompt.split('\n').find(l => l.startsWith('* **') && l.includes('roasted chestnut')) || '';
    expect(line).toContain('small enough to sit on a fingertip');
    // the rider is the phrase, never the bare token standing in for it
    expect(line).not.toMatch(/— fingertip\b/);
    for (const band of SCALE_CLASSES) {
      expect(line, band).not.toMatch(new RegExp('\\u2014 ' + band + '\\b'));
    }
  });

  it('falls back to the stored size text for a bible authored before the enum', () => {
    // The REAL stored shape: `size` present, `scaleClass` absent entirely.
    const legacy = JSON.parse(JSON.stringify(FULL));
    for (const coll of ['secondaryCharacters', 'animals', 'artifacts', 'locations', 'vehicles']) {
      for (const e of (legacy as any)[coll]) delete e.scaleClass;
    }
    legacy.artifacts[0].size = 'the size of a thumb';
    const prompt = build(parseVisualBible(bible(legacy)));
    expect(prompt).toContain('the size of a thumb');
  });

  it('carries a creature\'s scale onto the page prompt too', () => {
    // decisions.md 2026-09-11: a creature is the element whose scale drifts
    // most and the one nothing else anchors (a dragon knee-high on two pages
    // and house-sized on a fourth). The band has to reach EVERY page prompt.
    const vb = parseVisualBible(bible({
      animals: [{ id: 'ANI001', name: 'Fauchi', pages: [1], species: 'dragon', scaleClass: 'house' }]
    }));
    const prompt = String(PB.buildImagePrompt(
      'The main character walks beside the dragon.'
      + '\n\n---METADATA---\n' + JSON.stringify({
        sceneIntent: 'they walk together',
        characters: [{ name: 'Mira', position: 'center', depth: 'midground' }],
        shot: 'wide', objects: ['ANI001'], textPosition: 'bottom-left',
      }), inputData, null, vb, 1, null, {}));
    expect(prompt).toContain('several adults high, the size of a house');
    expect(prompt).not.toMatch(/scaleClass/i);
  });
});

/**
 * THE LIVE PARSE. `visualBible.parseVisualBible` is one of two VB parsers;
 * `UnifiedStoryParser.extractVisualBible` is the one the beats and unified
 * paths actually run, and it JSON.parses the authored object raw. A field
 * contract that exists in only one of the two reaches no story — this case is
 * the sibling half, and it was added because the generic gate was caught
 * missing here (2026-09-15).
 */
describe('scaleClass — the parser the pipeline actually runs', () => {
  // @ts-ignore - CommonJS
  const { UnifiedStoryParser } = require('../../server/lib/outlineParser/unified.js');
  const NL = String.fromCharCode(10);

  const parse = (data: any) => new UnifiedStoryParser(
    ['---VISUAL BIBLE---', '```json', JSON.stringify(data), '```'].join(NL)
  ).extractVisualBible();

  it('normalises the authored value on every collection', () => {
    const vb = parse({
      artifacts: [{ id: 'ART001', name: 'chestnut', pages: [1], scaleClass: ' Fingertip ' }],
      vehicles: [{ id: 'VEH001', name: 'ship', pages: [1], scaleClass: 'HOUSE' }],
      locations: [{ id: 'LOC001', name: 'quay', pages: [1], scaleClass: 'landmark' }],
    });
    expect(vb.artifacts[0].scaleClass).toBe('fingertip');
    expect(vb.vehicles[0].scaleClass).toBe('house');
    expect(vb.locations[0].scaleClass).toBe('landmark');
  });

  it('resolves a legacy token here too, so a 2026-09-15 bible stays routable', () => {
    const vb = parse({
      vehicles: [{ id: 'VEH001', name: 'ship', pages: [1], scaleClass: 'building' }],
      animals: [{ id: 'ANI001', name: 'dog', pages: [1], species: 'dog', scaleClass: 'person' }],
    });
    expect(vb.vehicles[0].scaleClass).toBe('house');
    expect(vb.animals[0].scaleClass).toBe('hip');
  });

  it('drops an unknown token here too rather than letting it sail through', () => {
    const vb = parse({ artifacts: [{ id: 'ART001', name: 'chestnut', pages: [1], scaleClass: 'enormous' }] });
    expect(vb.artifacts[0].scaleClass).toBeNull();
  });

  it('folds an animal\'s band into the description it computes, and a stored size when there is no band', () => {
    const classed = parse({ animals: [{ id: 'ANI001', name: 'Fauchi', pages: [1], species: 'dragon', scaleClass: 'house' }] });
    expect(classed.animals[0].description).toContain('several adults high, the size of a house');
    const stored = parse({ animals: [{ id: 'ANI001', name: 'Fauchi', pages: [1], species: 'dragon', size: 'as long as a city bus' }] });
    expect(stored.animals[0].description).toContain('as long as a city bus');
  });
});

/**
 * THE PERMANENT FALLBACK, pinned against REAL stored data.
 *
 * The three cases above use the test fixture with `scaleClass` deleted. This
 * one uses entries copied verbatim out of stored staging bibles (74 pre-enum
 * sized entries across the recent corpus, job_1789420511893_zly5rcdej among
 * them) — the exact shape repair, iterate, regeneration and cover repaint
 * re-read months after a story ships: `size` present, `scaleClass` absent, and
 * the enrichment fields (`states`, `cellGates`, `referenceImageUrl`) that a
 * finished bible carries alongside them.
 *
 * DELETING the `entry.size` read in `elementScaleNote` (visualBible.js) makes
 * this file fail. That is the whole point: the free-text field is gone from
 * NEWLY authored bibles, so the read path looks like leftover cleanup, and
 * removing it would silently strip the scale anchor from every finished story
 * with no other test failure and no log line.
 */
describe('the stored-`size` fallback is permanent — real pre-enum bibles', () => {
  // verbatim from stories.data->visualBible on staging (read-only pull)
  const STORED_ARTIFACT = {
    id: 'ART004',
    name: 'hot roasted chestnut',
    size: 'the size of a thumb',
    type: 'food',
    label: 'roasted chestnut',
    pages: [7, 8],
    cellGates: [{ at: '2026-09-14T21:54:01.553Z', ok: true, gate: 'element_cell', cellId: 'ART004', reason: 'matches', rerendered: false }],
    description: 'a small, round, dark brown roasted chestnut with a slightly split, textured shell.',
    appearsInPages: [7, 8],
    referenceImageUrl: 'https://images-staging.magicalstory.ch/stories/x/vb/ART004.jpg',
    referenceImageGenerated: true,
  };
  const STORED_ROPE = {
    id: 'ART003',
    name: 'heavy mooring rope',
    size: "as thick as a child's wrist and several metres long",
    type: 'nautical rope',
    label: 'stern line',
    pages: [12],
    states: [{ id: 'ART003.1', name: 'unaltered', delta: 'lies slack in loose curling loops', pages: [12] }],
    description: 'a thick, heavily textured beige hemp rope, composed of three thick twisted strands.',
    appearsInPages: [12],
  };

  it('yields the stored size text from an untouched stored entry', () => {
    expect(STORED_ARTIFACT).not.toHaveProperty('scaleClass');
    expect(elementScaleNote(STORED_ARTIFACT)).toBe('the size of a thumb');
    expect(elementScaleNote(STORED_ROPE)).toBe("as thick as a child's wrist and several metres long");
  });

  it('carries that stored text into the BUILT page prompt', () => {
    const vb = parseVisualBible(bible({ artifacts: [STORED_ARTIFACT] }));
    expect(vb.artifacts[0].scaleClass).toBeNull();
    expect(vb.artifacts[0].size).toBe('the size of a thumb');
    const prompt = String(PB.buildImagePrompt(
      'The main character stands on the quay holding a roasted chestnut.'
      + '\n\n---METADATA---\n' + JSON.stringify({
        sceneIntent: 'the chestnut is offered',
        characters: [{ name: 'Mira', position: 'center', depth: 'midground' }],
        shot: 'wide', objects: ['ART004'], textPosition: 'bottom-left',
      }),
      {
        title: 'The Quay', characters: [{ id: 'c1', name: 'Mira', age: 8, gender: 'girl' }],
        mainCharacters: ['c1'], language: 'en', languageLevel: 'medium', pages: 4,
        artStyle: 'watercolor', relationships: {}, relationshipTexts: {},
      } as any, null, vb, 1, null, {}));
    expect(prompt).toContain('the size of a thumb');
  });
});

/**
 * ONE SOURCE OF TRUTH FOR THE AUTHORING VOCABULARY (2026-09-16).
 *
 * The enum text used to be typed out nine times across the two Visual-Bible
 * authoring templates. It is now `SCALE_CLASS_SPEC` in `visualBible.js`, and
 * every occurrence in a template is that string verbatim — so a band added in
 * code but not offered to the writer, or a phrase that drifts between the
 * trial and the full path, fails here instead of shipping.
 */
describe('the authoring templates offer exactly the code enum', () => {
  const fs = require('fs');
  const path = require('path');
  const ROOT = path.resolve(__dirname, '../..');
  const SITES = ['prompts/scene-expansion-all.txt', 'prompts/story-trial.txt'];

  it('carries the spec verbatim at every authoring site', () => {
    for (const rel of SITES) {
      const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      const count = text.split(SCALE_CLASS_SPEC).length - 1;
      expect(count, `${rel} scaleClass spec occurrences`).toBeGreaterThan(0);
      // and no stale hand-typed variant survives beside it
      expect(text.includes('how big this element is beside a standing adult'), rel).toBe(false);
    }
  });

  it('offers every live band and no retired one', () => {
    for (const band of SCALE_CLASSES) {
      expect(SCALE_CLASS_SPEC, band).toContain(band);
    }
    // it is a JSON string value in the templates — a double quote would break
    // the schema example the writer copies
    expect(SCALE_CLASS_SPEC).not.toContain('"');
    // the spec names both comparison modes, which is the whole fix
    expect(SCALE_CLASS_SPEC).toMatch(/SIZE/);
    expect(SCALE_CLASS_SPEC).toMatch(/HEIGHT/);
  });
});
