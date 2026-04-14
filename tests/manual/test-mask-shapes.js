/**
 * Test alternative mask shapes:
 * 1. Square box at bottom-center (not anchored to corner)
 * 2. Triangular wedge from bottom corner
 * 3. All with MUCH stronger Gaussian blur for softer transitions
 *
 * Tested on the weak cases: indoor room + narrow street.
 */

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { editWithGrok, GROK_MODELS } = require('../../server/lib/grok');

const OUT_DIR = path.join(__dirname, '..', 'fixtures', 'mask-test');
fs.mkdirSync(OUT_DIR, { recursive: true });

const EMPTY_SCENE_TPL = fs.readFileSync(path.join(__dirname, '..', '..', 'prompts', 'empty-scene.txt'), 'utf-8');

function fillTemplate(tpl, vars) {
  let out = tpl;
  for (const [k, v] of Object.entries(vars)) out = out.replace(new RegExp(`\\{${k}\\}`, 'g'), v == null ? '' : String(v));
  return out;
}

const WIDTH = 768;
const HEIGHT = 1024;
const HEAVY_BLUR = 80; // much stronger than the production 31px

// Build mask variants
async function buildMask(shape) {
  let svg;
  if (shape === 'bottom-box-center') {
    // Square-ish box centered horizontally at the bottom, 50% width, 25% height
    const w = WIDTH * 0.5, h = HEIGHT * 0.25;
    const x = (WIDTH - w) / 2, y = HEIGHT - h - (HEIGHT * 0.02); // slight inset from bottom edge
    svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}"><rect width="${WIDTH}" height="${HEIGHT}" fill="black"/><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="20" fill="white"/></svg>`;
  } else if (shape === 'bottom-right-triangle') {
    // Right-angle triangle in bottom-right corner (big)
    svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}"><rect width="${WIDTH}" height="${HEIGHT}" fill="black"/><polygon points="${WIDTH},${HEIGHT * 0.4} ${WIDTH},${HEIGHT} ${WIDTH * 0.3},${HEIGHT}" fill="white"/></svg>`;
  } else if (shape === 'bottom-left-triangle') {
    svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}"><rect width="${WIDTH}" height="${HEIGHT}" fill="black"/><polygon points="0,${HEIGHT * 0.4} 0,${HEIGHT} ${WIDTH * 0.7},${HEIGHT}" fill="white"/></svg>`;
  } else if (shape === 'top-right-triangle') {
    svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}"><rect width="${WIDTH}" height="${HEIGHT}" fill="black"/><polygon points="${WIDTH * 0.3},0 ${WIDTH},0 ${WIDTH},${HEIGHT * 0.6}" fill="white"/></svg>`;
  }
  return sharp(Buffer.from(svg)).blur(HEAVY_BLUR).png({ compressionLevel: 9 }).toBuffer();
}

// v4 prompt (same as production)
const TEXT_INSTR = `TEXT SPACE: The attached mask shows where a bright, contour-free patch must exist in your output (WHITE region). Story text will be printed there.

CRITICAL RULE: The bright patch must be a NATURAL PART of the scene. NEVER invent elements that don't belong (no mountains in a kitchen, no sky in a floor, no water in a street).

Pick the bright content based on scene TYPE:
- OUTDOOR: use sky, distant open ground, grass, calm water, snow, or mist
- INDOOR: use this room's plain wall, ceiling, floor, rug, tablecloth, or window light — stay inside the room
- STREET: use this street's cobblestones, pavement, a light building wall, or sky between buildings — stay in the street

The bright patch must be: soft, lightly coloured, NO sharp edges, NO detailed objects, NO characters. DO NOT paint a literal white box or cutout.`;

const TESTS = [
  {
    name: 'indoor-room',
    sceneType: 'indoor',
    emptySceneDesc: 'A cozy wooden kitchen with a long oak table in the center, copper pots hanging from a beam overhead, and a window at the back letting in warm afternoon light.',
    characterSpace: 'Leave open space for 3 characters in the foreground.',
    shapes: ['bottom-box-center', 'bottom-left-triangle'],
  },
  {
    name: 'narrow-street',
    sceneType: 'street',
    emptySceneDesc: 'A narrow cobblestone street in a European old town with historic ochre buildings rising on both sides, their wooden shutters painted green.',
    characterSpace: 'Leave open space for 2 characters in the foreground.',
    shapes: ['bottom-box-center', 'bottom-right-triangle', 'top-right-triangle'],
  },
];

async function runTest(test, shape) {
  const maskBuf = await buildMask(shape);

  // Save mask for reference
  const maskPath = path.join(OUT_DIR, `_mask_shape_${shape}.png`);
  if (!fs.existsSync(maskPath)) fs.writeFileSync(maskPath, maskBuf);

  const maskDataUri = `data:image/png;base64,${maskBuf.toString('base64')}`;
  const artStyle = 'A traditional watercolor painting in the style of Inga Moore. Textured paper, delicate color washes, soft paint edges.';

  const prompt = fillTemplate(EMPTY_SCENE_TPL, {
    STYLE_DESCRIPTION: artStyle,
    EMPTY_SCENE_DESCRIPTION: test.emptySceneDesc,
    CHARACTER_SPACE: test.characterSpace,
    TEXT_AREA_INSTRUCTION: TEXT_INSTR,
  });

  const outPath = path.join(OUT_DIR, `${test.name}_shape_${shape}.jpg`);
  console.log(`→ ${test.name} / ${shape} ...`);
  try {
    const result = await editWithGrok(prompt, [maskDataUri], {
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
  console.log(`Testing alternative mask shapes with heavy blur (${HEAVY_BLUR}px)\n`);
  for (const test of TESTS) {
    for (const shape of test.shapes) {
      await runTest(test, shape);
    }
  }
  console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
