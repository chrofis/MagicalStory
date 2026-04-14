/**
 * REAL test: uses the actual empty-scene.txt template + the actual TEXT_AREA_INSTRUCTION
 * that ships in production (server.js line ~4608). Mirrors the real pipeline exactly.
 */

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { editWithGrok, GROK_MODELS } = require('../../server/lib/grok');
const { getTextAreaMask } = require('../../server/lib/textMasks');

const OUT_DIR = path.join(__dirname, '..', 'fixtures', 'mask-test');
fs.mkdirSync(OUT_DIR, { recursive: true });

// Load real empty-scene.txt template
const EMPTY_SCENE_TPL = fs.readFileSync(path.join(__dirname, '..', '..', 'prompts', 'empty-scene.txt'), 'utf-8');

function fillTemplate(tpl, vars) {
  let out = tpl;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replace(new RegExp(`\\{${k}\\}`, 'g'), v == null ? '' : String(v));
  }
  return out;
}

// EXACT production TEXT_AREA_INSTRUCTION when mask is attached (v4 — scene-type gated)
function buildTextAreaInstruction() {
  return `TEXT SPACE: The attached mask shows where a bright, contour-free patch must exist in your output (WHITE region). Story text will be printed there.

CRITICAL RULE: The bright patch must be a NATURAL PART of the scene you're painting. NEVER invent elements that don't belong (e.g. don't paint mountains inside a kitchen, don't paint sky in the middle of a floor, don't paint water in the middle of a street).

Pick the bright content based on the scene TYPE:
- OUTDOOR scene (field, hill, beach, garden): use sky, distant open ground, smooth grass, calm water, snow, or soft mist — whichever already belongs in this outdoor setting
- INDOOR scene (room, house, shop): use the SAME room's plain wall, ceiling, floor, rug, tablecloth, or window light — stay inside the room
- STREET / urban scene: use the SAME street's cobblestones, pavement, a light-coloured building wall, or a small patch of sky visible between buildings — stay in the street

The bright patch must be: soft, lightly coloured, NO sharp edges, NO detailed objects, NO characters, NO elements foreign to this setting. Continue the scene naturally — the patch is just the quietest part of the existing scene.

DO NOT paint a literal white box, a cutout, or a view through a window into a totally different landscape. The BLACK region of the mask is where the main scene detail lives.`;
}

const TESTS = [
  {
    name: 'sky-outdoor',
    emptySceneDesc: 'A wide open meadow with rolling green hills under a bright blue sky with white clouds. Wildflowers dot the grass in the foreground. Sunny afternoon light.',
    characterSpace: 'Leave open, uncluttered space for 2 characters in the foreground. Do not fill those areas with detail.',
    artStyle: 'A traditional watercolor painting in the style of Inga Moore. Textured paper, delicate color washes with wet-on-wet technique, soft paint edges.',
    position: 'top-right',
  },
  {
    name: 'indoor-room',
    emptySceneDesc: 'A cozy wooden kitchen with a long oak table in the center, copper pots hanging from a beam overhead, and a window at the back letting in warm afternoon light.',
    characterSpace: 'Leave open, uncluttered space for 3 characters in the foreground. Do not fill those areas with detail.',
    artStyle: 'A traditional watercolor painting in the style of Inga Moore. Textured paper, delicate color washes with wet-on-wet technique, soft paint edges.',
    position: 'bottom-left',
  },
  {
    name: 'indoor-room',
    emptySceneDesc: 'A cozy wooden kitchen with a long oak table in the center, copper pots hanging from a beam overhead, and a window at the back letting in warm afternoon light.',
    characterSpace: 'Leave open, uncluttered space for 3 characters in the foreground. Do not fill those areas with detail.',
    artStyle: 'A traditional watercolor painting in the style of Inga Moore. Textured paper, delicate color washes with wet-on-wet technique, soft paint edges.',
    position: 'bottom-full',
  },
  {
    name: 'narrow-street',
    emptySceneDesc: 'A narrow cobblestone street in a European old town with historic ochre buildings rising on both sides, their wooden shutters painted green.',
    characterSpace: 'Leave open, uncluttered space for 2 characters in the foreground. Do not fill those areas with detail.',
    artStyle: 'A traditional watercolor painting in the style of Inga Moore. Textured paper, delicate color washes with wet-on-wet technique, soft paint edges.',
    position: 'bottom-right',
  },
];

async function runTest(test) {
  const mask = getTextAreaMask(test.position, 'standard');
  const prompt = fillTemplate(EMPTY_SCENE_TPL, {
    STYLE_DESCRIPTION: test.artStyle,
    EMPTY_SCENE_DESCRIPTION: test.emptySceneDesc,
    CHARACTER_SPACE: test.characterSpace,
    TEXT_AREA_INSTRUCTION: buildTextAreaInstruction(),
  });

  const outPath = path.join(OUT_DIR, `${test.name}_${test.position}_standard_v5_softblur.jpg`);
  console.log(`→ ${test.name} / ${test.position} (prompt ${prompt.length} chars) ...`);
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
  console.log('REAL: using production empty-scene.txt + v3 TEXT_AREA_INSTRUCTION\n');
  for (const test of TESTS) await runTest(test);
  console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
