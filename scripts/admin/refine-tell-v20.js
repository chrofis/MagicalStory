#!/usr/bin/env node
/**
 * Refine round 20 — Marktplatz Altdorf composed from REAL refs:
 *   - church-altdorf-kirche-wide.jpg  (Pfarrkirche St. Martin)
 *   - bristen-from-altdorf.jpg         (Bristen mountain)
 * Marketplace square is the main subject; church + mountain in background.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { editWithGrok } = require('../../server/lib/grok');

const OUT_DIR = path.resolve(__dirname, '..', '..', 'tests', 'tell-curated');
const REFS_DIR = path.join(OUT_DIR, 'altdorf-panorama', 'refs');

const COMPOSE = {
  slug: 'marktplatz-altdorf',
  refs: ['church-altdorf-kirche-wide.jpg', 'bristen-from-altdorf.jpg'],
  style: 'composed-v3-real-church-real-bristen',
  prompt: 'Compose a single A4 PORTRAIT 3:4 medieval Swiss marketplace scene set in 14th-century Altdorf, canton Uri. The MAIN SUBJECT and the FOREGROUND of the canvas is the MARKETPLACE SQUARE: an open cobblestoned square dominating the lower two-thirds of the frame, with a tall wooden POLE standing prominently in the centre of the square — atop the pole sits a fine FEATHERED VELVET HAT (Gessler\'s hat of authority), wide-brimmed with a long ostrich plume, clearly the centrepiece of the square. A few medieval Swiss peasants and townsfolk in 14th-century costume (tunics, hooded cloaks) walk the periphery of the square, but the centre by the pole is open and bare. Around the square: medieval timber-frame houses with steep shingled roofs ringing it. BACKGROUND ELEMENTS (drawn from the supplied references): use the SECOND REFERENCE IMAGE (the church) — render the SAME church as it appears in that photo (its distinctive bell tower with onion dome, the pale stone facade, the steep roof) and place it in the BACKGROUND of the square, partly visible behind the rooftops, the tower rising clearly above the village. Use the FIRST REFERENCE IMAGE (the mountain) — render the SAME pyramidal Bristen peak in the FAR BACKGROUND of the scene, its distinctive snow-capped summit dominating the upper portion of the canvas behind the village. The church and the mountain must be recognisable matches to the references — same shape, same proportions — but stylised in 19th-century romantic Swiss watercolor style with brown ink outlines, soft warm afternoon light. Single edge-to-edge illustration, no borders, no text.'
};

const PRIORITY_SLUGS = [
  'altdorf-panorama', 'marktplatz-altdorf', 'apple-shot-altdorf',
  'tellsplatte-boat-jump', 'hohle-gasse-kuessnacht', 'tellshaus-buerglen',
];

(async () => {
  const manifestPath = path.join(OUT_DIR, 'manifest.json');
  let manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  console.log(`\n=== EDIT v20: ${COMPOSE.slug} (${COMPOSE.style}) refs=${COMPOSE.refs.join(', ')} ===`);
  const refDataUris = COMPOSE.refs.map(name => {
    const buf = fs.readFileSync(path.join(REFS_DIR, name));
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
  });
  const sceneDir = path.join(OUT_DIR, COMPOSE.slug);
  if (!fs.existsSync(sceneDir)) fs.mkdirSync(sceneDir, { recursive: true });
  const existing = fs.readdirSync(sceneDir).filter(f => /^ai-\d+-/.test(f));
  const idx = String(existing.length + 1).padStart(2, '0');

  try {
    const result = await editWithGrok(COMPOSE.prompt, refDataUris, { aspectRatio: '3:4' });
    if (!result?.imageData) { console.log('  FAILED'); process.exit(1); }
    const b64 = result.imageData.replace(/^data:image\/\w+;base64,/, '');
    const buf = Buffer.from(b64, 'base64');
    const fname = `ai-${idx}-${COMPOSE.style}.jpg`;
    fs.writeFileSync(path.join(sceneDir, fname), buf);
    console.log(`  ${idx}-${COMPOSE.style}: ${(buf.length / 1024).toFixed(0)}KB`);
    const loc = manifest.locations.find(l => l.slug === COMPOSE.slug);
    if (loc) {
      loc.ai_candidates = [...(loc.ai_candidates || []), {
        file: fname, style: COMPOSE.style, prompt: COMPOSE.prompt, basedOn: COMPOSE.refs.join('+'),
        generatedBy: 'grok-imagine-edit', bytes: buf.length,
      }];
    }
  } catch (err) {
    console.log(`  FAILED — ${err.message.slice(0, 200)}`);
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
  return `<!doctype html><html><head><meta charset="utf-8"><title>Tell location curation</title><style>body{font-family:-apple-system,sans-serif;max-width:1400px;margin:1em auto;padding:0 1em}section{margin:2em 0;border-top:2px solid #ddd;padding-top:1em}section.priority{background:#fef9c3;padding:1em;border-radius:8px;border-top:4px solid #ca8a04}h2{margin:0 0 .5em 0}.dim{color:#666;font-size:.85em}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:1em}.card{border:1px solid #ccc;padding:.5em;background:#fff}.card.ai{border:2px solid #2563eb;background:#eff6ff}.card img{width:100%;height:340px;object-fit:contain;background:#f5f5f5;display:block}.meta{padding:.5em 0}.title{font-weight:600;word-break:break-word}.desc{font-size:.85em;margin:.5em 0;color:#333}details summary{cursor:pointer;color:#2563eb}</style></head><body><h1>Wilhelm Tell — landmark curation</h1><p>⭐ Round 20: Marktplatz composed from real church + real Bristen.</p>${sections}</body></html>`;
}
function escapeHtml(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
