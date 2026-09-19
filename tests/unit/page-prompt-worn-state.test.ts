/**
 * THE PAGE'S WORN-VS-HELD VERDICT IS DECLARED, NEVER INFERRED FROM PROSE.
 *
 * Evidence (2026-09-18, docs/decisions.md). `buildImagePrompt`'s REQUIRED
 * OBJECTS loop used to decide "this element is placed off the body" with a
 * prose matcher — `NON_WORN_STRONG_RE` / `sceneDeclaresNonWornState` — that
 * sieved the brief's prose and `interactions[]` for verbs that sounded
 * off-body. Measured over 247 stored stories on staging and production it
 * fired on 68.5% / 56.9% of every element a brief cites; 96% of those fires
 * were on an entry that can never be worn (a Pirate Hat on "pale blue sky
 * OVERHEAD", a Wooden Chest on "her gaze DROPPED onto the lid", a marten on a
 * sentence about a scarf); 14 fires contradicted an explicit
 * `wornItems: state:"worn"` row the Art Director had written. Precision
 * against declared `off` rows: 0.73% staging, 0.18% production. It is the
 * second consumer of that matcher to go — `filterWornClothingAgainstScene`
 * was deleted 2026-08-08 (5f174cba5) for gutting 34% of outfits.
 *
 * These tests pin the PROPERTY, not any wording: only the Art Director's
 * declared `wornItems` row can make an element state-aware. Off-body verbs in
 * the prose change nothing. Verified against the pre-deletion module that each
 * fixture below did behave differently before.
 */
import { describe, it, expect, beforeAll } from 'vitest';

const path = require('path');
const LIB = path.join(process.cwd(), 'server', 'lib');
const pb = require(path.join(LIB, 'promptBuilders.js'));
const helpers = require(path.join(LIB, 'storyHelpers.js'));
const { loadPromptTemplates } = require(path.join(process.cwd(), 'server', 'services', 'prompts.js'));

const DELETED = [
  'NON_WORN_STRONG_RE', 'NON_WORN_WEAK_RE', 'BODY_ANCHORED_DRAPE_RE',
  'textDeclaresNonWornPlacement', 'sceneDeclaresNonWornState',
];

/** Archetypal fixture — no story-specific names, cf. tests/manual/test-page-prompt-builder.js. */
function bible(clothingExtra: Record<string, unknown> = {}) {
  return {
    mainCharacters: [],
    secondaryCharacters: [],
    vehicles: [],
    animals: [{ id: 'ANI001', name: 'Flocke', description: 'a small white rabbit with one grey ear' }],
    clothing: [{
      id: 'CLO001',
      name: 'Roter Superhelden-Umhang (Hero)',
      description: 'A red superhero cape with golden trim, tied at the neck',
      wornBy: 'Hero',
      ...clothingExtra,
    }],
    artifacts: [{ id: 'ART001', name: 'Schere', description: 'a pair of silver scissors with star-shaped handles' }],
    locations: [{ id: 'LOC001', name: 'Sommergarten', description: 'a sunlit garden with a stone fountain', signatureElement: 'a rose-covered archway' }],
  };
}

/** Prose and an interaction row stuffed with the exact wording the matcher keyed on. */
const OFF_BODY_PROSE = 'Hero — a slim school-age boy with short brown hair — stands in the centre foreground of LOC001, '
  + 'facing the camera, holding his red superhero cape overhead in both hands as it catches the wind. '
  + 'Beside him a pair of silver scissors with star-shaped handles lies dropped on the ground.';
const OFF_BODY_INTERACTIONS = [
  { character: 'Hero', object: 'the red superhero cape', where: 'held overhead in both hands', storyRelevant: true, priority: 'essential' },
];

/** The same page with every off-body verb removed. */
const NEUTRAL_PROSE = 'Hero — a slim school-age boy with short brown hair — stands in the centre foreground of LOC001, '
  + 'facing the camera, his red superhero cape bright against the flowers. '
  + 'Beside him a pair of silver scissors with star-shaped handles rests among the daisies.';

function scene(prose: string, extraMetadata: Record<string, unknown> = {}, interactions: unknown[] = []) {
  return `${prose}\n\n---METADATA---\n${JSON.stringify({
    characters: [{ name: 'Hero', position: 'center foreground', clothing: 'costumed', depth: 'foreground', expression: 'delighted' }],
    objects: ['LOC001', 'CLO001', 'ART001', 'ANI001'],
    interactions,
    background: 'sunlit garden, gentle breeze',
    setting: 'outdoor',
    shot: 'medium',
    textPosition: 'bottom-left',
    ...extraMetadata,
  })}`;
}

const inputData = { language: 'de', artStyle: 'pixar', characters: [{ name: 'Hero', age: '8', gender: 'male' }] };
const sceneCharacters = [{ name: 'Hero', age: '8', gender: 'male' }];

const render = (s: string, vb: unknown) => pb.buildImagePrompt(s, inputData, sceneCharacters, vb, 3, null, {});

/** The one REQUIRED OBJECTS bullet mentioning a fragment ('' when the element is not listed). */
function requiredLine(prompt: string, fragment: string): string {
  const l = prompt.split('\n').find(x => x.trim().startsWith('* **') && x.toLowerCase().includes(fragment.toLowerCase()));
  return l ? l.trim() : '';
}

describe('the deleted prose matcher is gone and stays gone', () => {
  for (const name of DELETED) {
    it(`promptBuilders does not export ${name}`, () => {
      expect(Object.prototype.hasOwnProperty.call(pb, name)).toBe(false);
    });
    it(`the storyHelpers facade does not forward ${name}`, () => {
      expect(helpers[name]).toBeUndefined();
    });
  }

  it('keeps stripWornStateFromDescription — it still runs on the declared branch', () => {
    expect(typeof pb.stripWornStateFromDescription).toBe('function');
    expect(typeof helpers.stripWornStateFromDescription).toBe('function');
  });
});

