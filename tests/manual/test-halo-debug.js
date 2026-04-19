const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

// Reach into the renderer internals via monkey-patching — dump every layer.
const renderer = require('../../server/lib/textOverlayRenderer');

const SOURCE = path.join(__dirname, '..', 'fixtures', 'age-test-A-structured.jpg');
const LONG = 'Lina opened the small wooden box she had found in the attic. Inside, nestled in faded velvet, was a silver compass whose needle spun slowly even though she was standing perfectly still. She tilted it toward the window and the needle steadied, pointing at the old oak tree in the garden as if it were waiting for her to follow. She pulled on her boots, tucked the compass into her coat pocket, and stepped out into the cold garden light.';

async function distrib(buf, label) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const bins = new Array(11).fill(0);
  for (let i = 3; i < data.length; i += 4) {
    const a = data[i];
    const b = a === 0 ? 0 : a === 255 ? 10 : Math.floor(a / 25.6) + 1; // 1..9
    bins[Math.min(10, b)]++;
  }
  const total = info.width * info.height;
  console.log(`\n=== ${label}  (${info.width}x${info.height}, ${total} px) ===`);
  console.log('  alpha=0       :', (100 * bins[0] / total).toFixed(2) + '%');
  for (let i = 1; i <= 9; i++) {
    console.log(`  alpha ${((i-1)*26).toString().padStart(3)}-${(i*26-1).toString().padStart(3)}:`, (100 * bins[i] / total).toFixed(2) + '%');
  }
  console.log('  alpha=255     :', (100 * bins[10] / total).toFixed(2) + '%');
}

(async () => {
  const fileBuf = fs.readFileSync(SOURCE);
  const bg = await sharp(fileBuf).resize(1024, 1365, { fit: 'cover' }).jpeg().toBuffer();

  const r = await renderer.generateTextOverlay(bg, LONG, 'top-left');
  await distrib(r.overlayImage, 'FINAL overlay');

  // Re-render text layer alone via the exported renderTextOverlay
  const calmRegion = await require('../../server/lib/calmRegion').detectCalmRegion(bg, 'top-left');
  const textLayer = renderer.renderTextOverlay(1024, 1365, LONG, calmRegion ? calmRegion.polygon : null, { textPosition: 'top-left' });
  await distrib(textLayer, 'TEXT layer alone');

  await sharp(textLayer).toFile(path.join(__dirname, '..', 'fixtures', 'halo-textLayer.png'));
  await sharp(r.overlayImage).toFile(path.join(__dirname, '..', 'fixtures', 'halo-overlay.png'));
  await sharp(r.compositedImage).toFile(path.join(__dirname, '..', 'fixtures', 'halo-composited.jpg'));
  console.log('\nSaved halo-textLayer.png, halo-overlay.png, halo-composited.jpg');
})().catch(e => { console.error(e); process.exit(1); });
