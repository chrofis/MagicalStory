/**
 * ONE vocabulary for a cover hint's `holds:` field.
 *
 * The outline's cover hint gives each figure `{ position, holds, priority }`,
 * where `holds` is a Visual Bible id ("ART001") or free prose ("a lantern").
 * Five copies of the id regex existed with TWO disagreeing vocabularies:
 *
 *   coverIterate.js  (3 copies)  ART | ANI | VEH | CLO
 *   coverComposite.js (2 copies) ART | ANI | LOC | VEH
 *   compositeCastBuilder.js      ART | ANI | LOC | VEH
 *
 * The first is correct and the difference is not deliberate — it is a copy that
 * drifted. A hand can close around an artifact, an animal, a vehicle or a
 * garment; `CLO` is load-bearing precisely because the worn/held dedupe
 * (applyCoverWornHeldDedupe) exists to resolve "the same item is both worn
 * clothing and a held artifact", which only arises when a cover hint says a
 * character HOLDS a CLO id. A composite cover therefore could not resolve a
 * held garment at all: its match failed and the raw id fell through to
 * `holds ${holds}`, pasting "holds CLO002" into the prompt — the VB-id leak
 * class. `LOC` is a place: nothing holds one, and accepting it means a
 * malformed hint resolves a backdrop into a figure's hands.
 */

/** ART/ANI/VEH/CLO — the pools a figure can hold something out of. */
const HOLDABLE_ID_RE = /^((?:ART|ANI|VEH|CLO)\d+)/i;

/**
 * The VB id a `holds` value starts with, uppercased — or null when the value is
 * empty, the literal "nothing", or free prose.
 *
 * @param {string|null|undefined} holds
 * @returns {string|null}
 */
function parseHoldsId(holds) {
  const raw = String(holds || '').trim();
  if (!raw || raw.toLowerCase() === 'nothing') return null;
  const m = raw.match(HOLDABLE_ID_RE);
  return m ? m[1].toUpperCase() : null;
}

module.exports = { HOLDABLE_ID_RE, parseHoldsId };
