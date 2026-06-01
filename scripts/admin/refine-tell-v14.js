#!/usr/bin/env node
/**
 * Refine round 14 — Tellsplatte: natural right edge of the stone + plate
 *                   tilted toward the water (not horizontal).
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { editWithGrok } = require('../../server/lib/grok');

const OUT_DIR = path.resolve(__dirname, '..', '..', 'tests', 'tell-curated');

const EDITS = [
  {
    slug: 'tellsplatte-boat-jump',
    sourceFile: 'ai-15-watercolor-v13-stone-flat-top-boat-bow-to-stone.jpg',
    style: 'watercolor-v14-stone-natural-right-tilted-plate',
    editPrompt: 'Edit this Tellsplatte scene with two adjustments to the projecting STONE only — leave the cliff, the boat, the lake, the rain, the stormy sky, the alpine character and the watercolor style exactly as they are. 1) Make the RIGHT EDGE of the stone look NATURAL and weather-worn — irregular, rounded, organic, with small fissures and rough boulder contours where the rock meets the water. No straight cuts, no sharp engineered edges, just a naturally eroded boulder profile. 2) The flat top of the stone is no longer perfectly horizontal — TILT THE PLATE so it slopes DOWNWARD TOWARD THE WATER on the right side, like a natural rock shelf angling gently toward the lake. The high edge of the plate sits where the stone meets the cliff (left), and the low edge slopes toward the water (right). The slope is gentle enough that a person could still stand on it but clearly not a level platform. Single edge-to-edge illustration, no borders, no text.'
  },
  {
    slug: 'hohle-gasse-kuessnacht',
    sourceFile: 'ai-12-watercolor-v10-rider-tiny-far-end.jpg',
    style: 'watercolor-v11-rider-2x-same-spot',
    editPrompt: 'Edit this Hohle Gasse forest ravine scene with one adjustment to the horse and rider only — leave everything else (V-ravine, mossy banks, animal trail, foreground hiding bushes, leaning beech trees, dappled light, watercolor style, A4 portrait) exactly as it is. Make the distant horse and rider AT LEAST TWICE AS BIG (roughly 2x scale) while keeping them at THE EXACT SAME LOCATION on the path — same spot at the far end of the ravine where the trail bends out of sight in the upper-right, just rendered larger so they are more clearly readable as horse-and-rider. Still a small distant figure (not foreground), but no longer fingernail-tiny. Horse in chestnut brown coat, rider in dark cloak facing the viewer as he rides down the path. Single edge-to-edge illustration, no borders, no text.'
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
    console.log(`\n=== EDIT v14: ${e.slug} (${e.style}) base=${e.sourceFile} ===`);
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
  return `<!doctype html><html><head><meta charset="utf-8"><title>Tell location curation</title><style>body{font-family:-apple-system,sans-serif;max-width:1400px;margin:1em auto;padding:0 1em}section{margin:2em 0;border-top:2px solid #ddd;padding-top:1em}section.priority{background:#fef9c3;padding:1em;border-radius:8px;border-top:4px solid #ca8a04}h2{margin:0 0 .5em 0}.dim{color:#666;font-size:.85em}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:1em}.card{border:1px solid #ccc;padding:.5em;background:#fff}.card.ai{border:2px solid #2563eb;background:#eff6ff}.card img{width:100%;height:340px;object-fit:contain;background:#f5f5f5;display:block}.meta{padding:.5em 0}.title{font-weight:600;word-break:break-word}.desc{font-size:.85em;margin:.5em 0;color:#333}details summary{cursor:pointer;color:#2563eb}</style></head><body><h1>Wilhelm Tell — landmark curation</h1><p>⭐ Round 14: Tellsplatte — natural right edge + tilted plate.</p>${sections}</body></html>`;
}
function escapeHtml(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
