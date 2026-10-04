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
 */
'use strict';

const SEPARATORS = /([\s'’-]+)/;

function normalizeCharacterName(name) {
  if (typeof name !== 'string') return name;
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

module.exports = { normalizeCharacterName };
