// Character reference cards are bound to a character with a COLOURED FRAME, not
// a stamped name. A name caption gets copied straight into the output by Grok
// (an image-edit model that paints visible glyphs) — that's how child names
// like "Philip"/"Patrick" leaked onto finished pages. A frame around the card
// is not paintable "content": Grok won't draw a frame into the middle of a
// scene the way it copies a word.
//
// The frame colour and the prompt's "RED = Philip" mapping must agree on both
// sides (the baked card in packReferences AND the prompt text in
// buildImagePrompt). Both derive the colour from the SAME per-page set of
// character names via frameColorForName(), so the assignment is identical
// regardless of array order. A page never has more than ~3 named characters, so
// a tiny high-contrast palette is plenty.

const FRAME_COLORS = [
  { label: 'RED',    rgb: { r: 222, g: 36,  b: 36  } },
  { label: 'BLUE',   rgb: { r: 33,  g: 90,  b: 222 } },
  { label: 'GREEN',  rgb: { r: 34,  g: 158, b: 66  } },
  { label: 'PURPLE', rgb: { r: 150, g: 48,  b: 200 } }, // 4th — rarely reached
];

// Deterministic, order-independent colour for `name` within the page's set of
// `allNames`. Names are canonicalised (case-insensitive, de-duped, sorted) so
// the prompt mapping and the baked frame always pick the same colour even if
// the two call sites pass the names in a different order. Returns null when the
// name isn't in the set or the set is larger than the palette.
function frameColorForName(name, allNames) {
  if (!name) return null;
  const canon = [...new Set((allNames || []).filter(Boolean).map((n) => String(n)))]
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  const idx = canon.findIndex((n) => n.toLowerCase() === String(name).toLowerCase());
  if (idx < 0 || idx >= FRAME_COLORS.length) return null;
  return FRAME_COLORS[idx];
}

module.exports = { FRAME_COLORS, frameColorForName };
