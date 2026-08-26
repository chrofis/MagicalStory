#!/usr/bin/env node
// Test descriptor variants for hard-to-render objects (crossbow, etc.) on
// Grok Imagine. Generates one image per variant with the SAME scene context,
// only the object descriptor changes. Saves results to tests/object-descriptors/<object>/<variantKey>.jpg
//
// Usage:  node scripts/test-crossbow-descriptors.js
//         node scripts/test-crossbow-descriptors.js --object=ladder
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { generateWithGrok, GROK_MODELS } = require('../server/lib/grok');

const args = process.argv.slice(2);
const objectArg = args.find(a => a.startsWith('--object='))?.split('=')[1] || 'crossbow';

// Each variant prepends a different descriptor of the target object.
// The rest of the prompt is held constant so we isolate the object descriptor's effect.
const SCENE_TEMPLATE = (objectDesc) => `
Watercolour children's-book illustration, soft naturalistic style.

A medieval Swiss town square in the morning light. An adult man with shoulder-length brown hair tied in a ponytail and black-framed glasses stands in the left foreground, both feet planted on pale cobblestones, both arms raised, ${objectDesc}. He aims forward across the square, one eye closed in concentration. Dense crowd of villagers in earth-toned wool wraps the background. Pale grey overcast November sky fills the upper third of the frame. Wide cinematic composition, no text, no borders.
`.trim();

const VARIANTS = {
  crossbow: {
    baseline: 'holding a forearm-length wooden crossbow with a dark walnut stock, iron stirrup at the front, and a taut gut string',
    anatomy_explicit: 'holding a wooden crossbow horizontally — the bow limbs are short and curved, mounted PERPENDICULAR to the wooden stock at the FRONT of it (forming a "T" shape from above), with a taut gut bowstring spanning across the limbs and a wooden bolt resting in a groove on top of the stock',
    rifle_analogy: 'holding a 14th-century wooden crossbow: the wooden stock pressed against his cheek and shoulder LIKE A RIFLE, two short curved bow limbs jutting horizontally to either side at the FRONT TIP of the stock, taut bowstring spanning the limbs perpendicular to the stock, an iron stirrup looped at the very front for foot-loading',
    not_longbow: 'holding a wooden crossbow (NOT a longbow, NOT a hunting bow) — the bow is mounted HORIZONTALLY on a short wooden stock, the bowstring runs PERPENDICULAR to the stock not parallel to his body, both hands grip the wooden stock not the bow itself',
    silhouette_first: 'holding a wooden crossbow that reads like a small wooden rifle with two short curved horns at its front; bowstring drawn taut across the horns; the whole weapon roughly forearm-length; stock pressed against the cheek',
    period_anchor: 'holding a Wilhelm-Tell-era wooden crossbow with a horizontal bow, a short rifle-like wooden stock, taut gut bowstring, and an iron stirrup at the muzzle end',
  },
  ladder: {
    baseline: 'climbing a wooden ladder',
    anatomy_explicit: 'climbing a wooden ladder — two parallel vertical wooden side rails with horizontal wooden rungs spaced a foot apart between them, leaning at a 70-degree angle against a wall',
    not_other_things: 'climbing a wooden ladder (NOT stairs, NOT a staircase) — two parallel side rails with rungs across them, leaning against a wall',
  },
  windsurf: {
    baseline: 'on a windsurf board',
    anatomy_explicit: 'on a windsurf board — a long flat board on the water with a tall vertical mast and a triangular fabric sail attached, the rider standing on the board holding the sail boom',
    not_surfboard: 'on a windsurf board (NOT a surfboard, NOT a paddle board) — the board has a tall mast with a triangular sail rising from it, the rider stands and holds the sail',
  },
};

const variantSet = VARIANTS[objectArg];
if (!variantSet) {
  console.error(`Unknown object: ${objectArg}. Choose from: ${Object.keys(VARIANTS).join(', ')}`);
  process.exit(1);
}

const outDir = path.join(__dirname, '..', 'tests', 'object-descriptors', objectArg);
fs.mkdirSync(outDir, { recursive: true });

(async () => {
  const start = Date.now();
  console.log(`Testing ${Object.keys(variantSet).length} variants for "${objectArg}"`);
  console.log(`Output dir: ${outDir}`);
  console.log('');

  const results = [];
  for (const [key, descriptor] of Object.entries(variantSet)) {
    const prompt = SCENE_TEMPLATE(descriptor);
    process.stdout.write(`  [${key}] ... `);
    const t0 = Date.now();
    try {
      const result = await generateWithGrok(prompt, {
        model: GROK_MODELS.STANDARD,
        aspectRatio: '3:4',
        resolution: '1k',
      });
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      const buf = Buffer.from(result.imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
      const file = path.join(outDir, `${key}.jpg`);
      fs.writeFileSync(file, buf);
      fs.writeFileSync(path.join(outDir, `${key}.prompt.txt`), prompt);
      console.log(`${elapsed}s · ${(buf.length / 1024).toFixed(0)}KB · ${file}`);
      results.push({ key, ok: true, elapsed });
    } catch (err) {
      console.log(`FAILED: ${err.message}`);
      results.push({ key, ok: false, error: err.message });
    }
  }

  const total = ((Date.now() - start) / 1000).toFixed(1);
  console.log('');
  console.log(`Done in ${total}s. ${results.filter(r => r.ok).length}/${results.length} succeeded.`);
  console.log(`Inspect outputs: ${outDir}`);
})();
