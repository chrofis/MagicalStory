#!/usr/bin/env node
/**
 * Roster hairstyle-variant tool. Takes an existing kid photo and re-renders it
 * with a DIFFERENT hairstyle while keeping the face 100% identical — so we get
 * a new, visually-distinct "kid" from the same face for more ad-cast variety.
 *
 * Output: scripts/ads/roster-variants/<kid>-<variant>.jpg (drafts — shown before use)
 *
 * Usage:
 *   node scripts/ads/restyle-hair.js --src tests/fixtures/demo-photos/berger/Noah.jpg \
 *        --kid noah --variant crop --hair "a short neat cropped blonde haircut, faded at the sides"
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const fs = require('fs');
const path = require('path');
const { editWithGrok } = require('../../server/lib/grok');

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)=(.*)$/);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
}));
// support "--flag value" form too
const argv = process.argv.slice(2);
function flag(name) {
  const i = argv.indexOf(`--${name}`);
  if (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  return args[name];
}
const SRC = flag('src');
const KID = flag('kid');
const VARIANT = flag('variant');
const HAIR = flag('hair');
if (!SRC || !KID || !VARIANT || !HAIR) {
  console.error('Usage: --src <photo> --kid <name> --variant <slug> --hair "<new hairstyle description>"');
  process.exit(1);
}

const OUT_DIR = path.join(__dirname, 'roster-variants');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const prompt = `Edit the reference photo of this child. Change ONLY the hair to: ${HAIR}.
Keep the FACE 100% identical — exact same face shape, same eyes, same eyebrows, same nose, same mouth, same skin tone, same freckles, same expression, same apparent age. Keep the SAME clothing, SAME body, SAME pose, SAME outdoor background, SAME natural daylight and the SAME real DSLR-photograph look as the input (photorealistic, not illustrated). Do not change anything except the hairstyle described. The result must clearly be the same child, just with a different haircut.`;

(async () => {
  const b64 = fs.readFileSync(SRC).toString('base64');
  const dataUri = `data:image/jpeg;base64,${b64}`;
  console.log(`Restyling ${KID} → ${VARIANT}: ${HAIR}`);
  const t0 = Date.now();
  const result = await editWithGrok(prompt, [dataUri], { aspectRatio: '1:1', resolution: '1k' });
  const out = path.join(OUT_DIR, `${KID}-${VARIANT}.jpg`);
  fs.writeFileSync(out, Buffer.from(result.imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64'));
  console.log(`✅ Saved ${out} in ${Date.now() - t0}ms`);
})().catch(e => { console.error('❌ Failed:', e.message); process.exit(1); });
