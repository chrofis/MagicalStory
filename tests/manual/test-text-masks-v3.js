/**
 * Iteration v3: keep v1's soft tone, but give the model a concrete MENU of natural
 * options for what to place in the light region. The mask is a guide, not a template —
 * the region can shift within the image to fit the composition naturally.
 */

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { editWithGrok, GROK_MODELS } = require('../../server/lib/grok');
const { getTextAreaMask } = require('../../server/lib/textMasks');

const OUT_DIR = path.join(__dirname, '..', 'fixtures', 'mask-test');
fs.mkdirSync(OUT_DIR, { recursive: true });

const TESTS = [
  {
    name: 'sky-outdoor',
    description: 'A wide open meadow with rolling green hills under a bright blue sky with white clouds. Wildflowers dot the grass in the foreground. Sunny afternoon light. Watercolor illustration style.',
    position: 'top-right',
  },
  {
    name: 'indoor-room',
    description: 'A cozy wooden kitchen with a long oak table in the center, copper pots hanging from a beam overhead, and a window at the back letting in warm afternoon light. Watercolor illustration style.',
    position: 'bottom-left',
  },
  {
    name: 'indoor-room',
    description: 'A cozy wooden kitchen with a long oak table in the center, copper pots hanging from a beam overhead, and a window at the back letting in warm afternoon light. Watercolor illustration style.',
    position: 'bottom-full',
  },
  {
    name: 'narrow-street',
    description: 'A narrow cobblestone street in a European old town with historic ochre buildings rising on both sides, their wooden shutters painted green. Watercolor illustration style.',
    position: 'bottom-right',
  },
];

// V3 prompt: loose guide + menu of natural options
function buildPrompt(scene, position) {
  return `Generate a SINGLE illustration of ONLY the background environment. NO people, NO animals, NO characters.

${scene.description}

TEXT SPACE: The attached mask is a loose GUIDE — the WHITE region shows roughly where to place a bright, contour-free patch in your output. Story text will be printed there. The patch can shift slightly within the image to fit the composition naturally; what matters is that SOMETHING light and empty exists in that area of the final illustration.

Place ONE of these in the light area (pick what suits this specific scene):
- Bright sky with soft clouds
- Pale distant mountains or misty hills
- Calm open water, lake surface, or river
- Smooth pale wall, plastered surface, or ceiling
- Warm window with light streaming in
- Empty floor, rug, or smooth tablecloth
- Cobblestones, stone path, or paved ground softly lit
- Patch of grass, meadow, or soft sand
- Smooth snow, fog, or low mist
- A light-toned door, gate, or panel

The content should be: soft, gently coloured, with no sharp edges, no detailed objects, no characters. Just a quiet patch of natural scene material.

DO NOT paint a literal white box, a cutout, or a hard-edged patch. The bright area must blend seamlessly into the rest of the illustration — it's part of the scene, just calmer.

The BLACK region of the mask is where the main scene detail lives (architecture, foliage, textures, action).

Fill the frame edge-to-edge. No borders, no text in the image, no watermarks.`;
}

async function runTest(test) {
  const mask = getTextAreaMask(test.position, 'standard');
  const prompt = buildPrompt(test, test.position);

  const outPath = path.join(OUT_DIR, `${test.name}_${test.position}_standard_v3.jpg`);
  console.log(`→ ${test.name} / ${test.position} ...`);
  try {
    const result = await editWithGrok(prompt, [mask], {
      model: GROK_MODELS.STANDARD,
      aspectRatio: '3:4',
      skipOutputPadding: true,
    });
    if (result?.imageData) {
      const buf = Buffer.from(result.imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
      fs.writeFileSync(outPath, buf);
      console.log(`  ✓ ${outPath} (${Math.round(buf.length / 1024)}KB)`);
    }
  } catch (err) {
    console.log(`  ✗ ${err.message}`);
  }
}

async function main() {
  if (!process.env.XAI_API_KEY) { console.error('XAI_API_KEY not set'); process.exit(1); }
  console.log('V3: loose guide + menu of natural options\n');
  for (const test of TESTS) await runTest(test);
  console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
