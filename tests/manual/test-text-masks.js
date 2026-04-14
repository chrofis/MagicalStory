/**
 * Test text area masks against Grok — does the model actually respect them?
 *
 * Sends empty scene prompts to Grok with different masks attached and saves
 * the outputs locally so we can visually verify the white region of the mask
 * corresponds to a calm/light area in the generated image.
 *
 * Run: node tests/manual/test-text-masks.js
 * Output: tests/fixtures/mask-test/{scene}-{position}-{size}.jpg
 */

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { editWithGrok, GROK_MODELS } = require('../../server/lib/grok');
const { getTextAreaMask } = require('../../server/lib/textMasks');

const OUT_DIR = path.join(__dirname, '..', 'fixtures', 'mask-test');
fs.mkdirSync(OUT_DIR, { recursive: true });

// Test scenarios: scene type + position + size combinations
const TESTS = [
  {
    name: 'sky-outdoor',
    description: 'A wide open meadow with rolling green hills under a bright blue sky with white clouds. Wildflowers dot the grass in the foreground. Sunny afternoon light. Watercolor illustration style.',
    maskTests: [
      { position: 'top-right', size: 'standard' },
      { position: 'top-full', size: 'standard' },
    ],
  },
  {
    name: 'indoor-room',
    description: 'A cozy wooden kitchen with a long oak table in the center, copper pots hanging from a beam overhead, and a window at the back letting in warm afternoon light. Watercolor illustration style.',
    maskTests: [
      { position: 'bottom-left', size: 'standard' },
      { position: 'bottom-full', size: 'standard' },
    ],
  },
  {
    name: 'narrow-street',
    description: 'A narrow cobblestone street in a European old town with historic ochre buildings rising on both sides, their wooden shutters painted green. Watercolor illustration style.',
    maskTests: [
      { position: 'bottom-right', size: 'standard' },
    ],
  },
];

async function runTest(scene, maskTest) {
  const { position, size } = maskTest;
  const langLevel = size === 'small' ? '1st-grade' : size === 'large' ? 'advanced' : 'standard';
  const mask = getTextAreaMask(position, langLevel);
  if (!mask) {
    console.log(`  ✗ No mask for ${position}-${size}`);
    return;
  }

  const prompt = `Generate a SINGLE illustration of ONLY the background environment. NO people, NO animals, NO characters. Just the setting.

${scene.description}

See the attached reference mask image: the WHITE region marks where story text will be placed — paint this region in lighter tones of the scene with gentle, minimal detail. The BLACK region gets full scene detail. Do not paint a literal white box; continue the scene softly into the white region.

Fill the frame edge-to-edge. No borders, no text, no watermarks.`;

  console.log(`  → ${position}-${size} ... `);
  const startTime = Date.now();

  try {
    const result = await editWithGrok(prompt, [mask], {
      model: GROK_MODELS.STANDARD,
      aspectRatio: '3:4',
      skipOutputPadding: true,
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    if (result?.imageData) {
      const base64 = result.imageData.replace(/^data:image\/\w+;base64,/, '');
      const buf = Buffer.from(base64, 'base64');
      const outPath = path.join(OUT_DIR, `${scene.name}_${position}_${size}.jpg`);
      fs.writeFileSync(outPath, buf);
      console.log(`    ✓ saved ${outPath} (${elapsed}s, ${Math.round(buf.length / 1024)}KB)`);
    } else {
      console.log(`    ✗ no image returned`);
    }
  } catch (err) {
    console.log(`    ✗ error: ${err.message}`);
  }
}

async function main() {
  if (!process.env.XAI_API_KEY) {
    console.error('XAI_API_KEY not set — check .env');
    process.exit(1);
  }

  console.log(`Testing masks against Grok — output: ${OUT_DIR}\n`);

  // Also copy the masks themselves so they can be compared side by side
  for (const scene of TESTS) {
    console.log(`Scene: ${scene.name}`);
    for (const maskTest of scene.maskTests) {
      // Copy the mask too
      const langLevel = maskTest.size === 'small' ? '1st-grade' : maskTest.size === 'large' ? 'advanced' : 'standard';
      const maskDataUri = getTextAreaMask(maskTest.position, langLevel);
      if (maskDataUri) {
        const maskBuf = Buffer.from(maskDataUri.replace(/^data:image\/\w+;base64,/, ''), 'base64');
        const maskOut = path.join(OUT_DIR, `_mask_${maskTest.position}_${maskTest.size}.png`);
        if (!fs.existsSync(maskOut)) fs.writeFileSync(maskOut, maskBuf);
      }
      await runTest(scene, maskTest);
    }
    console.log();
  }

  console.log(`Done. Check ${OUT_DIR} — filenames are scene_position_size.jpg`);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
