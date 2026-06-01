#!/usr/bin/env node
/**
 * Refine round 40 — Armbrust: rotate so the front (prod + bowstring end)
 *                   points to the TOP RIGHT corner of the A4 portrait canvas.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { editWithGrok } = require('../../server/lib/grok');

const OUT_DIR = path.resolve(__dirname, '..', '..', 'tests', 'tell-curated');

const PRIORITY_SLUGS = [
  'altdorf-panorama', 'marktplatz-altdorf', 'apple-shot-altdorf',
  'lake-uri-storm-boat', 'tellsplatte-boat-jump', 'hohle-gasse-kuessnacht', 'tellshaus-buerglen',
];
const ASSET_SLUGS = ['story-asset-hat', 'story-asset-armbrust'];

const EDITS = [
  {
    slug: 'story-asset-armbrust',
    refSourcePaths: [
      path.join(OUT_DIR, 'story-asset-armbrust', 'refs', 'blank-a4-portrait.jpg'),
      path.join(OUT_DIR, 'story-asset-armbrust', 'ai-10-watercolor-v10-3refs-a4-explicit-size.jpg'),
    ],
    style: 'watercolor-v11-pointing-top-right',
    editPrompt: 'OUTPUT FORMAT: A4 portrait 3:4 vertical, 1200×1600 pixels — same dimensions as REFERENCE 1 (the blank white canvas). Fill the entire canvas, do not crop. CONTENT: take the medieval Armbrust from REFERENCE 2 and redraw it in the same 19th-century romantic Swiss watercolor style with brown ink outlines on plain off-white watercolor background — but ROTATE its orientation so the FRONT END (the steel prod + bowstring) POINTS TOWARD THE TOP-RIGHT CORNER of the A4 canvas, and the BACK END (trigger + butt of the wooden stock) sits in the bottom-left area. The Armbrust lies diagonally across the page from lower-left to upper-right. Keep the SAME weapon — same massive battle-worn wooden stock, same single thick bowstring (Bogensehne) between prod tips, no other strings, no bolt, no sling, no decorations. Single edge-to-edge illustration on the full A4 portrait canvas, no borders, no text, no cropping.'
  }
];

(async () => {
  const manifestPath = path.join(OUT_DIR, 'manifest.json');
  let manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  for (const e of EDITS) {
    console.log(`\n=== EDIT v40: ${e.slug} (${e.style}) refs=${e.refSourcePaths.map(p => path.basename(p)).join(', ')} ===`);
    const refDataUris = e.refSourcePaths.map(p => {
      const buf = fs.readFileSync(p);
      return `data:image/jpeg;base64,${buf.toString('base64')}`;
    });
    const sceneDir = path.join(OUT_DIR, e.slug);
    const existing = fs.readdirSync(sceneDir).filter(f => /^ai-\d+-/.test(f));
    const idx = String(existing.length + 1).padStart(2, '0');
    try {
      const result = await editWithGrok(e.editPrompt, refDataUris, { aspectRatio: '3:4' });
      if (!result?.imageData) { console.log('  FAILED'); continue; }
      const b64 = result.imageData.replace(/^data:image\/\w+;base64,/, '');
      const buf = Buffer.from(b64, 'base64');
      const fname = `ai-${idx}-${e.style}.jpg`;
      fs.writeFileSync(path.join(sceneDir, fname), buf);
      console.log(`  ${idx}-${e.style}: ${(buf.length / 1024).toFixed(0)}KB`);
      const loc = manifest.locations.find(l => l.slug === e.slug);
      if (loc) {
        loc.ai_candidates = [...(loc.ai_candidates || []), {
          file: fname, style: e.style, prompt: e.editPrompt,
          basedOn: e.refSourcePaths.map(p => path.basename(p)).join('+'),
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
  const FINAL_SLUGS = [...PRIORITY_SLUGS, ...ASSET_SLUGS];
  const finals = FINAL_SLUGS.map(slug => {
    const loc = manifest.locations.find(l => l.slug === slug);
    if (!loc) return null;
    const cands = (loc.ai_candidates || []).filter(keep);
    if (!cands.length) return null;
    const latest = cands[cands.length - 1];
    return { slug, name: loc.location_name, file: latest.file, style: latest.style, bytes: latest.bytes };
  }).filter(Boolean);
  const finalsHtml = `<section class="finals"><h2>★ Story Final Images (latest of each)</h2><div class="grid">${finals.map(f => `
    <div class="card final"><img src="${f.slug}/${f.file}" alt="${escapeHtml(f.name)}" /><div class="meta"><div class="title">${escapeHtml(f.name)}</div><div class="dim">${(f.bytes/1024).toFixed(0)}KB · ${escapeHtml(f.style)}</div></div></div>`).join('')}</div></section>`;
  const ordered = [
    ...PRIORITY_SLUGS.map(s => manifest.locations.find(l => l.slug === s)).filter(Boolean),
    ...ASSET_SLUGS.map(s => manifest.locations.find(l => l.slug === s)).filter(Boolean),
    ...manifest.locations.filter(l => !FINAL_SLUGS.includes(l.slug)),
  ];
  const sections = ordered.map(loc => {
    const isPriority = PRIORITY_SLUGS.includes(loc.slug);
    const isAsset = ASSET_SLUGS.includes(loc.slug);
    const wmCards = (loc.candidates || []).map(c => `
    <div class="card"><img src="${loc.slug}/${c.file}" alt="${escapeHtml(c.title || c.file)}" /><div class="meta"><div class="title">${escapeHtml(c.title || c.file)}</div><div class="dim">${(c.bytes / 1024).toFixed(0)}KB · ${escapeHtml(c.dateOriginal || 'undated')}</div></div></div>`).join('');
    const aiCards = (loc.ai_candidates || []).filter(keep).map(c => `
    <div class="card ai"><img src="${loc.slug}/${c.file}" alt="${escapeHtml(c.style)}" /><div class="meta"><div class="title">AI · ${escapeHtml(c.style)}</div><div class="dim">${(c.bytes / 1024).toFixed(0)}KB${c.basedOn ? ' · edit of ' + escapeHtml(c.basedOn) : ''}</div><details><summary>Prompt</summary><div class="desc">${escapeHtml(c.prompt || '')}</div></details></div></div>`).join('');
    const cls = isAsset ? 'asset' : (isPriority ? 'priority' : '');
    const flag = isAsset ? '🎨 ' : (isPriority ? '⭐ ' : '');
    return `<section class="${cls}"><h2>${flag}${escapeHtml(loc.location_name)} <span class="dim">(${(loc.candidates||[]).length} Wikimedia · ${(loc.ai_candidates||[]).filter(keep).length} AI)</span></h2><div class="grid">${wmCards}${aiCards}</div>${(!wmCards && !aiCards) ? '<em>No candidates.</em>' : ''}</section>`;
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Tell location curation</title><style>body{font-family:-apple-system,sans-serif;max-width:1400px;margin:1em auto;padding:0 1em}section{margin:2em 0;border-top:2px solid #ddd;padding-top:1em}section.priority{background:#fef9c3;padding:1em;border-radius:8px;border-top:4px solid #ca8a04}section.asset{background:#dcfce7;padding:1em;border-radius:8px;border-top:4px solid #15803d}section.finals{background:#1e293b;color:#fff;padding:1em;border-radius:8px;border-top:6px solid #f59e0b}section.finals h2{color:#fde68a}h2{margin:0 0 .5em 0}.dim{color:#666;font-size:.85em}section.finals .dim{color:#cbd5e1}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:1em}.card{border:1px solid #ccc;padding:.5em;background:#fff}.card.ai{border:2px solid #2563eb;background:#eff6ff}.card.final{border:3px solid #f59e0b;background:#0f172a;color:#fff}.card img{width:100%;height:340px;object-fit:contain;background:#f5f5f5;display:block}.card.final img{background:#000}.meta{padding:.5em 0}.title{font-weight:600;word-break:break-word}.desc{font-size:.85em;margin:.5em 0;color:#333}details summary{cursor:pointer;color:#2563eb}</style></head><body><h1>Wilhelm Tell — landmark curation</h1><p>★ Final story images at the top. ⭐ Priority sections (full history). 🎨 Story assets.</p>${finalsHtml}${sections}</body></html>`;
}
function escapeHtml(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
