/**
 * Export the sam-vs-rembg test crops + bbox-in-crop coordinates so the local
 * MobileSAM/FastSAM CPU test (test-mobilesam-fastsam.py) can run on identical
 * inputs. Writes crops + manifest.json to test-output/sam-vs-rembg/cpu-test/.
 */
require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const OUT = path.join(__dirname, 'test-output', 'sam-vs-rembg', 'cpu-test');
const PAD = 0.2;
const STORIES = [
  'job_1783282609908_0l16joxsb',
  'job_1783280541856_eujhh6z3e',
  'job_1783261118182_iadh9sckj',
];
const MAX_SAMPLES = 10;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const samples = [];
  for (const storyId of STORIES) {
    const s = await pool.query("SELECT data->'sceneImages' as si FROM stories WHERE id=$1", [storyId]);
    if (!s.rows.length) continue;
    for (const page of s.rows[0].si || []) {
      const figs = page?.bboxDetection?.figures || [];
      for (let fi = 0; fi < Math.min(figs.length, 2); fi++) {
        if (figs[fi].bodyBox) samples.push({ storyId, pageNumber: page.pageNumber, fi, bodyBox: figs[fi].bodyBox });
      }
    }
  }
  const step = Math.max(1, Math.floor(samples.length / MAX_SAMPLES));
  const picked = samples.filter((_, i) => i % step === 0).slice(0, MAX_SAMPLES);

  const manifest = [];
  for (const smp of picked) {
    const tag = `${smp.storyId.slice(-6)}-p${smp.pageNumber}-f${smp.fi}`;
    const img = await pool.query(
      'SELECT image_url FROM story_images WHERE story_id=$1 AND page_number=$2 ORDER BY version_index DESC LIMIT 1',
      [smp.storyId, smp.pageNumber]);
    if (!img.rows[0]?.image_url) continue;
    const pageBuf = Buffer.from(await (await fetch(img.rows[0].image_url)).arrayBuffer());
    const meta = await sharp(pageBuf).metadata();
    const W = meta.width, H = meta.height;
    const [ymin, xmin, ymax, xmax] = smp.bodyBox;
    const padX = (xmax - xmin) * PAD, padY = (ymax - ymin) * PAD;
    const rect = { left: Math.max(0, Math.floor((xmin - padX) * W)), top: Math.max(0, Math.floor((ymin - padY) * H)) };
    rect.width = Math.min(W - rect.left, Math.ceil((xmax - xmin + 2 * padX) * W));
    rect.height = Math.min(H - rect.top, Math.ceil((ymax - ymin + 2 * padY) * H));
    await sharp(pageBuf).extract(rect).jpeg({ quality: 92 }).toFile(path.join(OUT, `${tag}.jpg`));
    // unpadded bbox in crop pixel coords (xyxy for the box prompt)
    const box = [
      Math.round(xmin * W) - rect.left,
      Math.round(ymin * H) - rect.top,
      Math.round(xmax * W) - rect.left,
      Math.round(ymax * H) - rect.top,
    ];
    manifest.push({ tag, file: `${tag}.jpg`, box, cropW: rect.width, cropH: rect.height });
    console.log(tag, 'crop', rect.width + 'x' + rect.height, 'box', box.join(','));
  }
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1));
  console.log('manifest:', manifest.length, 'samples →', OUT);
  await pool.end();
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
