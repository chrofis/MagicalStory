#!/usr/bin/env node
/**
 * Refine Tell location curation:
 *   - Regenerate Tellsplatte watercolor with corrections (higher rock, more
 *     waves, dramatic-but-not-black stormy sky).
 *   - Re-render review.html with watercolor-only filter and ordered so the
 *     priority locations (Altdorf, Apple Shot, Tellsplatte, Hohle Gasse) are
 *     at the top. Lithograph variants are hidden in the watercolor view.
 *
 * Manifest is preserved as-is (lithographs still on disk, just not shown).
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { generateWithGrok } = require('../../server/lib/grok');

const OUT_DIR = path.resolve(__dirname, '..', '..', 'tests', 'tell-curated');

// Generation: just Tellsplatte watercolor, refined.
const REGEN = {
  slug: 'tellsplatte-boat-jump',
  style: 'watercolor-v3',
  prompt: 'Tellsplatte on Lake Uri (Vierwaldstättersee) in a violent rainstorm at dusk. Foreground RIGHT: a substantial RAISED ROCK SHELF — tall and craggy rather than flat, rising about a metre or more above the waterline with a flat top surface big enough for a person to stand on; smooth wet stone wrapping the elevated platform, dark crevices below. Foreground LEFT: a LARGE wooden rowboat with a high curved prow, riding HIGH CHOPPY WAVES with white spray and foam crests, only one body-length away from the rock shelf — clearly close enough that someone could leap from the boat onto the raised platform. The lake surface is alive with churning waves, whitecaps, dark green-grey water. Sky: dramatic dark grey storm clouds with broken light pushing through — moody and ominous but NOT pitch black, varied tones of slate, charcoal, dark plum, with a sliver of pale gold where weak light breaks through. Heavy diagonal rain visible across the scene, mist rising off the water. Steep wooded cliffs and a small cliffside chapel barely visible behind the rock through the rain; jagged alpine peaks deep in the storm clouds. NO PEOPLE, NO ANIMALS — empty boat, empty rock. Style: 19th-century romantic Swiss landscape watercolor, brown ink outlines, dramatic stormy palette, atmospheric mist and rain, Caspar Wolf influence. Single edge-to-edge illustration, no borders, no text.'
};

// Render order (top first). Anything not listed is appended at the bottom.
const PRIORITY_SLUGS = [
  'marktplatz-altdorf',
  'apple-shot-altdorf',
  'tellsplatte-boat-jump',
  'hohle-gasse-kuessnacht',
];

(async () => {
  const manifestPath = path.join(OUT_DIR, 'manifest.json');
  let manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  // ── Regenerate Tellsplatte watercolor v3 ──────────────────────────────
  console.log(`\n=== REFINE: ${REGEN.slug} (${REGEN.style}) ===`);
  const sceneDir = path.join(OUT_DIR, REGEN.slug);
  const existing = fs.readdirSync(sceneDir).filter(f => /^ai-\d+-/.test(f));
  const idx = String(existing.length + 1).padStart(2, '0');
  const result = await generateWithGrok(REGEN.prompt, { aspectRatio: '4:3', resolution: '1k' });
  if (!result?.imageData) throw new Error('Grok returned no imageData');
  const b64 = result.imageData.replace(/^data:image\/\w+;base64,/, '');
  const buf = Buffer.from(b64, 'base64');
  const fname = `ai-${idx}-${REGEN.style}.jpg`;
  fs.writeFileSync(path.join(sceneDir, fname), buf);
  console.log(`  ${idx}-${REGEN.style}: ${(buf.length / 1024).toFixed(0)}KB written`);

  const loc = manifest.locations.find(l => l.slug === REGEN.slug);
  if (loc) {
    loc.ai_candidates = [...(loc.ai_candidates || []), {
      file: fname,
      style: REGEN.style,
      prompt: REGEN.prompt,
      generatedBy: 'grok-imagine',
      bytes: buf.length,
    }];
  }

  // ── Reorder + write filtered review.html ──────────────────────────────
  const ordered = [
    ...PRIORITY_SLUGS.map(s => manifest.locations.find(l => l.slug === s)).filter(Boolean),
    ...manifest.locations.filter(l => !PRIORITY_SLUGS.includes(l.slug)),
  ];
  fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, locations: ordered }, null, 2));

  const html = renderReviewHtml({ ...manifest, locations: ordered });
  fs.writeFileSync(path.join(OUT_DIR, 'review.html'), html);
  console.log(`\n✅ Done. Refresh:`);
  console.log(`   file:///${path.join(OUT_DIR, 'review.html').replace(/\\/g, '/')}`);
})().catch(e => { console.error(e); process.exit(1); });

function renderReviewHtml(manifest) {
  // Watercolor-only filter — show only AI cards whose style includes "watercolor"
  // or "composition-watercolor". Wikimedia cards are kept (they're not styled).
  const isWatercolor = c => /watercolor/.test(c.style || '');

  const sections = manifest.locations.map((loc, i) => {
    const isPriority = PRIORITY_SLUGS.includes(loc.slug);
    const wmCards = (loc.candidates || []).map(c => `
    <div class="card">
      <img src="${loc.slug}/${c.file}" alt="${escapeHtml(c.title || c.file)}" />
      <div class="meta">
        <div class="title">${escapeHtml(c.title || c.file)}</div>
        <div class="dim">${c.width || ''}${c.width ? '×' : ''}${c.height || ''} · ${(c.bytes / 1024).toFixed(0)}KB · ${escapeHtml(c.dateOriginal || 'undated')}</div>
        ${c.artist ? `<div class="dim">Artist: ${escapeHtml(c.artist).slice(0, 80)}</div>` : ''}
        ${c.license ? `<div class="dim">License: ${escapeHtml(c.license)}</div>` : ''}
        ${c.wikimediaUrl ? `<a href="${c.wikimediaUrl}" target="_blank">source</a>` : ''}
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
<p>⭐ Priority locations at the top. Lithograph variants on disk but hidden from this view.</p>
${sections}
</body></html>`;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
