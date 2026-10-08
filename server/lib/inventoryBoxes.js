'use strict';
/**
 * Bounding-box normalisation for the blind inventory (eval Stage 1).
 *
 * The inventory template asks for `[x1,y1,x2,y2]` normalised 0-1. Gemini
 * complies. Qwen3-VL returns its native 0-1000 pixel scale for some values
 * and 0-1 for others, INSIDE ONE ARRAY (`[0.23, 350, 486, 947]`): measured on
 * 20 crowded pages, 73 of 107 body boxes and 55 of 72 face boxes were mixed
 * (Lab experiment 1053, 2026-09-07). Dividing every value above 1 by 1000,
 * element by element, made all 179 boxes well formed, and 100 of 107 body
 * centres then landed inside the Gemini box for the same figure (median
 * centre distance 0.05 of the frame).
 *
 * Applied to every provider's output: a 0-1 box passes through unchanged.
 */

/**
 * @param {*} box - anything the model wrote in a bbox field
 * @returns {number[]|null} a well-formed [x1,y1,x2,y2] in 0-1, or null
 */
function normaliseBox(box) {
  if (!Array.isArray(box) || box.length !== 4) return null;
  const out = box.map(v => {
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) return NaN;
    return n > 1 ? n / 1000 : n;
  });
  if (out.some(v => !Number.isFinite(v) || v < 0 || v > 1)) return null;
  if (out[2] <= out[0] || out[3] <= out[1]) return null;
  return out;
}

/**
 * Normalise `body_bbox` and `face_bbox` on every figure and object in place. A box that
 * cannot be normalised becomes null, which the pairing code already treats as
 * "no estimate" — never a wrong estimate.
 *
 * @param {Object} inventoryJson - parsed inventory ({ figures: [...] })
 * @returns {{ fixed: number, dropped: number }} how many boxes were rescaled / nulled
 */
function normaliseInventoryBoxes(inventoryJson) {
  const stats = { fixed: 0, dropped: 0 };
  // Figures AND objects: an animal the inventory boxes (`objects[].body_bbox`,
  // 2026-10-04) is paired to the brief's creature by the same positions as a
  // figure. Until 2026-10-09 only figures were rescaled, so Qwen's 0-1000 animal
  // box never paired and the creature emotion check silently compared nothing
  // (job_1791497309909_6quecrr9t p3: a grinning dragon declared sad, no finding).
  const figures = [
    ...(Array.isArray(inventoryJson?.figures) ? inventoryJson.figures : []),
    ...(Array.isArray(inventoryJson?.objects) ? inventoryJson.objects : []).filter(o => o && typeof o === 'object'),
  ];
  for (const f of figures) {
    for (const key of ['body_bbox', 'face_bbox']) {
      if (f[key] == null) continue;
      const before = f[key];
      const after = normaliseBox(before);
      if (after === null) { f[key] = null; stats.dropped++; continue; }
      if (Array.isArray(before) && before.some(v => Number(v) > 1)) stats.fixed++;
      f[key] = after;
    }
  }
  return stats;
}

module.exports = { normaliseBox, normaliseInventoryBoxes };
