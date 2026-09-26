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
import { describe, it, expect, vi, beforeAll } from 'vitest';

// @ts-ignore - CommonJS
const VB = require('../../server/lib/visualBible');
// @ts-ignore - CommonJS
const PB = require('../../server/lib/promptBuilders');
// @ts-ignore - CommonJS
const { log } = require('../../server/utils/logger');
// @ts-ignore - CommonJS
const { loadPromptTemplates } = require('../../server/services/prompts');

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
      'fingertip-sized', 'palm-sized', 'hand-sized', 'melon-sized', 'forearm-sized', 'arm-sized',
      'knee-high', 'waist-high', 'chest-high', 'adult-height', 'twice-adult-height',
      'house-height', 'landmark'
    ]);
    // EVERY token says its own mode (owner, 2026-09-16): a bare body-part noun
    // is ambiguous by construction, `chest` is a homonym in a generator that
    // writes treasure chests, and `double` carried its meaning only in its
    // example. BEHAVIOURAL: an author reading the token alone must be unable
    // to mistake its group.
    for (const band of SCALE_CLASSES) {
      if (band === 'landmark') continue;
      expect(band, band).toMatch(/-sized$|-high$|-height$/);
    }
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
    expect(SCALE_CLASSES).toContain('melon-sized');
    const melon = scalePhrase('melon-sized') as string;
    expect(melon).toMatch(/head/i);           // it is the head-SIZED band
    expect(melon).not.toMatch(/tall|stands|high/i);
    // and it sorts below the limb bands, above the hand bands
    expect(SCALE_CLASSES.indexOf('melon-sized')).toBeGreaterThan(SCALE_CLASSES.indexOf('hand-sized'));
    expect(SCALE_CLASSES.indexOf('melon-sized')).toBeLessThan(SCALE_CLASSES.indexOf('forearm-sized'));
  });

  it('every SIZE band says size and every HEIGHT band says height', () => {
    const SIZE = ['fingertip-sized', 'palm-sized', 'hand-sized', 'melon-sized',
      'forearm-sized', 'arm-sized'];
    const HEIGHT = ['knee-high', 'waist-high', 'chest-high', 'adult-height',
      'twice-adult-height', 'house-height', 'landmark'];
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
    expect(SCALE_CLASSES).not.toContain('adult');
    // and no live token is a bare body-part noun any more
    for (const bare of ['knee', 'hip', 'chest', 'fingertip', 'palm', 'hand', 'forearm', 'arm']) {
      expect(SCALE_CLASSES, bare).not.toContain(bare);
    }
    expect(scalePhrase('adult-height')).toMatch(/as tall as a standing adult/);
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
    expect(normaliseScaleClass('  Forearm-Sized ', 'ART001')).toBe('forearm-sized');
    expect(normaliseScaleClass('HAND-SIZED', 'ART001')).toBe('hand-sized');
    expect(normaliseScaleClass('Landmark', 'LOC001')).toBe('landmark');
  });

  it('never coerces an unknown token to a nearest band', () => {
    // Adjectives name no band, and neither does a near-miss spelling. Every
    // string here is one the stored corpus actually contained as a `size`.
    for (const bad of ['huge', 'massive', 'tiny', 'ship', 'thumb-sized', 'houses', 'gross', 'mittelgross', '']) {
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
      person: 'waist-high', vehicle: 'twice-adult-height', building: 'house-height',
      landscape: 'landmark', head: 'adult-height',
      fingertip: 'fingertip-sized', palm: 'palm-sized', hand: 'hand-sized',
      melon: 'melon-sized', forearm: 'forearm-sized', arm: 'arm-sized',
      knee: 'knee-high', hip: 'waist-high', chest: 'chest-high',
      adult: 'adult-height', double: 'twice-adult-height', house: 'house-height'
    });
    // `landmark` never changed name, so it stays a LIVE token, not an alias
    expect(resolveScaleClass('landmark')).toBe('landmark');
    expect(LEGACY_SCALE_CLASSES).not.toHaveProperty('landmark');
    for (const [legacy, granular] of Object.entries(LEGACY_SCALE_CLASSES)) {
      expect(resolveScaleClass(legacy), legacy).toBe(granular);
      expect(resolveScaleClass(String(legacy).toUpperCase()), legacy).toBe(granular);
      expect(scalePhrase(legacy), legacy).toBe(SCALE_PHRASES[granular as string]);
    }
  });

  it("a stored `head` keeps the phrase it has always rendered, never a reinterpretation", () => {
    // An author who meant head-sized cannot be told apart from one who meant
    // adult-height, so the stored token is NOT re-pointed at `melon`.
    expect(resolveScaleClass('head')).toBe('adult-height');
    expect(scalePhrase('head')).toBe(SCALE_PHRASES['adult-height']);
  });

  /**
   * THE RENAME IS A RENAME, NOT A REINTERPRETATION (2026-09-16 afternoon).
   * Every pre-rename token must still render the EXACT sentence it rendered
   * before the rename. The literal phrases below are those of commit
   * b59cb751b; if a rename ever re-points one of them, this table fails.
   */
  it('renders every pre-rename token as the exact phrase it rendered before', () => {
    const BEFORE: Record<string, string> = {
      fingertip: 'small enough to sit on a fingertip',
      palm: 'small enough to close one hand around',
      hand: 'fills an open hand',
      melon: 'about as big as a human head, like a lantern or a football',
      forearm: "about as long as an adult's forearm",
      arm: "about as long as an adult's whole arm",
      knee: 'stands knee-high to an adult',
      hip: 'stands hip-high to an adult',
      chest: 'stands chest-high to an adult',
      adult: 'as tall as a standing adult',
      head: 'as tall as a standing adult',
      double: 'twice the height of a standing adult',
      house: 'several adults high, the size of a house',
      landmark: 'fills the horizon behind everything'
    };
    for (const [token, phrase] of Object.entries(BEFORE)) {
      expect(scalePhrase(token), token).toBe(phrase);
      expect(scalePhrase(token.toUpperCase()), token).toBe(phrase);
      expect(elementScaleNote({ scaleClass: token }), token).toBe(phrase);
    }
  });

  it('leaves plate routing unchanged for a legacy-classed element', () => {
    // The whole point of the mapping: the three large legacy bands are exactly
    // the three large granular bands, so nothing already stored changes route.
    for (const large of ['vehicle', 'building', 'landscape', 'double', 'house', 'landmark',
      'twice-adult-height', 'house-height', 'HOUSE-HEIGHT']) {
      expect(isLargeScaleClass(large), large).toBe(true);
    }
    for (const small of ['hand', 'arm', 'person', 'fingertip', 'palm', 'melon', 'forearm', 'knee',
      'hip', 'chest', 'head', 'adult', 'hand-sized', 'arm-sized', 'melon-sized', 'knee-high',
      'waist-high', 'chest-high', 'adult-height']) {
      expect(isLargeScaleClass(small), small).toBe(false);
    }
    expect(isLargeScaleClass(null)).toBe(false);
    expect(isLargeScaleClass('enormous')).toBe(false);
  });
});

