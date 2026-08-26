import { describe, it, expect } from 'vitest';

// Two bugs from production story job_1787689073034_1v6ew0y1kae, locked down here.
//
// 1) FORBIDDEN ROUTING. Inpaint turns a figure, moves it, changes hand pose,
//    gaze or expression, and edits objects. It cannot change clothing, hair or
//    the form of a face. 5 of that story's 11 inpaint calls carried 9 such
//    directives — "Change the hair color to light blonde", "Add the square bib
//    panel and two crossing shoulder straps", "Recolour the shorts from dark
//    grey to dark brown", "Repaint the hair light blonde and wavy", and two
//    pasted age findings. Those belong to character repair or a page redo.
//
// 2) SELF-NESTING IDENTIFIERS. The name->visual-identifier substitution looped
//    name by name over its own output. A visual identifier legitimately names
//    other characters to locate its subject, so those names were injected and
//    then replaced again, nesting the identifier inside itself. The instruction
//    reached Grok as "...positioned between A and the boy in the center-left,
//    positioned between A and B appears" — no verb, no end.

// @ts-expect-error - JS module without types
import { NOT_INPAINTABLE_TYPES } from '../../server/lib/repairLogic.js';
// @ts-expect-error - JS module without types
import { stripCharacterNames } from '../../server/lib/imageCompositing.js';

describe('NOT_INPAINTABLE_TYPES', () => {
  it('covers the classes inpaint must never be asked to repaint', () => {
    for (const t of ['hair', 'hair_change', 'clothing', 'clothing_inconsistent',
      'clothing_detail', 'character_identity', 'face_mismatch', 'face_drift',
      'age_shift', 'skin_tone', 'scale']) {
      expect(NOT_INPAINTABLE_TYPES.has(t), `${t} should be blocked`).toBe(true);
    }
  });

  it('leaves the classes inpaint exists for alone', () => {
    for (const t of ['action_interaction', 'object_presence', 'missing_element',
      'accessory', 'accessory_missing', 'setting']) {
      expect(NOT_INPAINTABLE_TYPES.has(t), `${t} should be allowed`).toBe(false);
    }
  });
});

describe('stripCharacterNames', () => {
  const names = ['Levin', 'Kiaan'];
  // The real identifier from the shipped instruction: it names two other
  // characters in order to locate its subject.
  const vidByName = new Map([
    ['levin', 'the boy in the center-left, positioned between Levin and Kiaan'],
  ]);
  const fallbackByName = new Map([['levin', 'the toddler'], ['kiaan', 'the preschooler']]);

  it('does not nest an identifier that contains other character names', () => {
    const out = stripCharacterNames('Levin appears older than Kiaan', {
      names, vidByName, fallbackByName,
    });
    // The identifier is substituted once and its own mention of the names
    // survives verbatim — no second pass over injected text.
    expect(out).toBe('the boy in the center-left, positioned between Levin and Kiaan appears older than the preschooler');
    // The shipped bug repeated the identifier's prefix twice.
    const occurrences = out.split('positioned between').length - 1;
    expect(occurrences).toBe(1);
  });

  it('handles possessives and bare apostrophes', () => {
    expect(stripCharacterNames("Rotate Levin's head", { names, vidByName: new Map(), fallbackByName }))
      .toBe("Rotate the toddler's head");
    expect(stripCharacterNames("Open Levin' hands", { names, vidByName: new Map(), fallbackByName }))
      .toBe("Open the toddler's hands");
  });

  it('prefers the longest matching name so a contained name cannot win', () => {
    const out = stripCharacterNames('Anna Maria waves', {
      names: ['Anna', 'Anna Maria'],
      vidByName: new Map([['anna maria', 'the girl in red'], ['anna', 'the girl in blue']]),
      fallbackByName: new Map(),
    });
    expect(out).toBe('the girl in red waves');
  });

  it('leaves text without character names untouched', () => {
    const text = 'Remove the dragon from the right foreground.';
    expect(stripCharacterNames(text, { names, vidByName, fallbackByName })).toBe(text);
  });

  it('is a no-op when there is no cast', () => {
    expect(stripCharacterNames('Turn the head left.', { names: [] })).toBe('Turn the head left.');
  });
});
