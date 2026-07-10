/**
 * Build comparison strips for the CPU test: crop | MobileSAM (purple) | FastSAM (teal).
 * Reads cpu-test/manifest.json + the mask PNGs written by test-mobilesam-fastsam.py.
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const BASE = path.join(__dirname, 'test-output', 'sam-vs-rembg', 'cpu-test');

async function overlay(cropJpeg, maskPng, w, h, rgb) {
  const raw = await sharp(maskPng).resize(w, h, { fit: 'fill' }).greyscale().raw().toBuffer();
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    if (raw[i] > 128) { rgba[i*4] = rgb[0]; rgba[i*4+1] = rgb[1]; rgba[i*4+2] = rgb[2]; rgba[i*4+3] = 110; }
  }
  return sharp(cropJpeg).composite([{ input: rgba, raw: { width: w, height: h, channels: 4 } }]).jpeg({ quality: 90 }).toBuffer();
}

(async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(BASE, 'manifest.json')));
  for (const s of manifest) {
    const crop = fs.readFileSync(path.join(BASE, s.file));
    const meta = await sharp(crop).metadata();
    const w = meta.width, h = meta.height;
    const panels = [crop];
    for (const [model, rgb] of [['mobilesam', [160, 60, 220]], ['fastsam', [0, 175, 165]]]) {
      const maskFile = path.join(BASE, `${s.tag}.${model}.png`);
      panels.push(fs.existsSync(maskFile) ? await overlay(crop, fs.readFileSync(maskFile), w, h, rgb) : crop);
    }
    const rowH = Math.min(h, 480), rowW = Math.round(w * (rowH / h));
    const parts = await Promise.all(panels.map(b => sharp(b).resize(rowW, rowH).toBuffer()));
    const strip = await sharp({ create: { width: rowW * 3 + 20, height: rowH, channels: 3, background: 'white' } })
      .composite(parts.map((p, i) => ({ input: p, left: i * (rowW + 10), top: 0 })))
      .jpeg({ quality: 88 }).toBuffer();
    fs.writeFileSync(path.join(BASE, `strip-${s.tag}.jpg`), strip);
    console.log('strip-' + s.tag + '.jpg');
  }
})().catch(e => { console.error(e); process.exit(1); });