describe('scaleClass — the Visual Bible whitelist parse', () => {
  it('admits the field on all five element collections', () => {
    const vb = parseVisualBible(bible(FULL));
    expect(vb.secondaryCharacters[0].scaleClass).toBe('adult-height'); // stored 'head', legacy alias
    expect(vb.animals[0].scaleClass).toBe('knee-high');
    expect(vb.artifacts[0].scaleClass).toBe('fingertip-sized');
    expect(vb.locations[0].scaleClass).toBe('landmark');
    expect(vb.vehicles[0].scaleClass).toBe('house-height');
  });

  it('admits it on entries the story text adds mid-book too', () => {
    const section = '---NEW VISUAL BIBLE ENTRIES---\n```json\n' + JSON.stringify({
      artifacts: [{ id: 'ART009', name: 'iron key', pages: [5], scaleClass: 'palm', description: 'a key' }],
      vehicles: [{ id: 'VEH009', name: 'hay cart', pages: [5], colorAndDetails: 'a cart', signatureElement: 'a wheel', scaleClass: 'double' }],
    }) + '\n```';
    const entries = parseNewVisualBibleEntries(section);
    expect(entries.artifacts[0].scaleClass).toBe('palm-sized');
    expect(entries.vehicles[0].scaleClass).toBe('twice-adult-height');
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
    expect(elementScaleNote({ scaleClass: 'fingertip-sized' })).toBe('small enough to sit on a fingertip');
    expect(elementScaleNote({ scaleClass: 'house-height' })).toBe('several adults high, the size of a house');
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
    expect(elementScaleNote({ scaleClass: 'palm-sized', size: 'the size of a thumb' }))
      .toBe(SCALE_PHRASES['palm-sized']);
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
      artifacts: [{ id: 'ART001', name: 'chestnut', pages: [1], scaleClass: ' Fingertip-Sized ' }],
      vehicles: [{ id: 'VEH001', name: 'ship', pages: [1], scaleClass: 'HOUSE-HEIGHT' }],
      locations: [{ id: 'LOC001', name: 'quay', pages: [1], scaleClass: 'landmark' }],
    });
    expect(vb.artifacts[0].scaleClass).toBe('fingertip-sized');
    expect(vb.vehicles[0].scaleClass).toBe('house-height');
    expect(vb.locations[0].scaleClass).toBe('landmark');
  });

  it('resolves a legacy token here too, so a 2026-09-15 bible stays routable', () => {
    const vb = parse({
      vehicles: [{ id: 'VEH001', name: 'ship', pages: [1], scaleClass: 'building' }],
      animals: [{ id: 'ANI001', name: 'dog', pages: [1], species: 'dog', scaleClass: 'person' }],
    });
    expect(vb.vehicles[0].scaleClass).toBe('house-height');
    expect(vb.animals[0].scaleClass).toBe('waist-high');
  });

  it('drops an unknown token here too rather than letting it sail through', () => {
    const vb = parse({ artifacts: [{ id: 'ART001', name: 'chestnut', pages: [1], scaleClass: 'enormous' }] });
    expect(vb.artifacts[0].scaleClass).toBeNull();
  });

  // 2026-09-24 (owner, 2026-09-23: "Cells get no size"): the computed
  // description is what the reference cell paints, so it states no scale; the
  // band and a pre-enum stored size stay on the entry for the page readers.
  it('computes an animal description with NO scale, and keeps the scale on the entry', () => {
    const classed = parse({ animals: [{ id: 'ANI001', name: 'Fauchi', pages: [1], species: 'dragon', coloring: 'green', scaleClass: 'house' }] });
    // A house-height creature leads with its MATURITY (identity, 2026-09-26 —
    // creature-size-page.test.ts), still no scale phrase.
    expect(classed.animals[0].description).toBe('a fully grown adult dragon with adult body proportions. green');
    expect(elementScaleNote(classed.animals[0])).toBe('several adults high, the size of a house');
    const stored = parse({ animals: [{ id: 'ANI001', name: 'Fauchi', pages: [1], species: 'dragon', size: 'as long as a city bus' }] });
    expect(stored.animals[0].description).toBe('dragon');
    expect(elementScaleNote(stored.animals[0])).toBe('as long as a city bus');
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
 * authoring templates, then kept byte-identical by hand. Both sites now
 * declare a `{SCALE_CLASS_SPEC}` placeholder and the constant is FILLED into
 * it, so no copy exists to drift.
 *
 * What is pinned is the STRUCTURE, never the prose: both built prompts carry
 * the same spec, it offers every live band, the two comparison groups are
 * disjoint, and no placeholder token survives the fill.
 */
describe('the authoring templates offer exactly the code enum', () => {
  const fs = require('fs');
  const path = require('path');
  const ROOT = path.resolve(__dirname, '../..');
  const SITES = ['prompts/scene-expansion-all.txt', 'prompts/story-trial.txt'];

  const trialInput = {
    language: 'en',
    readingLevel: '2nd-grade',
    storyCategory: 'adventure',
    storyTheme: 'adventure',
    storyDetails: 'a kite caught in a tree',
    trialMode: true,
    characters: [{ name: 'Mia', age: 8, gender: 'female', isMain: true }],
  };
  const allInput = {
    title: 'The Quay',
    language: 'en',
    languageLevel: 'medium',
    artStyle: 'watercolor',
    characters: [{ id: 'c1', name: 'Mia', age: 8, gender: 'female', isMain: true }],
    mainCharacters: ['c1'],
    relationships: {},
    relationshipTexts: {},
  };
  const BEATS = [
    { pageNumber: 1, text: 'She lifted the lantern.', plan: 'wide — the main character on the pier' },
    { pageNumber: 2, text: 'The lamp caught.', plan: 'close — the lamp is lit' },
  ];

  // A backslash-b inside a template string is a literal backspace, so both
  // matchers are built from ordinary strings.
  const offered = (group: string, band: string) => new RegExp('\\b' + band + '\\b').test(group);
  const exampleOf = (band: string) => new RegExp('\\b' + band + ' — ');

  let built: Record<string, string> = {};
  beforeAll(async () => {
    await loadPromptTemplates();
    built = {
      all: String(PB.buildSceneExpansionAllPrompt(allInput, BEATS, {})),
      trial: String(PB.buildTrialStoryPrompt(trialInput, 5)),
    };
  });

  it('declares the placeholder at every authoring site and hand-types no copy', () => {
    for (const rel of SITES) {
      const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      expect(text.includes('{SCALE_CLASS_SPEC}'), `${rel} lost the placeholder`).toBe(true);
      // the spec exists in exactly ONE place — code
      expect(text.includes(SCALE_CLASS_SPEC), `${rel} hand-types the spec`).toBe(false);
      expect(text.includes('how big this element is beside a standing adult'), rel).toBe(false);
    }
  });

  it('fills the same spec into both built prompts, with nothing left unfilled', () => {
    for (const [site, prompt] of Object.entries(built)) {
      expect(prompt.includes(SCALE_CLASS_SPEC), `${site} prompt lost the spec`).toBe(true);
      expect(prompt).not.toContain('{SCALE_CLASS_SPEC}');
      expect(prompt.match(/\{[A-Z][A-Z0-9_]*\}/g), `${site} prompt has an unfilled token`).toBeNull();
    }
  });

  it('offers every live band and no retired one', () => {
    for (const band of SCALE_CLASSES) {
      expect(SCALE_CLASS_SPEC, band).toContain(band);
    }
    // it is a JSON string value in the templates — a double quote would break
    // the schema example the writer copies
    expect(SCALE_CLASS_SPEC).not.toContain('"');
  });

  it('presents the two comparison modes as separate, disjoint groups', () => {
    const sizeAt = SCALE_CLASS_SPEC.indexOf('HOW BIG IS IT');
    const heightAt = SCALE_CLASS_SPEC.indexOf('HOW TALL DOES IT STAND');
    expect(sizeAt, 'the size group lost its label').toBeGreaterThan(-1);
    expect(heightAt, 'the height group lost its label').toBeGreaterThan(-1);
    expect(heightAt).toBeGreaterThan(sizeAt);

    // The examples end where the closing rules begin.
    const tailAt = SCALE_CLASS_SPEC.indexOf('A band never carries');
    expect(tailAt, 'the disambiguating tail is gone').toBeGreaterThan(heightAt);
    const sizeGroup = SCALE_CLASS_SPEC.slice(sizeAt, heightAt);
    const heightGroup = SCALE_CLASS_SPEC.slice(heightAt, tailAt);

    // Every band is offered in exactly one group — reading a size band as a
    // stature claim is the bug this vocabulary exists to prevent.
    for (const band of SCALE_CLASSES) {
      const inSize = offered(sizeGroup, band);
      const inHeight = offered(heightGroup, band);
      expect(inSize || inHeight, `${band} is offered in neither group`).toBe(true);
      expect(inSize && inHeight, `${band} is offered in BOTH groups`).toBe(false);
    }
    // The size group makes no stature claim, and the height group no bulk claim.
    expect(sizeGroup).toMatch(/say nothing about how tall/i);
    expect(heightGroup).toMatch(/say nothing about how bulky/i);
  });

  it('gives every band an everyday example', () => {
    for (const band of SCALE_CLASSES) {
      const seg = SCALE_CLASS_SPEC.split(exampleOf(band))[1] || '';
      expect(seg.length, `${band} carries no example`).toBeGreaterThan(3);
    }
  });
});
