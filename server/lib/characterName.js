/**
 * Character-name normalisation — applied where a user's name is first accepted,
 * so every artefact keyed by or printing the name (title, cover, avatar maps,
 * clothing lookups) sees one spelling.
 *
 * Prod trial job_1790769860433_2bhhj0pyi: the user typed "LUNA"; the writer
 * wrote "Luna" in the text, the title stayed "LUNA et la Tour des Vents" and
 * the Luna/LUNA mismatch broke clothing lookup. Owner decision 2026-10-04:
 * normalise at input.
 *
 * Rule: a name whose letters are ALL upper or ALL lower case is title-cased
 * per part (split on space, hyphen, apostrophe). A name with any case mix
 * ("McKenzie", "DeShawn", "Anne-Sophie") is deliberate and untouched. Names of
 * two letters or fewer ("JJ", "AJ") are likely initials and untouched.
 *
 * Shape (owner decision 2026-11-13, docs/decisions.md): the name box holds a
 * NAME. Customers also type relationship text into it ("Noah, Freund von Louis
 * und Tobias") and that raw string then reaches ~120 prompt lines and every
 * name-keyed lookup. So the name is also trimmed, whitespace-collapsed and cut
 * at the first comma; the text after the comma is not lost, it moves to the
 * character's special details. This is a structural split of one field, not
 * prose reading: the no-comma form ("Aurelia Schwester von Aria") is stopped by
 * the wizard form, never guessed at here.
 */
'use strict';

const SEPARATORS = /([\s'’-]+)/;

function titleCaseIfUniform(name) {
  const letters = name.replace(/[^\p{L}]/gu, '');
  if (Array.from(letters).length <= 2) return name;
  const hasUpper = letters !== letters.toLowerCase();
  const hasLower = letters !== letters.toUpperCase();
  if (hasUpper && hasLower) return name;   // mixed case = deliberate
  return name
    .split(SEPARATORS)
    .map(part => {
      if (!part || SEPARATORS.test(part)) return part;
      const [first, ...rest] = Array.from(part);
      return first.toLocaleUpperCase() + rest.join('').toLocaleLowerCase();
    })
    .join('');
}

const collapse = (s) => s.replace(/\s+/g, ' ').trim();

/**
 * @param {*} raw what the user typed in the name box
 * @returns {{name: *, moved: string}} the clean name and the text that came
 *   after the first comma ('' when none). Non-strings pass through untouched.
 */
function splitCharacterName(raw) {
  if (typeof raw !== 'string') return { name: raw, moved: '' };
  const cut = raw.indexOf(',');
  const head = collapse(cut === -1 ? raw : raw.slice(0, cut));
  const moved = cut === -1 ? '' : collapse(raw.slice(cut + 1));
  return { name: titleCaseIfUniform(head), moved };
}

/** The clean name alone (use splitCharacterName when the text after the comma must be kept). */
function normalizeCharacterName(name) {
  return splitCharacterName(name).name;
}

/** `existing` plus `moved`, never losing either and never repeating text already there. */
function appendSpecialDetails(existing, moved) {
  const have = typeof existing === 'string' ? existing.trim() : '';
  if (!moved) return typeof existing === 'string' ? existing : '';
  if (have.includes(moved)) return have;
  return have ? `${have}. ${moved}` : moved;
}

/**
 * A character object with a clean name; text moved out of the name is appended
 * to traits.specialDetails. Returns the same object when nothing changes.
 */
function normalizeCharacterEntry(char) {
  if (!char || typeof char.name !== 'string') return char;
  const { name, moved } = splitCharacterName(char.name);
  if (name === char.name && !moved) return char;
  const out = { ...char, name };
  if (moved) {
    out.traits = { ...(char.traits || {}), specialDetails: appendSpecialDetails(char.traits?.specialDetails, moved) };
  }
  return out;
}

module.exports = { normalizeCharacterName, splitCharacterName, appendSpecialDetails, normalizeCharacterEntry };
