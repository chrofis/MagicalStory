const sharp = require('sharp');
const { generateTextOverlay } = require('../../server/lib/textOverlayRenderer');

(async () => {
  // Make a 1024x1365 test image (solid color so we can see the blur mask clearly)
  const bg = await sharp({
    create: { width: 1024, height: 1365, channels: 3, background: { r: 30, g: 80, b: 160 } }
  }).jpeg().toBuffer();

  const r = await generateTextOverlay(bg, 'This is page 1 test text spanning a couple of lines so we can see the halo shape.', 'bottom-left');

  // Examine alpha distribution of the overlay
  const { data, info } = await sharp(r.overlayImage).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let opaque = 0, partial = 0, transparent = 0;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] === 0) transparent++;
    else if (data[i] === 255) opaque++;
    else partial++;
  }
  const total = info.width * info.height;
  console.log(`overlay ${info.width}x${info.height}`);
  console.log(`  transparent: ${(100*transparent/total).toFixed(1)}%`);
  console.log(`  partial alpha: ${(100*partial/total).toFixed(1)}%`);
  console.log(`  fully opaque: ${(100*opaque/total).toFixed(1)}%`);

  // Save for visual inspection
  const path = require('path');
  const outDir = path.join(__dirname, '..', 'fixtures');
  await sharp(r.overlayImage).toFile(path.join(outDir, 'halo-overlay.png'));
  await sharp(r.compositedImage).toFile(path.join(outDir, 'halo-composited.jpg'));
  console.log('saved to tests/fixtures/halo-overlay.png and halo-composited.jpg');
})().catch(e => { console.error(e); process.exit(1); });
