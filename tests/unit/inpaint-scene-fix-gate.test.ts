import { describe, it, expect } from 'vitest';

const {
  typesAreInpaintable,
  NOT_INPAINTABLE_TYPES,
} = require('../../server/lib/repairLogic');

// A consolidator plan has TWO channels that can carry an edit instruction:
// `scene_fix` and `per_character_fixes`. NOT_INPAINTABLE_TYPES must gate both.
//
// It gated one. The 2026-08-28 fix ("the plan path needed the same gate as the
// fallback") landed on per_character_fixes; scene_fix stayed ungated, so a scene
// fix whose own declared types are all forbidden could still be sent to the
// image editor.
//
// Measured on staging job_1789853503332_riqncqg1i: the front cover's plan
// carried scene_fix.types ['extra_character'] — the route closed on 2026-09-13
// after a removal erased a commissioned child — and nothing stopped it. It
// reached no model only because the consolidator happened to emit an empty
// instruction for that fix.
//
// These pin the PREDICATE both channels now share. The membership of
// NOT_INPAINTABLE_TYPES is a routing decision with its own owner rulings and is
// deliberately not asserted here beyond the one entry that motivated this.

describe('typesAreInpaintable — the gate both plan channels share', () => {
  it('blocks a fix whose every declared type is forbidden', () => {
    expect(typesAreInpaintable(['extra_character'])).toBe(false);
    expect(typesAreInpaintable(['clothing', 'hair'])).toBe(false);
  });

  it('allows a fix when any declared type is inpaintable', () => {
    // A mixed fix still has work the editor can do; dropping it wholesale would
    // lose the part that is legal.
    expect(typesAreInpaintable(['clothing', 'emotion'])).toBe(true);
  });

  it('allows a fix whose types are all inpaintable', () => {
    expect(typesAreInpaintable(['emotion'])).toBe(true);
    expect(typesAreInpaintable(['missing_element', 'object_count'])).toBe(true);
  });

  it('leaves an untyped fix alone — older plans predate the field', () => {
    expect(typesAreInpaintable([])).toBe(true);
    expect(typesAreInpaintable(undefined)).toBe(true);
    expect(typesAreInpaintable(null)).toBe(true);
    expect(typesAreInpaintable(['', null, undefined] as never)).toBe(true);
  });

  it('matches on the declared type, case-insensitively, never on prose', () => {
    expect(typesAreInpaintable(['EXTRA_CHARACTER'])).toBe(false);
    expect(typesAreInpaintable(['Clothing'])).toBe(false);
    // prose that merely mentions a forbidden word is not a type
    expect(typesAreInpaintable(['remove the extra character'])).toBe(true);
  });

  it('keeps the entry that motivated the gate', () => {
    // Owner ruling 2026-09-13; if this leaves the set the gate stops mattering
    // for the case it was written for.
    expect(NOT_INPAINTABLE_TYPES.has('extra_character')).toBe(true);
  });

  it('does not block the types the four measured pages actually carried', () => {
    // emotion and missing_element are NOT forbidden — an earlier reading of the
    // set said otherwise and was wrong. Pinned so the claim cannot drift back.
    for (const t of ['emotion', 'missing_element', 'action_interaction', 'setting', 'rendered_text']) {
      expect(NOT_INPAINTABLE_TYPES.has(t)).toBe(false);
      expect(typesAreInpaintable([t])).toBe(true);
    }
  });
});
