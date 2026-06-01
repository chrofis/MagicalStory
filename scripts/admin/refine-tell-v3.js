#!/usr/bin/env node
/**
 * Refine round 3:
 *   - Tellsplatte: rock is part of the SHORE (not an island), boat on the LEFT
 *     pointing RIGHT toward the stone (boat's prow aimed at the rock).
 *   - Hohle Gasse: banks much higher and steeper — narrow trap, NO escape
 *     possible left or right.
 *
 * 4 priority locations confirmed (kept distinct):
 *   1. Marktplatz Altdorf — empty town square (Heinzmann 1801 etching)
 *   2. Apple Shot — forest clearing, separate setting from marketplace
 *   3. Tellsplatte — shore boulder + boat
 *   4. Hohle Gasse — sunken footpath
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { generateWithGrok } = require('../../server/lib/grok');

const OUT_DIR = path.resolve(__dirname, '..', '..', 'tests', 'tell-curated');

const REGENS = [
  {
    slug: 'tellsplatte-boat-jump',
    style: 'watercolor-v5',
    prompt: 'Tellsplatte on Lake Uri (Vierwaldstättersee) in heavy rainstorm at dusk. RIGHT SIDE of the composition: a steep wooded SHORELINE rising out of the lake — dark forest on the cliff above, and at the waterline a LARGE NATURAL BOULDER outcrop that is PART OF THE SHORE itself, NOT a floating island in the water. The boulder is an irregular weathered slab of grey stone with lichen and moss, sloping naturally up from the lake into the steep tree-covered bank, clearly attached to and continuous with the shore behind it. LEFT-CENTER FOREGROUND: a LARGE wooden rowboat with a high curved prow oriented horizontally, facing RIGHT — the prow aimed directly TOWARD the shoreline boulder, only one body-length away across the choppy water. The boat is in the open lake, the boulder/shore on the right. Heavy diagonal RAIN STREAKS visible across the entire scene, whitecaps on the dark water, mist over the lake. Sky: dramatic stormy slate-charcoal-plum tones with weak light breaking through, ominous but NOT pitch black. A small alpine chapel just visible high on the cliff above the boulder through the rain. NO PEOPLE — empty boat, empty rock, only the boat aimed at the shore boulder is the visual story. Style: 19th-century romantic Swiss landscape watercolor, brown ink outlines, dramatic stormy palette, atmospheric mist, visible rain streaks, Caspar Wolf influence. Single edge-to-edge illustration, no borders, no text.'
  },
  {
    slug: 'hohle-gasse-kuessnacht',
    style: 'watercolor-v4',
    prompt: 'A medieval Hohle Gasse near Küssnacht — a deep CARVED-IN sunken footpath running DIAGONALLY from lower-left up to upper-right. The path is a NARROW SINGLE-FILE TRAP, only wide enough for one person. Earth-and-rock BANKS RISE STEEPLY AND HIGH on BOTH sides — at least 3-4 metres tall, almost vertical, packed with exposed roots, moss, and ferns clinging to the walls. The walls are so high and steep that there is NO ESCAPE possible left or right — a person walking the path is completely enclosed in the deep cut. Mature beech trees lean over from the very top of both banks far above, casting the path into deep dappled shade. At the FAR UPPER-RIGHT END where the path bends out of sight, a TINY DISTANT SILHOUETTE of a horse and rider — small dark shape at the vanishing point, a Habsburg knight slowly approaching down the trapped path. Style: 19th-century romantic Swiss landscape watercolor, soft diffused light filtering down from above, brown ink outlines, mossy green and warm brown washes, claustrophobic atmospheric depth, fine detail at the distant rider. Single edge-to-edge illustration, no borders, no text.'
  }
];

const PRIORITY_SLUGS = [
  'marktplatz-altdorf',
  'apple-shot-altdorf',
  'tellsplatte-boat-jump',
  'hohle-gasse-kuessnacht',
];

(async () => {
  const manifestPath = path.join(OUT_DIR, 'manifest.json');
  let manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  for (const r of REGENS) {
    console.log(`\n=== ${r.slug} (${r.style}) ===`);
    const sceneDir = path.join(OUT_DIR, r.slug);
    if (!fs.existsSync(sceneDir)) fs.mkdirSync(sceneDir, { recursive: true });
    const existing = fs.readdirSync(sceneDir).filter(f => /^ai-\d+-/.test(f));
    const idx = String(existing.length + 1).padStart(2, '0');
    try {
      const result = await generateWithGrok(r.prompt, { aspectRatio: '4:3', resolution: '1k' });
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
    } catch (e) {
      console.log(`  FAILED — ${e.message.slice(0, 200)}`);
    }
  }

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'review.html'), renderReviewHtml(manifest));
  console.log(`\n✅ Done. Refresh:`);
  console.log(`   file:///${path.join(OUT_DIR, 'review.html').replace(/\\/g, '/')}`);
})().catch(e => { console.error(e); process.exit(1); });

function renderReviewHtml(manifest) {
  const isWatercolor = c => /watercolor/.test(c.style || '');
  const ordered = [
    ...PRIORITY_SLUGS.map(s => manifest.locations.find(l => l.slug === s)).filter(Boolean),
    ...manifest.locations.filter(l => !PRIORITY_SLUGS.includes(l.slug)),
  ];
  const sections = ordered.map(loc => {
    const isPriority = PRIORITY_SLUGS.includes(loc.slug);
    const wmCards = (loc.candidates || []).map(c => `
    <div class="card">
      <img src="${loc.slug}/${c.file}" alt="${escapeHtml(c.title || c.file)}" />
      <div class="meta">
        <div class="title">${escapeHtml(c.title || c.file)}</div>
        <div class="dim">${c.width || ''}${c.width ? '×' : ''}${c.height || ''} · ${(c.bytes / 1024).toFixed(0)}KB · ${escapeHtml(c.dateOriginal || 'undated')}</div>
        ${c.artist ? `<div class="dim">Artist: ${escapeHtml(c.artist).slice(0, 80)}</div>` : ''}
      </div>
    </div>`).join('');
    const aiCards = (loc.ai_candidates || []).filter(isWatercolor).map(c => `
    <div class="card ai">
      <img src="${loc.slug}/${c.file}" alt="${escapeHtml(c.style)}" />
      <div class="meta">
        <div class="title">AI · ${escapeHtml(c.style)}</div>
        <div class="dim">${(c.bytes / 1024).toFixed(0)}KB</div>
        <details><summary>Prompt</summary><div class="desc">${escapeHtml(c.prompt)}</div></details>
      </div>
    </div>`).join('');
    return `
  <section class="${isPriority ? 'priority' : ''}">
    <h2>${isPriority ? '⭐ ' : ''}${escapeHtml(loc.location_name)} <span class="dim">(${(loc.candidates||[]).length} Wikimedia · ${(loc.ai_candidates||[]).filter(isWatercolor).length} AI watercolor)</span></h2>
    <div class="grid">${wmCards}${aiCards}</div>
    ${(!wmCards && !aiCards) ? '<em>No candidates.</em>' : ''}
  </section>`;
  }).join('');

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Tell location curation</title>
<style>
body { font-family: -apple-system, sans-serif; max-width: 1400px; margin: 1em auto; padding: 0 1em; }
section { margin: 2em 0; border-top: 2px solid #ddd; padding-top: 1em; }
section.priority { background: #fef9c3; padding: 1em; border-radius: 8px; border-top: 4px solid #ca8a04; }
h2 { margin: 0 0 0.5em 0; }
.dim { color: #666; font-size: 0.85em; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 1em; }
.card { border: 1px solid #ccc; padding: 0.5em; background: #fff; }
.card.ai { border: 2px solid #2563eb; background: #eff6ff; }
.card img { width: 100%; height: 240px; object-fit: contain; background: #f5f5f5; display: block; }
.meta { padding: 0.5em 0; }
.title { font-weight: 600; word-break: break-word; }
.desc { font-size: 0.85em; margin: 0.5em 0; color: #333; }
details summary { cursor: pointer; color: #2563eb; }
</style></head><body>
<h1>Wilhelm Tell — landmark curation (watercolor only)</h1>
<p>⭐ Priority locations at the top. 4 needed: Marktplatz Altdorf, Apple Shot, Tellsplatte, Hohle Gasse.</p>
${sections}
</body></html>`;
}
function escapeHtml(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
