const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { createCanvas } = require('canvas');
const { renderTextOverlay } = require('../../server/lib/textOverlayRenderer');
const { detectCalmRegion } = require('../../server/lib/calmRegion');

const SOURCE = path.join(__dirname, '..', 'fixtures', 'age-test-A-structured.jpg');
const LONG = 'Lina opened the small wooden box she had found in the attic. Inside, nestled in faded velvet, was a silver compass whose needle spun slowly even though she was standing perfectly still. She tilted it toward the window and the needle steadied, pointing at the old oak tree in the garden as if it were waiting for her to follow. She pulled on her boots, tucked the compass into her coat pocket, and stepped out into the cold garden light.';

async function distrib(data, total, label) {
  const bins = new Array(11).fill(0);
  for (let i = 0; i < data.length; i++) {
    const a = data[i];
    const b = a === 0 ? 0 : a === 255 ? 10 : Math.floor(a / 25.6) + 1;
    bins[Math.min(10, b)]++;
  }
  console.log(`\n=== ${label} (${total} px) ===`);
  console.log('  alpha=0       :', (100 * bins[0] / total).toFixed(2) + '%');
  for (let i = 1; i <= 9; i++) {
    console.log(`  alpha ${((i-1)*26).toString().padStart(3)}-${(i*26-1).toString().padStart(3)}:`, (100 * bins[i] / total).toFixed(2) + '%');
  }
  console.log('  alpha=255     :', (100 * bins[10] / total).toFixed(2) + '%');
}

(async () => {
  const fileBuf = fs.readFileSync(SOURCE);
  const bg = await sharp(fileBuf).resize(1024, 1365, { fit: 'cover' }).jpeg().toBuffer();
  const width = 1024, height = 1365;

  const calmRegion = await detectCalmRegion(bg, 'top-left');
  const textPng = renderTextOverlay(width, height, LONG, calmRegion ? calmRegion.polygon : null, { textPosition: 'top-left' });

  // Replicate buildBlurLayer step by step, dumping each
  const textAlpha = await sharp(textPng).extractChannel('alpha').raw().toBuffer();
  await distrib(textAlpha, width * height, 'TEXT alpha (input to halo)');

  const spread = await sharp(textAlpha, { raw: { width, height, channels: 1 } }).blur(5).raw().toBuffer();
  await distrib(spread, width * height, 'AFTER blur(5) dilation');

  const binary = Buffer.alloc(width * height);
  for (let i = 0; i < binary.length; i++) binary[i] = spread[i] > 20 ? 255 : 0;
  await distrib(binary, width * height, 'AFTER threshold(>20)');

  const haloRaw = await sharp(binary, { raw: { width, height, channels: 1 } }).blur(2).raw().toBuffer();
  const haloMask = Buffer.from(haloRaw);
  for (let i = 0; i < haloMask.length; i++) if (haloMask[i] < 8) haloMask[i] = 0;
  await distrib(haloMask, width * height, 'FINAL haloMask (after feather + clamp)');

  // Save the halo mask as greyscale PNG for visual inspection
  await sharp(haloMask, { raw: { width, height, channels: 1 } }).png().toFile(path.join(__dirname, '..', 'fixtures', 'halo-mask.png'));
  console.log('\nSaved halo-mask.png');
})().catch(e => { console.error(e); process.exit(1); });
