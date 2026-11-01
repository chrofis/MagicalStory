/**
 * A wardrobe contract that gives every commissioned character a `standard` day outfit. Code dresses every full-story
 * cover figure in it (coverBeats.coverOutfits, docs/decisions.md "Cover outfit decided by code"), so any test that builds
 * cover beats or runs the Art Director over a cast needs one. Test data only.
 */
export function dayWardrobe(inputData: any, extra: Record<string, any> = {}): Record<string, any> {
  const out: Record<string, any> = {};
  for (const c of (inputData && inputData.characters) || []) {
    if (c && c.name) out[c.name] = { standard: { used: true, description: `${c.name} in a plain day outfit` }, ...(extra[c.name] || {}) };
  }
  return out;
}
