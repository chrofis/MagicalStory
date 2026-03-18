/**
 * Test: Grok title page with artistic text + character references
 *
 * Generic title page generator that adapts lettering style to the story theme.
 * Font is NOT specified — instead we describe the desired *feeling* and let
 * the model pick an appropriate artistic lettering style.
 *
 * Usage:
 *   node test-grok-title-page.js
 *   node test-grok-title-page.js --theme future --title "Star Station Zurich" --scene "..."
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const XAI_API_KEY = process.env.XAI_API_KEY;
const XAI_API_URL = 'https://api.x.ai/v1';

if (!XAI_API_KEY) {
  console.error('XAI_API_KEY not set');
  process.exit(1);
}

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'grok-char-test');
const OUT_DIR = FIXTURE_DIR;

// Pre-stitched reference images (2 characters each, side by side)
const REF_FILES = [
  'v2_ref_left_1-2_franziska_roger.jpg',
  'v2_ref_left_3-4_werner_uschi.jpg',
  'v2_ref_right_7-8_marcel_lukas.jpg',
];

const CHARACTER_DESC = `Image 1 (two people side by side):
  - LEFT person: Franziska (woman ~40, dark hair in bun, floral navy dress)
  - RIGHT person: Roger (man ~45, glasses, grey zip hoodie, ponytail)

Image 2 (two people side by side):
  - LEFT person: Werner (man ~70, white hair, glasses, salmon polo shirt)
  - RIGHT person: Uschi (woman ~65, short brown hair, red glasses, green v-neck sweater, blue necklace)

Image 3 (two people side by side):
  - LEFT person: Marcel (man ~50, bald, dark beard, navy hoodie with M logo)
  - RIGHT person: Lukas (boy ~8, brown hair, blue-white striped zip hoodie)`;

// ─────────────────────────────────────────────────────────
// Generic title text block — theme-adaptive, no font name
// ─────────────────────────────────────────────────────────
function buildTitleBlock(title) {
  return `TITLE: "${title}"
The title is positioned in the upper third of the image. The letters have significant three-dimensional volume — they are physical objects in the scene, not flat text. They catch the scene's lighting and cast shadows like any other object would. Their color is not uniform but shaped by the light sources in the scene. Use an artistic hand-crafted lettering style that fits the story's world — never standard computer fonts.
ONLY this exact title text. No other text or writing anywhere.`;
}

function loadAsDataUri(filename) {
  const buf = fs.readFileSync(path.join(FIXTURE_DIR, filename));
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

async function grokEdit(prompt, referenceImages) {
  const body = {
    model: 'grok-imagine-image',
    prompt,
    response_format: 'b64_json',
    aspect_ratio: '3:4',
  };

  if (referenceImages.length === 1) {
    body.image = { url: referenceImages[0], type: 'image_url' };
  } else {
    body.images = referenceImages.map(url => ({ url, type: 'image_url' }));
  }

  const start = Date.now();
  console.log(`Sending to Grok (${referenceImages.length} refs, prompt: ${prompt.length} chars)...`);
  const response = await fetch(`${XAI_API_URL}/images/edits`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${XAI_API_KEY}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Grok API error ${response.status}: ${err.substring(0, 500)}`);
  }

  const data = await response.json();
  const elapsed = Date.now() - start;
  console.log(`Done in ${elapsed}ms ($0.02)`);

  return `data:image/jpeg;base64,${data.data[0].b64_json}`;
}

function saveImage(dataUri, filename) {
  const base64 = dataUri.replace(/^data:image\/\w+;base64,/, '');
  fs.writeFileSync(path.join(OUT_DIR, filename), Buffer.from(base64, 'base64'));
  console.log(`Saved: ${filename}`);
}

async function runTest() {
  console.log('Loading reference images...');
  const refs = REF_FILES.map(f => {
    console.log(`  ${f}`);
    return loadAsDataUri(f);
  });

  const title = 'Pirates of Lake Zurich';
  const titleBlock = buildTitleBlock(title);

  const prompt = `Watercolor book title page illustration. Soft brushstrokes, visible paper texture.

SCENE: The deck of a wooden pirate ship sailing on a lake with mountains in the background. Dramatic sunset sky with orange and purple clouds. Ropes, barrels, a tattered Jolly Roger flag, and a ship's wheel. Six people stand and sit on deck together, cheerful and adventurous, wearing pirate hats and bandanas. The scene fills most of the page.

${titleBlock}

${CHARACTER_DESC}

IMPORTANT:
- Match each person's face and age from their reference photos (clothing is pirate gear)
- All 6 people visible on the ship deck
- Watercolor style throughout
- ABSOLUTELY NO other text, words, inscriptions, or writing besides the title`;

  console.log(`\nPrompt (${prompt.length} chars):\n`);
  console.log(prompt);
  console.log('\n═══════════════════════════════════════════════');

  const result = await grokEdit(prompt, refs);
  saveImage(result, 'v4_title_page_pirate.jpg');

  console.log('\n═══════════════════════════════════════════════');
  console.log('DONE! Result: tests/fixtures/grok-char-test/v4_title_page_pirate.jpg');
  console.log('Cost: $0.02 (1 Grok edit)');
  console.log('═══════════════════════════════════════════════');

  process.exit(0);
}

runTest().catch(e => { console.error('Test failed:', e); process.exit(1); });
