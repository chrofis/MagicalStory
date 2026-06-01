#!/usr/bin/env node
/**
 * Refine round 22 — Altdorf panorama from the real 1900 Wikimedia photo,
 *                   composed as A4 portrait.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { editWithGrok } = require('../../server/lib/grok');

const OUT_DIR = path.resolve(__dirname, '..', '..', 'tests', 'tell-curated');

const TASKS = [
  {
    slug: 'altdorf-panorama',
    refSourcePath: path.join(OUT_DIR, 'marktplatz-altdorf', '01-Altdorf_Schweiz_1900.jpg'),
    style: 'watercolor-v4-from-1900-photo-portrait',
    prompt: 'Reinterpret this real 1900 photograph of Altdorf as an A4 PORTRAIT 3:4 vertical illustration in 19th-century romantic Swiss watercolor style. Keep the SAME town layout, the SAME church bell tower, the SAME timber-frame houses and steep shingled roofs visible in the photo, the SAME ring of mountains in the background. Recompose for a TALL portrait canvas: stack the village in the middle, snow-capped Uri Alps dominating the upper portion, and add an EMPTY ALPINE MEADOW in the lower portion of the canvas (open green pasture with wildflowers, no buildings, no figures, reserved foreground space). The whole scene rendered in soft warm afternoon light, brown ink outlines, muted earth tones, atmospheric haze in the distance. Single edge-to-edge illustration, no borders, no text.'
  },
  {
    slug: 'marktplatz-altdorf',
    refSourcePath: path.join(OUT_DIR, 'marktplatz-altdorf', 'ai-02-composed-v3-real-church-real-bristen.jpg'),
    style: 'composed-v5-pole-somewhat-shorter',
    prompt: 'Edit only the wooden pole with the feathered hat in the centre of the marketplace square — leave the church, the Bristen mountain, the buildings, the cobblestones, the figures, the watercolor style and the A4 portrait composition exactly as they are. Make the pole somewhat shorter — reduce its height a bit so it does not stand quite as tall above the square, but the pole and the feathered hat on top remain clearly present and visible as the centrepiece. Single edge-to-edge illustration, no borders, no text.'
  }
];

const PRIORITY_SLUGS = [
  'altdorf-panorama', 'marktplatz-altdorf', 'apple-shot-altdorf',
  'tellsplatte-boat-jump', 'hohle-gasse-kuessnacht', 'tellshaus-buerglen',
];

(async () => {
  const manifestPath = path.join(OUT_DIR, 'manifest.json');
  let manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  for (const t of TASKS) {
    console.log(`\n=== EDIT v22: ${t.slug} (${t.style}) base=${path.basename(t.refSourcePath)} ===`);
    if (!fs.existsSync(t.refSourcePath)) { console.log(`  SKIP: ref not found`); continue; }
    const refBuf = fs.readFileSync(t.refSourcePath);
    const refDataUri = `data:image/jpeg;base64,${refBuf.toString('base64')}`;

    const sceneDir = path.join(OUT_DIR, t.slug);
    if (!fs.existsSync(sceneDir)) fs.mkdirSync(sceneDir, { recursive: true });
    const existing = fs.readdirSync(sceneDir).filter(f => /^ai-\d+-/.test(f));
    const idx = String(existing.length + 1).padStart(2, '0');

    try {
      const result = await editWithGrok(t.prompt, [refDataUri], { aspectRatio: '3:4' });
      if (!result?.imageData) { console.log('  FAILED'); continue; }
      const b64 = result.imageData.replace(/^data:image\/\w+;base64,/, '');
      const buf = Buffer.from(b64, 'base64');
      const fname = `ai-${idx}-${t.style}.jpg`;
      fs.writeFileSync(path.join(sceneDir, fname), buf);
      console.log(`  ${idx}-${t.style}: ${(buf.length / 1024).toFixed(0)}KB`);
      const loc = manifest.locations.find(l => l.slug === t.slug);
      if (loc) {
        loc.ai_candidates = [...(loc.ai_candidates || []), {
          file: fname, style: t.style, prompt: t.prompt, basedOn: path.basename(t.refSourcePath),
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
  return `<!doctype html><html><head><meta charset="utf-8"><title>Tell location curation</title><style>body{font-family:-apple-system,sans-serif;max-width:1400px;margin:1em auto;padding:0 1em}section{margin:2em 0;border-top:2px solid #ddd;padding-top:1em}section.priority{background:#fef9c3;padding:1em;border-radius:8px;border-top:4px solid #ca8a04}h2{margin:0 0 .5em 0}.dim{color:#666;font-size:.85em}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:1em}.card{border:1px solid #ccc;padding:.5em;background:#fff}.card.ai{border:2px solid #2563eb;background:#eff6ff}.card img{width:100%;height:340px;object-fit:contain;background:#f5f5f5;display:block}.meta{padding:.5em 0}.title{font-weight:600;word-break:break-word}.desc{font-size:.85em;margin:.5em 0;color:#333}details summary{cursor:pointer;color:#2563eb}</style></head><body><h1>Wilhelm Tell — landmark curation</h1><p>⭐ Round 22: Altdorf panorama from real 1900 photo as A4 portrait.</p>${sections}</body></html>`;
}
function escapeHtml(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
