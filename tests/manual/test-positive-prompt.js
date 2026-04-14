/**
 * V6: Positive-only prompt. No mention of BLACK region.
 * Only describes what to do in the WHITE region. The rest of the image is
 * naturally where the scene goes (no need to label it as "black").
 *
 * Tests indoor scene with 4 different positions:
 * - bottom-left (the worst case from v5)
 * - bottom-full
 * - top-full
 * - top-right
 */

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { editWithGrok, GROK_MODELS } = require('../../server/lib/grok');
const { getTextAreaMask } = require('../../server/lib/textMasks');

const OUT_DIR = path.join(__dirname, '..', 'fixtures', 'mask-test');
fs.mkdirSync(OUT_DIR, { recursive: true });

const EMPTY_SCENE_TPL = fs.readFileSync(path.join(__dirname, '..', '..', 'prompts', 'empty-scene.txt'), 'utf-8');

function fillTemplate(tpl, vars) {
  let out = tpl;
  for (const [k, v] of Object.entries(vars)) out = out.replace(new RegExp(`\\{${k}\\}`, 'g'), v == null ? '' : String(v));
  return out;
}

// V6 prompt: positive-only, no mention of BLACK region
const TEXT_INSTR = `TEXT SPACE: The attached mask shows where a soft, light, contour-free patch must exist in your output (look at the WHITE region). Story text will be printed there, so this area must be quiet and readable.

Paint the bright area as a NATURAL PART of the scene — pick what naturally belongs:
- INDOOR scene → use this room's plain wall, ceiling, floor, rug, tablecloth, window light
- OUTDOOR scene → use sky, distant open ground, grass, calm water, snow, or mist
- STREET scene → use this street's cobblestones, pavement, light building wall, or sky between buildings

The bright patch must be: soft, lightly coloured, NO sharp edges, NO detailed objects, NO characters. Continue the scene naturally — the patch is just the quietest part of what's already there. DO NOT paint a literal white box, cutout, or watercolor splash.

The rest of the image is for the main scene detail described above (architecture, foliage, textures, action).`;

const indoorRoom = {
  emptySceneDesc: 'A cozy wooden kitchen with a long oak table in the center, copper pots hanging from a beam overhead, and a window at the back letting in warm afternoon light.',
  characterSpace: 'Leave open space for 3 characters in the foreground.',
  artStyle: 'A traditional watercolor painting in the style of Inga Moore. Textured paper, delicate color washes, soft paint edges.',
};

const TESTS = [
  { name: 'indoor-room', position: 'bottom-left', ...indoorRoom },
  { name: 'indoor-room', position: 'bottom-full', ...indoorRoom },
  { name: 'indoor-room', position: 'top-full', ...indoorRoom },
  { name: 'indoor-room', position: 'top-right', ...indoorRoom },
];

async function runTest(test) {
  const mask = getTextAreaMask(test.position, 'standard');
  const prompt = fillTemplate(EMPTY_SCENE_TPL, {
    STYLE_DESCRIPTION: test.artStyle,
    EMPTY_SCENE_DESCRIPTION: test.emptySceneDesc,
    CHARACTER_SPACE: test.characterSpace,
    TEXT_AREA_INSTRUCTION: TEXT_INSTR,
  });

  const outPath = path.join(OUT_DIR, `${test.name}_${test.position}_v6_positive.jpg`);
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
      console.log(`  ✓ ${outPath}`);
    }
  } catch (err) {
    console.log(`  ✗ ${err.message}`);
  }
}

async function main() {
  if (!process.env.XAI_API_KEY) { console.error('XAI_API_KEY not set'); process.exit(1); }
  console.log('V6: positive-only prompt (no BLACK mention), 80px blur masks\n');
  for (const test of TESTS) await runTest(test);
  console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
