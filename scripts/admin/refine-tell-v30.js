#!/usr/bin/env node
/**
 * Refine round 30 —
 *   1. Delete the unwanted ai-22 bauen-pano boat from tellsplatte-boat-jump.
 *   2. Generate two story assets: the hat (same as on the pole) + the
 *      Armbrust (medieval crossbow), as standalone watercolor illustrations.
 *   3. Rebuild review.html with a new "Story Final Images" section at the
 *      top showing the latest AI candidate of each priority slug.
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

const ASSETS = [
  {
    slug: 'story-asset-hat',
    location_name: 'Story asset — Gessler\'s feathered hat',
    refSourcePath: path.join(OUT_DIR, 'marktplatz-altdorf', 'ai-04-composed-v5-pole-somewhat-shorter.jpg'),
    style: 'watercolor-v1-hat-isolated',
    editPrompt: 'Take the FEATHERED VELVET HAT from the top of the pole in this marketplace scene and produce a NEW illustration showing JUST THAT HAT, isolated on a plain off-white background. The hat is the same wide-brimmed velvet hat with a long ostrich plume that sits on the pole — render it as a standalone object portrait, full hat visible, three-quarter view, the same 19th-century romantic Swiss watercolor style with brown ink outlines, soft warm light, no other elements (no pole, no square, no buildings, no figures). A4 portrait composition. Single edge-to-edge illustration on plain off-white watercolor background, no borders, no text.'
  },
  {
    slug: 'story-asset-armbrust',
    location_name: 'Story asset — Armbrust (medieval crossbow)',
    refSourcePath: path.join(OUT_DIR, 'apple-shot-altdorf', 'ai-13-composition-v10-crowd-market-chaotic.jpg'),
    style: 'watercolor-v1-armbrust-isolated',
    editPrompt: 'Use the watercolor style of this reference image (19th-century romantic Swiss watercolor, brown ink outlines, soft warm light) but produce a completely NEW illustration of a SINGLE MEDIEVAL ARMBRUST (crossbow) — the kind Wilhelm Tell would have used in 14th-century Switzerland. Wooden stock with carved details, steel prod (the bow), drawstring, a single bolt loaded in the groove. The crossbow is shown in three-quarter view, full weapon visible from end to end, isolated on a plain off-white watercolor background. No other elements, no figures, no scene. A4 portrait composition. Single edge-to-edge illustration on plain off-white background, no borders, no text.'
  }
];

(async () => {
  const manifestPath = path.join(OUT_DIR, 'manifest.json');
  let manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  // ─── 1. Delete the unwanted bauen-pano boat from tellsplatte-boat-jump ───
  const tsLoc = manifest.locations.find(l => l.slug === 'tellsplatte-boat-jump');
  if (tsLoc) {
    const before = (tsLoc.ai_candidates || []).length;
    tsLoc.ai_candidates = (tsLoc.ai_candidates || []).filter(c => c.style !== 'watercolor-v20-boat-on-lake-from-bauen-pano');
    console.log(`Removed ${before - tsLoc.ai_candidates.length} bauen-pano candidate from tellsplatte-boat-jump manifest`);
  }
  const bauenPanoFile = path.join(OUT_DIR, 'tellsplatte-boat-jump', 'ai-22-watercolor-v20-boat-on-lake-from-bauen-pano.jpg');
  if (fs.existsSync(bauenPanoFile)) {
    fs.unlinkSync(bauenPanoFile);
    console.log(`Deleted ${path.basename(bauenPanoFile)}`);
  }

  // ─── 2. Generate hat + armbrust assets ───
  for (const a of ASSETS) {
    if (!manifest.locations.find(l => l.slug === a.slug)) {
      manifest.locations.push({
        slug: a.slug, location_name: a.location_name, location_query: a.location_name,
        location_type: 'asset', aliases: [], candidates: [], ai_candidates: [],
      });
    }
    console.log(`\n=== ASSET: ${a.slug} (${a.style}) ===`);
    if (!fs.existsSync(a.refSourcePath)) { console.log(`  SKIP: ref not found`); continue; }
    const refBuf = fs.readFileSync(a.refSourcePath);
    const refDataUri = `data:image/jpeg;base64,${refBuf.toString('base64')}`;
    const sceneDir = path.join(OUT_DIR, a.slug);
    if (!fs.existsSync(sceneDir)) fs.mkdirSync(sceneDir, { recursive: true });
    const existing = fs.readdirSync(sceneDir).filter(f => /^ai-\d+-/.test(f));
    const idx = String(existing.length + 1).padStart(2, '0');
    try {
      const result = await editWithGrok(a.editPrompt, [refDataUri], { aspectRatio: '3:4' });
      if (!result?.imageData) { console.log('  FAILED'); continue; }
      const b64 = result.imageData.replace(/^data:image\/\w+;base64,/, '');
      const buf = Buffer.from(b64, 'base64');
      const fname = `ai-${idx}-${a.style}.jpg`;
      fs.writeFileSync(path.join(sceneDir, fname), buf);
      console.log(`  ${idx}-${a.style}: ${(buf.length / 1024).toFixed(0)}KB`);
      const loc = manifest.locations.find(l => l.slug === a.slug);
      if (loc) {
        loc.ai_candidates = [...(loc.ai_candidates || []), {
          file: fname, style: a.style, prompt: a.editPrompt, basedOn: path.basename(a.refSourcePath),
          generatedBy: 'grok-imagine-edit', bytes: buf.length,
        }];
      }
    } catch (err) {
      console.log(`  FAILED — ${err.message.slice(0, 200)}`);
    }
  }

  // ─── 3. Save manifest + render review with finals at top ───
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'review.html'), renderReviewHtml(manifest));
  console.log(`\n✅ Done. Refresh:`);
  console.log(`   file:///${path.join(OUT_DIR, 'review.html').replace(/\\/g, '/')}`);
})().catch(e => { console.error(e); process.exit(1); });

function renderReviewHtml(manifest) {
  const keep = c => !/lithograph/i.test(c.style || '');
  const ASSET_SLUGS = ['story-asset-hat', 'story-asset-armbrust'];
  const FINAL_SLUGS = [...PRIORITY_SLUGS, ...ASSET_SLUGS];

  // Latest AI candidate per slug for the "Final Story Images" top section.
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
