/**
 * Iteration v2: test mask prompts that explicitly describe the mask's shape and
 * position in the prompt text (not just "see attached mask").
 *
 * Theory: the model responds better when the prompt echoes the mask's visual
 * content in words — "the upper right corner should be open sky" + mask image
 * beats generic "see the attached mask".
 */

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { editWithGrok, GROK_MODELS } = require('../../server/lib/grok');
const { getTextAreaMask } = require('../../server/lib/textMasks');

const OUT_DIR = path.join(__dirname, '..', 'fixtures', 'mask-test');
fs.mkdirSync(OUT_DIR, { recursive: true });

// Map a textPosition to an explicit shape/region description
function describeTextArea(position, size) {
  const sizeWord = size === 'small' ? 'a small area (about 10%)'
    : size === 'large' ? 'a large area (about 40%)'
    : 'a moderate area (about 25%)';

  const map = {
    'top-left': `the upper LEFT corner — ${sizeWord} of the image`,
    'top-right': `the upper RIGHT corner — ${sizeWord} of the image`,
    'bottom-left': `the lower LEFT corner — ${sizeWord} of the image`,
    'bottom-right': `the lower RIGHT corner — ${sizeWord} of the image`,
    'top-full': `a horizontal band across the ENTIRE TOP of the image (full width, ${size === 'small' ? '10%' : size === 'large' ? '40%' : '25%'} tall)`,
    'bottom-full': `a horizontal band across the ENTIRE BOTTOM of the image (full width, ${size === 'small' ? '10%' : size === 'large' ? '40%' : '25%'} tall)`,
  };
  return map[position] || `the ${position.replace('-', ' ')} area`;
}

// Suggest natural content for the calm region based on scene type
function suggestContent(sceneType, position) {
  const isTop = position.startsWith('top');
  if (sceneType === 'outdoor' || sceneType === 'sky') {
    return isTop ? 'open sky with soft clouds' : 'ground, distant meadow, or calm water';
  }
  if (sceneType === 'indoor' || sceneType === 'room') {
    return isTop ? 'plain ceiling or a simple wall area' : 'plain floor or a simple rug area';
  }
  if (sceneType === 'street') {
    return isTop ? 'sky visible between buildings, clouds, or a wall' : 'cobblestones, street surface, or a simple paved area';
  }
  return 'soft, light-toned background detail';
}

const TESTS = [
  {
    name: 'sky-outdoor',
    sceneType: 'outdoor',
    description: 'A wide open meadow with rolling green hills under a bright blue sky with white clouds. Wildflowers dot the grass in the foreground. Sunny afternoon light. Watercolor illustration style.',
    position: 'top-right',
    size: 'standard',
  },
  {
    name: 'indoor-room',
    sceneType: 'indoor',
    description: 'A cozy wooden kitchen with a long oak table in the center, copper pots hanging from a beam overhead, and a window at the back letting in warm afternoon light. Watercolor illustration style.',
    position: 'bottom-left',
    size: 'standard',
  },
  {
    name: 'indoor-room',
    sceneType: 'indoor',
    description: 'A cozy wooden kitchen with a long oak table in the center, copper pots hanging from a beam overhead, and a window at the back letting in warm afternoon light. Watercolor illustration style.',
    position: 'bottom-full',
    size: 'standard',
  },
  {
    name: 'narrow-street',
    sceneType: 'street',
    description: 'A narrow cobblestone street in a European old town with historic ochre buildings rising on both sides, their wooden shutters painted green. Watercolor illustration style.',
    position: 'bottom-right',
    size: 'standard',
  },
];

async function runTest(test) {
  const { name, sceneType, description, position, size } = test;
  const langLevel = size === 'small' ? '1st-grade' : size === 'large' ? 'advanced' : 'standard';
  const mask = getTextAreaMask(position, langLevel);

  const areaDesc = describeTextArea(position, size);
  const suggestedContent = suggestContent(sceneType, position);

  // v2 prompt: explicitly describe the mask's shape and suggest matching content
  const prompt = `Generate a SINGLE illustration of ONLY the background environment. NO people, NO animals, NO characters.

${description}

TEXT AREA (mandatory): ${areaDesc} must be kept as LIGHT, CALM, OPEN SPACE — ideally showing ${suggestedContent}. This area will have dark story text printed over it, so it must be readable.

The attached reference mask confirms the exact shape: the WHITE region of the mask shows where the calm/light area must be in your output. Match the position, size, and shape of the white region precisely. Do NOT paint a literal white box — the region should be a natural part of the scene (e.g., open sky, plain ground, soft wall), just simpler and lighter than the rest.

The BLACK region of the mask is where you should place the main scene detail (buildings, foliage, furniture, etc.).

Fill the entire frame edge-to-edge. No borders, no text in the image, no watermarks.`;

  const suffix = 'v2';
  const outPath = path.join(OUT_DIR, `${name}_${position}_${size}_${suffix}.jpg`);

  console.log(`→ ${name} / ${position} / ${size} ... `);
  try {
    const result = await editWithGrok(prompt, [mask], {
      model: GROK_MODELS.STANDARD,
      aspectRatio: '3:4',
      skipOutputPadding: true,
    });

    if (result?.imageData) {
      const base64 = result.imageData.replace(/^data:image\/\w+;base64,/, '');
      const buf = Buffer.from(base64, 'base64');
      fs.writeFileSync(outPath, buf);
      console.log(`  ✓ ${outPath} (${Math.round(buf.length / 1024)}KB)`);
    }
  } catch (err) {
    console.log(`  ✗ ${err.message}`);
  }
}

async function main() {
  if (!process.env.XAI_API_KEY) { console.error('XAI_API_KEY not set'); process.exit(1); }
  console.log('V2: explicit shape/position in prompt + attached mask\n');
  for (const test of TESTS) await runTest(test);
  console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
