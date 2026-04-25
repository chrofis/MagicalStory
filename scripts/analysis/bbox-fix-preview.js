/**
 * For each interviewed image, replay the new mergeCascadeFacesWithGemini with
 * the same Gemini figures + cascade faces that were saved during the dry-run,
 * and render a "pipeline-fixed-annotated.jpg" so the user can eyeball the new
 * merge logic against the old pipeline-annotated.jpg.
 *
 * Reads each tmp/bbox-multi-style/<style>/<imgN>/findings.json
 * Writes ../pipeline-fixed-annotated.jpg in the same folder.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { mergeCascadeFacesWithGemini } = require('../../server/lib/entityConsistency');

async function annotate(imgBuf, boxes, outPath) {
  if (boxes.length === 0) return;
  const meta = await sharp(imgBuf).metadata();
  const W = meta.width, H = meta.height;
  const rects = boxes.map(b => {
    const [y1, x1, y2, x2] = b.box;
    const x = Math.round(x1 * W);
    const y = Math.round(y1 * H);
    const w = Math.max(1, Math.round((x2 - x1) * W));
    const h = Math.max(1, Math.round((y2 - y1) * H));
    const label = (b.label || '').replace(/[<>&]/g, '');
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${b.color}" stroke-width="4"/><rect x="${x}" y="${y - 22}" width="${Math.max(70, label.length * 9)}" height="20" fill="${b.color}"/><text x="${x + 4}" y="${y - 7}" font-family="monospace" font-size="14" fill="white">${label}</text>`;
  }).join('');
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${rects}</svg>`;
  await sharp(imgBuf)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 85 })
    .toFile(outPath);
}

async function processOne(imgDir) {
  const findingsPath = path.join(imgDir, 'findings.json');
  if (!fs.existsSync(findingsPath)) return false;
  const f = JSON.parse(fs.readFileSync(findingsPath, 'utf8'));
  const buf = fs.readFileSync(path.join(imgDir, 'raw.jpg'));
  const meta = await sharp(buf).metadata();
  const W = meta.width, H = meta.height;

  // Reconstruct Gemini figures in the shape detectAllBoundingBoxes returns
  // (faceBox + bodyBox normalised 0-1).
  const geminiFigs = (f.gemini?.figures || []).map(g => ({
    name: g.name,
    label: g.label,
    position: g.position,
    confidence: g.confidence,
    faceBox: Array.isArray(g.face_box) ? g.face_box.map(v => v / 1000) : null,
    bodyBox: Array.isArray(g.body_box) ? g.body_box.map(v => v / 1000) : null,
  })).filter(x => x.bodyBox);
  if (geminiFigs.length === 0) {
    console.log('   skip — no usable gemini figures');
    return false;
  }

  // Cascade faces from detect-illustration-faces (the merge consumer).
  const cascadeFaces = (f['detect-illustration-faces']?.faces || []).filter(c => c.faceBox);
  const expectedChars = f.expectedCharacters || [];

  const merged = await mergeCascadeFacesWithGemini(geminiFigs, cascadeFaces, W, H, expectedChars);
  const boxes = merged.filter(m => m.faceBox).map((m, i) => ({
    label: 'FIX:' + (m.name || 'UNK'+i).slice(0, 8) + (m._cascadeFace ? '+'+m._cascadeFace[0] : ''),
    color: '#ff8800',
    box: m.faceBox,
  }));
  await annotate(buf, boxes, path.join(imgDir, 'pipeline-fixed-annotated.jpg'));
  console.log(`   ${path.basename(path.dirname(imgDir))}/${path.basename(imgDir)}: rendered ${boxes.length}`);
  return true;
}

(async () => {
  const root = path.resolve(__dirname, '..', '..', 'tmp', 'bbox-multi-style');
  const styles = fs.readdirSync(root).filter(s => fs.statSync(path.join(root, s)).isDirectory());
  for (const s of styles) {
    const styleDir = path.join(root, s);
    const imgs = fs.readdirSync(styleDir).filter(d =>
      fs.statSync(path.join(styleDir, d)).isDirectory() && d.startsWith('img')
    );
    for (const i of imgs) {
      try {
        await processOne(path.join(styleDir, i));
      } catch (e) {
        console.log(`   ${s}/${i}: ERR ${e.message}`);
      }
    }
  }
})().catch(e => { console.error(e); process.exit(1); });
