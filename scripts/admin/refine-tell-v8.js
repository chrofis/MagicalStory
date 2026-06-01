#!/usr/bin/env node
/**
 * Refine round 8 — A4 PORTRAIT for panorama + split Altdorf into market/apple-shot.
 *
 * Altdorf Panorama: portrait again (1 image back).
 * Marktplatz Altdorf: medieval square with HAT on POLE (Gessler's hat).
 * Apple Shot: remove all figures on the right, only LEFT-side crowd, no one near tree.
 * Tellsplatte: stone TRULY part of cliff (continuous rock), ship to the RIGHT of the
 *              stone (not in front, not behind), boat and stone similar height.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { generateWithGrok } = require('../../server/lib/grok');

const OUT_DIR = path.resolve(__dirname, '..', '..', 'tests', 'tell-curated');

const REGENS = [
  {
    slug: 'altdorf-panorama',
    style: 'watercolor-v3-a4portrait',
    prompt: 'A4 PORTRAIT 3:4 vertical composition. Panoramic view of medieval Altdorf in canton Uri, late 14th century, seen from a slight elevation. Foreground (lower third): wide alpine MEADOW with grasses and wildflowers, sloping gently toward the village. Middle ground: the medieval village of Altdorf — a cluster of timber-frame houses with steep shingled roofs, a stone parish church with a tall bell tower, narrow cobbled lanes between the buildings, smoke rising from a few chimneys. The settlement nestles at the base of the mountains. Background (upper half): TOWERING SNOW-CAPPED URI ALPS rising dramatically — sharp grey peaks with white snowfields, lower slopes of dark conifer forest. Soft afternoon alpine light, hazy atmospheric depth. Style: 19th-century romantic Swiss landscape watercolor, brown ink outlines, muted earth tones, soft warm light, atmospheric. Single edge-to-edge illustration, no borders, no text.'
  },
  {
    slug: 'marktplatz-altdorf',
    style: 'watercolor-v2-a4portrait-hat-pole',
    prompt: 'A4 PORTRAIT 3:4 vertical composition. Medieval marketplace of Altdorf in canton Uri, late 14th century. CENTER OF THE SQUARE: a tall wooden POLE planted upright in the cobblestones, roughly 4 metres high, and atop the pole sits a fine FEATHERED HAT — a wide-brimmed velvet hat with a long ostrich plume, clearly the hat of a nobleman (Gessler\'s hat of authority). The pole is the focal point, prominent in the middle of the square. Around it: cobblestoned town square, medieval timber-frame houses with steep shingled roofs ringing the square, a stone parish church bell tower visible behind the rooftops. A few peasant figures walk the periphery of the square in 14th-century Swiss costume — tunics, hooded cloaks — but the centre by the pole is open, empty, deliberately bare so the hat is unmissable. Background: snow-capped Uri Alps rising behind the village rooftops. Soft warm afternoon light. Style: 19th-century romantic Swiss watercolor, brown ink outlines, soft warm palette, atmospheric. Single edge-to-edge illustration, no borders, no text.'
  },
  {
    slug: 'apple-shot-altdorf',
    style: 'composition-v7-a4portrait-no-right-figures',
    prompt: 'A4 PORTRAIT 3:4 vertical composition. Medieval Altdorf scene of the apple shot, late afternoon under soft warm light. RIGHT BACKGROUND (deep, far): a TALL LIME TREE — prominent thick trunk, set well back in the middle-distance, dominating the right side at depth. A small CHILD silhouette stands motionless against the trunk with an apple balanced on his head. ABSOLUTELY NO OTHER FIGURES anywhere on the right side or near the tree — the tree and the child are completely isolated, with empty space and cobblestones around them. CENTER FOREGROUND: open empty cobblestoned ground stretching across the bottom of the frame, EMPTY (no figure drawn). LEFT HALF ONLY: a CLUSTERED CROWD of medieval Swiss observers — peasants, soldiers, townsfolk grouped together as a tight informal cluster (NOT lined up, NOT in a row), tense and watching. The crowd fills only the LEFT third-to-half of the image, NEVER spilling into the centre or right side. The figures wear period 14th-century medieval Swiss costume — tunics, hooded cloaks, peasant garb, soldiers in chainmail and tabards. Faces are SMALL but VISIBLE (eyes and tense expressions readable, but not portraits). Behind the crowd: medieval timber-frame houses ringing the square, snow-capped Uri Alps in the far background. Style: 19th-century romantic Swiss watercolor, brown ink outlines, soft warm afternoon light, atmospheric depth. Single edge-to-edge illustration, no borders, no text.'
  },
  {
    slug: 'tellsplatte-boat-jump',
    style: 'watercolor-v10-a4portrait-stone-fused',
    prompt: 'A4 PORTRAIT 3:4 vertical composition. Tellsplatte on Lake Uri in heavy alpine rainstorm, late afternoon stormy light. LEFT TWO-THIRDS of the canvas: a SHEER ALPINE CLIFF WALL of grey rock rising tall up the entire left side — exposed grey stone with conifers (fir, spruce) clinging to ledges, distinctly Swiss alpine character. The cliff continues DOWN to the waterline and EXTENDS OUT into the lake as a ROCKY PROMONTORY — the stone shelf is GEOLOGICALLY CONTINUOUS with the cliff, the SAME ROCK, no gap, no water between cliff and shelf, clearly one fused mass of stone. The promontory ends in a flat top about 1-1.5 metres above the choppy waterline, projecting toward the right. RIGHT OF THE PROMONTORY: a LARGE wooden rowboat shown broadside (long axis horizontal left-to-right), sitting in the water IMMEDIATELY TO THE RIGHT of the stone shelf — not in front of it, not behind it, but beside it on the right. The boat\'s gunwale (top edge) is at roughly the SAME HEIGHT as the top of the rock shelf, so a person could step or jump sideways from boat to rock. Only inches of choppy whitecapped water separate boat from rock. Lake surface alive with whitecaps, dark green-grey water. HEAVY DIAGONAL RAIN STREAKS visible across the entire scene. Sky: dark stormy charcoal-slate clouds with diffused light filtering through, dramatic but NOT pitch black, atmospheric pale silver patches behind the dark clouds. NO PEOPLE — empty boat, empty rock. Style: 19th-century romantic Swiss landscape watercolor, brown ink outlines, dramatic stormy palette, alpine character, heavy visible rain. Single edge-to-edge illustration, no borders, no text.'
  }
];

const PRIORITY_SLUGS = [
  'altdorf-panorama', 'marktplatz-altdorf', 'apple-shot-altdorf',
  'tellsplatte-boat-jump', 'hohle-gasse-kuessnacht', 'tellshaus-buerglen',
];

(async () => {
  const manifestPath = path.join(OUT_DIR, 'manifest.json');
  let manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  for (const r of REGENS) {
    console.log(`\n=== GEN A4 PORTRAIT v8: ${r.slug} (${r.style}) ===`);
    const sceneDir = path.join(OUT_DIR, r.slug);
    if (!fs.existsSync(sceneDir)) fs.mkdirSync(sceneDir, { recursive: true });
    const existing = fs.readdirSync(sceneDir).filter(f => /^ai-\d+-/.test(f));
    const idx = String(existing.length + 1).padStart(2, '0');
    try {
      const result = await generateWithGrok(r.prompt, { aspectRatio: '3:4', resolution: '1k' });
      if (!result?.imageData) { console.log('  FAILED'); continue; }
      const b64 = result.imageData.replace(/^data:image\/\w+;base64,/, '');
      const buf = Buffer.from(b64, 'base64');
      const fname = `ai-${idx}-${r.style}.jpg`;
      fs.writeFileSync(path.join(sceneDir, fname), buf);
      console.log(`  ${idx}-${r.style}: ${(buf.length / 1024).toFixed(0)}KB`);
      const loc = manifest.locations.find(l => l.slug === r.slug);
      if (loc) {
        loc.ai_candidates = [...(loc.ai_candidates || []), {
          file: fname, style: r.style, prompt: r.prompt, generatedBy: 'grok-imagine', bytes: buf.length,
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
  return `<!doctype html><html><head><meta charset="utf-8"><title>Tell location curation</title><style>body{font-family:-apple-system,sans-serif;max-width:1400px;margin:1em auto;padding:0 1em}section{margin:2em 0;border-top:2px solid #ddd;padding-top:1em}section.priority{background:#fef9c3;padding:1em;border-radius:8px;border-top:4px solid #ca8a04}h2{margin:0 0 .5em 0}.dim{color:#666;font-size:.85em}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:1em}.card{border:1px solid #ccc;padding:.5em;background:#fff}.card.ai{border:2px solid #2563eb;background:#eff6ff}.card img{width:100%;height:340px;object-fit:contain;background:#f5f5f5;display:block}.meta{padding:.5em 0}.title{font-weight:600;word-break:break-word}.desc{font-size:.85em;margin:.5em 0;color:#333}details summary{cursor:pointer;color:#2563eb}</style></head><body><h1>Wilhelm Tell — landmark curation</h1><p>⭐ Priority locations at the top. Round 8: A4 portrait, market with hat-on-pole, apple shot left-only, Tellsplatte stone fused with cliff.</p>${sections}</body></html>`;
}
function escapeHtml(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
