#!/usr/bin/env node
/**
 * Refine round 9 — A4 PORTRAIT edits via editWithGrok.
 *
 * Apple Shot: boy facing camera in front of the tree, tree bigger (still in
 *             back), spectators further back, front empty.
 * Tellsplatte: stone rounder/more natural; cliff moved RIGHT so the stone+cliff
 *              fill only the LEFT HALF; boat fills the RIGHT HALF and sits at
 *              the same height as the stone.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { editWithGrok } = require('../../server/lib/grok');

const OUT_DIR = path.resolve(__dirname, '..', '..', 'tests', 'tell-curated');

const EDITS = [
  {
    slug: 'apple-shot-altdorf',
    sourceFile: 'ai-10-composition-v7-a4portrait-no-right-figures.jpg',
    style: 'composition-v8-boy-facing-front-empty',
    editPrompt: 'Edit this medieval Altdorf apple-shot scene with these adjustments. 1) The boy at the tree should now face the CAMERA directly — full frontal view of his small body and face standing in front of the lime tree trunk, apple still balanced on his head, calm expression. He stands flat against the trunk, but turned to face us. 2) Make the lime tree BIGGER — taller, fuller crown, thicker trunk — but DO NOT move it forward; keep it at the SAME middle-distance depth in the right background. The tree just becomes a larger presence at that depth. 3) Move the SPECTATOR CROWD further BACK in the image — push them deeper into the middle-distance on the left side, so they appear smaller and further away. They remain a clustered group on the left half only, never spilling to the right. 4) The FRONT FOREGROUND of the image (the entire bottom strip of cobblestones) must remain completely EMPTY — no figures, no objects, just the open square. Keep the medieval timber-frame houses, snow-capped Uri Alps, watercolor style, brown ink outlines, soft warm afternoon light, A4 portrait composition. Single edge-to-edge illustration, no borders, no text.'
  },
  {
    slug: 'tellsplatte-boat-jump',
    sourceFile: 'ai-12-watercolor-v10-a4portrait-stone-fused.jpg',
    style: 'watercolor-v11-stone-rounder-cliff-right',
    editPrompt: 'Edit this Tellsplatte scene with these adjustments. 1) The cliff and the rock shelf together must occupy ONLY THE LEFT HALF of the image. Shift the cliff and the projecting rock toward the RIGHT so the shelf ends near the HORIZONTAL CENTRE of the canvas — left half = cliff + stone, right half = open lake with the boat. 2) Make the projecting STONE more NATURAL and ROUND — a smooth, organic, weather-worn boulder shape rising from the water, not flat or angular. The stone is still GEOLOGICALLY CONTINUOUS with the cliff at its base — same rock, no gap, no water between cliff and stone. 3) The wooden ROWBOAT sits in the RIGHT HALF of the image, immediately to the RIGHT of the stone — broadside (long axis horizontal), close enough that only inches of choppy water separate boat hull from stone. The TOP of the boat (gunwale) is at the SAME HEIGHT as the top of the round stone — boat and stone are at matching heights. 4) Keep the alpine cliff character (grey rock, conifers on ledges), the heavy diagonal rain, dark stormy clouds with diffused silver light (not pitch black), choppy whitecapped lake. NO PEOPLE — empty boat, empty rock. Watercolor style, brown ink outlines, A4 portrait. Single edge-to-edge illustration, no borders, no text.'
  },
  {
    slug: 'hohle-gasse-kuessnacht',
    sourceFile: 'ai-09-watercolor-v7-a4portrait.jpg',
    style: 'watercolor-v8-rider-bigger',
    editPrompt: 'Edit this Hohle Gasse forest ravine scene with one adjustment: make the DISTANT HORSE AND RIDER at the upper-right end of the ravine LARGER and more VISIBLE. The rider should still be in the background at the bend of the ravine (not in the foreground), but big enough that you can clearly see the horse\'s body and the rider seated on top — recognisable as a mounted figure, not just a dark dot. Roughly 2-3x the previous size. Keep everything else exactly as it is: the V-shape ravine, the high mossy banks on both sides, the meandering animal trail along the bottom, the foreground hiding bushes spilling onto the path, the leaning beech trees, dappled forest light, watercolor style, brown ink outlines, A4 portrait composition. Single edge-to-edge illustration, no borders, no text.'
  }
];

const PRIORITY_SLUGS = [
  'altdorf-panorama', 'marktplatz-altdorf', 'apple-shot-altdorf',
  'tellsplatte-boat-jump', 'hohle-gasse-kuessnacht', 'tellshaus-buerglen',
];

(async () => {
  const manifestPath = path.join(OUT_DIR, 'manifest.json');
  let manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  for (const e of EDITS) {
    console.log(`\n=== EDIT v9: ${e.slug} (${e.style}) base=${e.sourceFile} ===`);
    const sourcePath = path.join(OUT_DIR, e.slug, e.sourceFile);
    if (!fs.existsSync(sourcePath)) { console.log(`  SKIP: source not found ${sourcePath}`); continue; }
    const sourceBuf = fs.readFileSync(sourcePath);
    const sourceDataUri = `data:image/jpeg;base64,${sourceBuf.toString('base64')}`;
    const sceneDir = path.join(OUT_DIR, e.slug);
    const existing = fs.readdirSync(sceneDir).filter(f => /^ai-\d+-/.test(f));
    const idx = String(existing.length + 1).padStart(2, '0');
    try {
      const result = await editWithGrok(e.editPrompt, [sourceDataUri], { aspectRatio: '3:4' });
      if (!result?.imageData) { console.log('  FAILED'); continue; }
      const b64 = result.imageData.replace(/^data:image\/\w+;base64,/, '');
      const buf = Buffer.from(b64, 'base64');
      const fname = `ai-${idx}-${e.style}.jpg`;
      fs.writeFileSync(path.join(sceneDir, fname), buf);
      console.log(`  ${idx}-${e.style}: ${(buf.length / 1024).toFixed(0)}KB`);
      const loc = manifest.locations.find(l => l.slug === e.slug);
      if (loc) {
        loc.ai_candidates = [...(loc.ai_candidates || []), {
          file: fname, style: e.style, prompt: e.editPrompt, basedOn: e.sourceFile,
          generatedBy: 'grok-imagine-edit', bytes: buf.length,
        }];
      }
    } catch (err) {
      console.log(`  FAILED — ${err.message.slice(0, 200)}`);
    }
  }

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'review.html'), renderReviewHtml(manifest));
  console.log(`\n✅ Done. Refresh:`);
  console.log(`   file:///${path.join(OUT_DIR, 'review.html').replace(/\\/g, '/')}`);
})().catch(e => { console.error(e); process.exit(1); });

function renderReviewHtml(manifest) {
  const keep = c => !/lithograph/i.test(c.style || '');
  const ordered = [
    ...PRIORITY_SLUGS.map(s => manifest.locations.find(l => l.slug === s)).filter(Boolean),
    ...manifest.locations.filter(l => !PRIORITY_SLUGS.includes(l.slug)),
  ];
  const sections = ordered.map(loc => {
    const isPriority = PRIORITY_SLUGS.includes(loc.slug);
    const wmCards = (loc.candidates || []).map(c => `
    <div class="card"><img src="${loc.slug}/${c.file}" alt="${escapeHtml(c.title || c.file)}" /><div class="meta"><div class="title">${escapeHtml(c.title || c.file)}</div><div class="dim">${(c.bytes / 1024).toFixed(0)}KB · ${escapeHtml(c.dateOriginal || 'undated')}</div></div></div>`).join('');
    const aiCards = (loc.ai_candidates || []).filter(keep).map(c => `
    <div class="card ai"><img src="${loc.slug}/${c.file}" alt="${escapeHtml(c.style)}" /><div class="meta"><div class="title">AI · ${escapeHtml(c.style)}</div><div class="dim">${(c.bytes / 1024).toFixed(0)}KB${c.basedOn ? ' · edit of ' + escapeHtml(c.basedOn) : ''}</div><details><summary>Prompt</summary><div class="desc">${escapeHtml(c.prompt || '')}</div></details></div></div>`).join('');
    return `<section class="${isPriority ? 'priority' : ''}"><h2>${isPriority ? '⭐ ' : ''}${escapeHtml(loc.location_name)} <span class="dim">(${(loc.candidates||[]).length} Wikimedia · ${(loc.ai_candidates||[]).filter(keep).length} AI)</span></h2><div class="grid">${wmCards}${aiCards}</div>${(!wmCards && !aiCards) ? '<em>No candidates.</em>' : ''}</section>`;
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Tell location curation</title><style>body{font-family:-apple-system,sans-serif;max-width:1400px;margin:1em auto;padding:0 1em}section{margin:2em 0;border-top:2px solid #ddd;padding-top:1em}section.priority{background:#fef9c3;padding:1em;border-radius:8px;border-top:4px solid #ca8a04}h2{margin:0 0 .5em 0}.dim{color:#666;font-size:.85em}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:1em}.card{border:1px solid #ccc;padding:.5em;background:#fff}.card.ai{border:2px solid #2563eb;background:#eff6ff}.card img{width:100%;height:340px;object-fit:contain;background:#f5f5f5;display:block}.meta{padding:.5em 0}.title{font-weight:600;word-break:break-word}.desc{font-size:.85em;margin:.5em 0;color:#333}details summary{cursor:pointer;color:#2563eb}</style></head><body><h1>Wilhelm Tell — landmark curation</h1><p>⭐ Priority locations at the top. Round 9: editWithGrok iterations on apple-shot (boy facing camera, tree bigger but back, crowd back, front empty) + Tellsplatte (stone rounder, cliff right, boat right-half).</p>${sections}</body></html>`;
}
function escapeHtml(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
