/**
 * Grok aspect-ratio presets + nearest-preset lookup.
 *
 * Leaf module (no internal requires) so any image module can import it
 * without risking a circular dependency.
 *
 * Grok's edit/generate endpoints only accept a fixed set of aspect_ratio
 * strings. editWithGrok uses the aspect string to drive its own input
 * cover-cropper — when the string isn't a parseable W:H it falls back to
 * ratio 1 and crops the input to square, clipping content off the edges.
 * So callers must snap arbitrary crop dimensions to the closest supported
 * preset before sending.
 *
 * Source: https://docs.x.ai/developers/model-capabilities/images/generation
 */

const GROK_ASPECT_PRESETS = [
  { name: '1:1',    value: 1.0 },
  { name: '4:3',    value: 4 / 3 },
  { name: '3:4',    value: 3 / 4 },
  { name: '16:9',   value: 16 / 9 },
  { name: '9:16',   value: 9 / 16 },
  { name: '3:2',    value: 3 / 2 },
  { name: '2:3',    value: 2 / 3 },
  { name: '2:1',    value: 2 / 1 },
  { name: '1:2',    value: 1 / 2 },
  { name: '19.5:9', value: 19.5 / 9 },
  { name: '9:19.5', value: 9 / 19.5 },
  { name: '20:9',   value: 20 / 9 },
  { name: '9:20',   value: 9 / 20 },
];

function closestGrokAspect(width, height) {
  if (!width || !height) return '1:1';
  const ratio = width / height;
  let best = GROK_ASPECT_PRESETS[0];
  let bestDist = Infinity;
  for (const p of GROK_ASPECT_PRESETS) {
    const d = Math.abs(p.value - ratio);
    if (d < bestDist) { bestDist = d; best = p; }
  }
  return best.name;
}

module.exports = { GROK_ASPECT_PRESETS, closestGrokAspect };
