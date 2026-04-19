const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { generateTextOverlay } = require('../../server/lib/textOverlayRenderer');

const SOURCE = process.argv[2] || path.join(__dirname, '..', 'fixtures', 'age-test-A-structured.jpg');
const POSITION = process.argv[3] || 'bottom-left';
const LONG = process.argv[4] === 'long';

async function alphaStats(buf, label) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let opaque = 0, partial = 0, transparent = 0;
  let maxY = 0, minY = info.height;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const a = data[(y * info.width + x) * 4 + 3];
      if (a === 0) transparent++;
      else if (a === 255) opaque++;
      else partial++;
      if (a > 0) {
        if (y > maxY) maxY = y;
        if (y < minY) minY = y;
      }
    }
  }
  const total = info.width * info.height;
  console.log(`${label}: ${info.width}x${info.height}`);
  console.log(`  transparent ${(100*transparent/total).toFixed(1)}%  partial ${(100*partial/total).toFixed(1)}%  opaque ${(100*opaque/total).toFixed(1)}%`);
  console.log(`  alpha-bearing y range: ${minY}-${maxY} (height ${info.height})`);
}

(async () => {
  const fileBuf = fs.readFileSync(SOURCE);
  const bg = await sharp(fileBuf).resize(1024, 1365, { fit: 'cover' }).jpeg().toBuffer();

  const shortText = 'A short story sentence for the calm region.';
  const longText = 'Lina opened the small wooden box she had found in the attic. Inside, nestled in faded velvet, was a silver compass whose needle spun slowly even though she was standing perfectly still. She tilted it toward the window and the needle steadied, pointing at the old oak tree in the garden as if it were waiting for her to follow. She pulled on her boots, tucked the compass into her coat pocket, and stepped out into the cold garden light.';
  const text = LONG ? longText : shortText;

  console.log(`source: ${SOURCE}`);
  console.log(`position: ${POSITION}`);
  console.log(`text length: ${text.length} chars`);

  const r = await generateTextOverlay(bg, text, POSITION);
  await alphaStats(r.overlayImage, 'overlayImage');

  const fixtures = path.join(__dirname, '..', 'fixtures');
  await sharp(r.overlayImage).toFile(path.join(fixtures, 'halo-overlay.png'));
  await sharp(r.compositedImage).toFile(path.join(fixtures, 'halo-composited.jpg'));
  console.log('saved tests/fixtures/halo-overlay.png and halo-composited.jpg');
})().catch(e => { console.error(e); process.exit(1); });