describe('REQUIRED OBJECTS goes state-aware only on a declared wornItems row', () => {
  beforeAll(async () => { await loadPromptTemplates(); }, 120000);

  it('off-body verbs in the prose and in interactions[] change nothing without a row', () => {
    const vb = bible();
    const offBody = requiredLine(render(scene(OFF_BODY_PROSE, {}, OFF_BODY_INTERACTIONS), vb), 'cape');
    const neutral = requiredLine(render(scene(NEUTRAL_PROSE), vb), 'cape');
    // Before the deletion the first of these lost its "(worn by …)" suffix.
    expect(offBody).toContain('(worn by Hero)');
    expect(neutral).toContain('(worn by Hero)');
    expect(offBody).toBe(neutral);
  });

  it('a declared state:"worn" row wins over any amount of off-body prose', () => {
    // The 14 measured contradictions: the Art Director SAID the item is worn
    // and the matcher overrode that from a sentence. It cannot any more.
    const vb = bible();
    const line = requiredLine(
      render(scene(OFF_BODY_PROSE, { wornItems: [{ id: 'CLO001', owner: 'Hero', state: 'worn' }] }, OFF_BODY_INTERACTIONS), vb),
      'cape',
    );
    expect(line).toContain('(worn by Hero)');
  });

  it('a prop and an animal on an off-body-worded page are emitted exactly as on a neutral one', () => {
    // The 96% class: "dropped on the ground", "overhead" — verbs that belong to
    // the sentence, never to the prop or the animal the matcher fired on.
    const vb = bible();
    const offBody = render(scene(OFF_BODY_PROSE, {}, OFF_BODY_INTERACTIONS), vb);
    const neutral = render(scene(NEUTRAL_PROSE), vb);
    expect(requiredLine(offBody, 'scissors')).toBe(requiredLine(neutral, 'scissors'));
    expect(requiredLine(offBody, 'flocke')).toBe(requiredLine(neutral, 'flocke'));
    expect(requiredLine(offBody, 'scissors')).not.toBe('');
  });

  it('a declared state:"off" row DOES make the element state-aware, on neutral prose', () => {
    // The structured branch still bites: the suffix goes and the declared
    // location rides the line instead.
    const vb = bible({ wornAs: 'Hero.outer layer' });
    const line = requiredLine(
      render(scene(NEUTRAL_PROSE, { wornItems: [{ id: 'CLO001', owner: 'Hero', state: 'off', location: 'held overhead in both hands' }] }), vb),
      'cape',
    );
    expect(line).not.toBe('');
    expect(line).not.toContain('(worn by Hero)');
    expect(line).toContain('held overhead in both hands');
  });

  it('with no row the same element defaults to worn and is left to the avatar reference', () => {
    const vb = bible({ wornAs: 'Hero.outer layer' });
    expect(requiredLine(render(scene(OFF_BODY_PROSE, {}, OFF_BODY_INTERACTIONS), vb), 'cape')).toBe('');
    expect(requiredLine(render(scene(NEUTRAL_PROSE), vb), 'cape')).toBe('');
  });
});

describe('stripWornStateFromDescription — the surviving half', () => {
  it('drops the attachment clause and keeps the physical features', () => {
    const out = pb.stripWornStateFromDescription('A red superhero cape with golden trim, tied at the neck');
    expect(out).not.toMatch(/tied|neck/i);
    expect(out).toMatch(/red superhero cape with golden trim/i);
  });

  it('deletes the lanyard clause from a "lanyard tube"', () => {
    const before = 'a cylindrical tube about as long as a forearm, made of pale cream-coloured waxed linen; '
      + 'both ends are sealed with small flat wooden discs; a thin dark cord lanyard is tied around one end '
      + 'and loops as a necklace so the tube hangs at chest height; the surface is smooth';
    expect(pb.stripWornStateFromDescription(before)).not.toContain('lanyard');
  });

  it('is aggressive enough that it must stay behind a DECLARED signal — it guts a whole outfit', () => {
    // Why the prose matcher could not be allowed to trigger this: on a token
    // coincidence it deletes most of the text. Same evidence as the 2026-08-08
    // removal of filterWornClothingAgainstScene (5f174cba5).
    const outfit = 'Fitted black linen tunic with a small round collar and long sleeves, a diagonal black fabric '
      + 'wrap crossing the chest secured by a dark grey sash at the waist tied in a flat front knot. '
      + 'Fitted black linen trousers tapered at the ankle. Soft black cotton shoes with a split toe.';
    expect(pb.stripWornStateFromDescription(outfit).length).toBeLessThan(outfit.length / 2);
  });
});

describe('the extractedDescription shadow over the surviving strip (known, deliberately unfixed)', () => {
  it('englishEntityRef reads extractedDescription first, so a stripped `description` alone never reaches the label', () => {
    const { englishEntityRef } = require(path.join(LIB, 'visualBible.js'));
    const entry = { id: 'ART009', name: 'Umhang', extractedDescription: 'a red cape tied at the neck', description: 'STRIPPED' };
    // buildImagePrompt's `refEntry = { ...obj.entry, description }` overwrites
    // only `description`. Measured 2026-09-18: across 247 stored stories NO
    // element with a declared state:"off" row carries an extractedDescription,
    // so the shadow is inert on every stored page — but it is real, and fixing
    // it would start deleting label text that today it does not. Its own
    // decision, not this one's (docs/decisions.md, "Left alone, deliberately").
    expect(englishEntityRef(entry, 'object', { language: 'de-ch' })).toContain('tied at the neck');
  });
});
