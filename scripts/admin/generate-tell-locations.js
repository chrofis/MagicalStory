#!/usr/bin/env node
/**
 * Generate AI period-style LANDSCAPE references for Wilhelm Tell locations
 * where Wikimedia search came up short or only returned figure-portraits.
 *
 * Each prompt focuses on the LANDSCAPE / SETTING (no figures) so the
 * output works as a location reference for Grok during story generation.
 * Style is biased toward 19th-century Swiss landscape lithograph /
 * watercolor — period-accurate without being photographic.
 *
 * Output:
 *   tests/tell-curated/<slug>/ai-01-<style>.jpg
 *   tests/tell-curated/manifest.json (appended with ai_candidates)
 *   tests/tell-curated/review.html (regenerated to include AI picks)
 *
 * Cost: ~$0.02 per image × 3 locations × 2 variants = ~$0.12
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { generateWithGrok } = require('../../server/lib/grok');

const OUT_DIR = path.resolve(__dirname, '..', '..', 'tests', 'tell-curated');

// Three problem locations, two variants each (different period style angle)
const SCENES = [
  {
    slug: 'apple-shot-altdorf',
    location_name: 'Apple Shot Scene (Altdorf marketplace)',
    location_query: 'Marktplatz Altdorf apple shot',
    location_type: 'Square',
    aliases: ['altdorf market square apple shot', 'tell apfelschuss altdorf', 'altdorf platz hut on pole'],
    variants: [
      {
        style: 'lithograph',
        prompt: 'Empty 14th-century Altdorf market square in canton Uri, Switzerland. Wide cobblestone plaza surrounded by tall steep-roofed timber-frame houses with overhanging upper floors and small shuttered windows. A single tall wooden pole stands prominently in the center of the square with a felt hat resting on top. A medieval church spire visible on the left, the snow-capped Uri Alps rising in the background. NO PEOPLE, NO ANIMALS — empty plaza only. Style: 19th-century Swiss landscape lithograph, fine ink linework, restrained earthy color wash (sepia, ochre, slate grey), atmospheric distance haze, hand-engraved feel. Single illustration filling the canvas, no borders, no text.'
      },
      {
        style: 'watercolor',
        prompt: 'Empty 14th-century Altdorf marketplace, canton Uri, Switzerland. Cobblestone square ringed by medieval timber-frame burgher houses with steep tiled roofs. A weathered wooden pole stands in the middle of the square topped with a green felt hat. Church tower in the background, alpine peaks beyond. NO PEOPLE, NO ANIMALS — landscape only. Style: 19th-century romantic Swiss landscape watercolor in the manner of J.J. Wetzel — soft light, muted earth-tone palette, brown ink outlines, washed sky. Single edge-to-edge illustration, no borders, no text.'
      }
    ]
  },
  {
    slug: 'tellsplatte-boat-jump',
    location_name: 'Tellsplatte (boat jump landscape)',
    location_query: 'Tellsplatte Lake Uri',
    location_type: 'Historic Site',
    aliases: ["tell's leap", 'tellsplatte', 'tellsprung', 'tells sprung'],
    variants: [
      {
        style: 'lithograph',
        prompt: 'Rocky lakeshore on Lake Uri (Vierwaldstättersee) at dusk during a violent storm. A flat low rock shelf protrudes from steep wooded cliffs above the water, with a small wooden chapel-like structure in the trees on the cliff face. A single wooden rowing boat rocks on choppy dark grey-green waves a short distance from the shelf. Forested mountainsides rise sharply on the far shore, snow on the higher peaks. Heavy storm clouds, rain in the distance. NO PEOPLE — empty boat, empty rock. Style: 19th-century Swiss landscape lithograph, dramatic light, fine line engraving with subtle sepia and slate-blue wash, atmospheric perspective. Single illustration, edge-to-edge, no borders, no text.'
      },
      {
        style: 'watercolor',
        prompt: 'Lake Uri at the Tellsplatte, Switzerland, dusk under storm. Steep wooded cliffs drop into dark choppy water; a low flat rock ledge juts out near the shore with a small alpine chapel set back among the trees on the cliff. A wooden rowboat drifts close to the rocks, oars trailing in the water, no one aboard. Low storm clouds, distant rain over the lake, snow-covered peaks of the Schwyz Alps in the far background. NO PEOPLE. Style: 19th-century romantic Swiss landscape watercolor, dramatic stormy atmosphere, brown ink outlines, blue-grey and forest-green washes. Single edge-to-edge illustration, no borders, no text.'
      }
    ]
  },
  {
    slug: 'hohle-gasse-kuessnacht',
    location_name: 'Hohle Gasse (Küssnacht sunken road)',
    location_query: 'Hohle Gasse Küssnacht',
    location_type: 'Historic Site',
    aliases: ['sunken road küssnacht', 'tell ambush', 'hohle gasse'],
    variants: [
      {
        style: 'lithograph',
        prompt: 'A narrow, deep medieval sunken road carved into a mossy hillside near Küssnacht am Rigi, Switzerland. Steep grass-and-fern banks rise tall on both sides, mature beech trees lean in over the path, dappled forest light filtering through. Roots and rocks line the edges; the dirt path winds and disappears around a curve. NO PEOPLE, NO HORSES, NO BUILDINGS visible — only the deep wooded trench. Style: 19th-century Swiss landscape lithograph in the manner of Caspar Wolf — fine ink linework, restrained earth-tone wash (mossy green, brown, ochre), atmospheric depth and light shafts. Single illustration filling the canvas, no borders, no text.'
      },
      {
        style: 'watercolor',
        prompt: 'A medieval Hohle Gasse near Küssnacht: a deep sunken cart-track cutting between high earth banks topped with old beeches, ferns and wild grass spilling over the edges, sunlight breaking through the canopy onto a quiet curved dirt path. NO PEOPLE, NO ANIMALS, NO STRUCTURES — landscape only. Style: 19th-century Swiss romantic landscape watercolor, soft diffused light, brown ink outlines, mossy green and warm brown washes, gentle atmospheric haze. Single edge-to-edge illustration, no borders, no text.'
      }
    ]
  }
];

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  // Load existing manifest if present
  const manifestPath = path.join(OUT_DIR, 'manifest.json');
  let manifest = { generatedAt: new Date().toISOString(), locations: [] };
  if (fs.existsSync(manifestPath)) {
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { /* keep default */ }
  }

  for (const scene of SCENES) {
    console.log(`\n=== AI-GEN: ${scene.location_name} (${scene.slug}) ===`);
    const sceneDir = path.join(OUT_DIR, scene.slug);
    if (!fs.existsSync(sceneDir)) fs.mkdirSync(sceneDir, { recursive: true });

    const aiCandidates = [];
    for (let i = 0; i < scene.variants.length; i++) {
      const v = scene.variants[i];
      const idx = String(i + 1).padStart(2, '0');
      try {
        const result = await generateWithGrok(v.prompt, { aspectRatio: '4:3', resolution: '1k' });
        if (!result?.imageData) {
          console.log(`  ${idx}-${v.style}: FAILED (no imageData)`);
          continue;
        }
        // Strip data: prefix if present, decode base64, write JPG
        const b64 = result.imageData.replace(/^data:image\/\w+;base64,/, '');
        const buf = Buffer.from(b64, 'base64');
        const fname = `ai-${idx}-${v.style}.jpg`;
        fs.writeFileSync(path.join(sceneDir, fname), buf);
        console.log(`  ${idx}-${v.style}: ${(buf.length / 1024).toFixed(0)}KB written`);
        aiCandidates.push({
          file: fname,
          style: v.style,
          prompt: v.prompt,
          generatedBy: 'grok-imagine',
          bytes: buf.length,
        });
      } catch (e) {
        console.log(`  ${idx}-${v.style}: FAILED — ${e.message.slice(0, 200)}`);
      }
    }

    // Upsert into manifest by slug
    const existing = manifest.locations.find(l => l.slug === scene.slug);
    if (existing) {
      existing.ai_candidates = aiCandidates;
      existing.location_name = scene.location_name;
      existing.location_query = scene.location_query;
      existing.location_type = scene.location_type;
      existing.aliases = scene.aliases;
    } else {
      manifest.locations.push({
        slug: scene.slug,
        location_name: scene.location_name,
        location_query: scene.location_query,
        location_type: scene.location_type,
        aliases: scene.aliases,
        candidates: [],
        ai_candidates: aiCandidates,
      });
    }
  }

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  // Regenerate review.html
  const html = renderReviewHtml(manifest);
  fs.writeFileSync(path.join(OUT_DIR, 'review.html'), html);

  console.log(`\n✅ Done. Open in browser:`);
  console.log(`   file:///${path.join(OUT_DIR, 'review.html').replace(/\\/g, '/')}`);
})().catch(e => { console.error(e); process.exit(1); });

function renderReviewHtml(manifest) {
  const sections = manifest.locations.map(loc => {
    const cards = (loc.candidates || []).map(c => `
    <div class="card">
      <img src="${loc.slug}/${c.file}" alt="${escapeHtml(c.title || c.file)}" />
      <div class="meta">
        <div class="title">${escapeHtml(c.title || c.file)}</div>
        <div class="dim">${c.width || ''}${c.width ? '×' : ''}${c.height || ''} · ${(c.bytes / 1024).toFixed(0)}KB · ${escapeHtml(c.dateOriginal || 'undated')}</div>
        ${c.artist ? `<div class="dim">Artist: ${escapeHtml(c.artist).slice(0, 80)}</div>` : ''}
        ${c.license ? `<div class="dim">License: ${escapeHtml(c.license)}</div>` : ''}
        <div class="desc">${escapeHtml((c.description || '').slice(0, 200))}</div>
        <div class="dim">Query: <em>${escapeHtml(c.query || '')}</em></div>
        ${c.wikimediaUrl ? `<a href="${c.wikimediaUrl}" target="_blank">source</a>` : ''}
      </div>
    </div>`).join('');
    const aiCards = (loc.ai_candidates || []).map(c => `
    <div class="card ai">
      <img src="${loc.slug}/${c.file}" alt="${escapeHtml(c.style)}" />
      <div class="meta">
        <div class="title">AI · ${escapeHtml(c.style)}</div>
        <div class="dim">${(c.bytes / 1024).toFixed(0)}KB · ${escapeHtml(c.generatedBy || '')}</div>
        <details><summary>Prompt</summary><div class="desc">${escapeHtml(c.prompt)}</div></details>
      </div>
    </div>`).join('');
    return `
  <section>
    <h2>${escapeHtml(loc.location_name)} <span class="dim">(${(loc.candidates||[]).length} Wikimedia · ${(loc.ai_candidates||[]).length} AI)</span></h2>
    <div class="grid">${cards}${aiCards}</div>
    ${(!cards && !aiCards) ? '<em>No candidates.</em>' : ''}
  </section>`;
  }).join('');

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Tell location curation</title>
<style>
body { font-family: -apple-system, sans-serif; max-width: 1400px; margin: 1em auto; padding: 0 1em; }
section { margin: 2em 0; border-top: 2px solid #ddd; padding-top: 1em; }
h2 { margin: 0 0 0.5em 0; }
.dim { color: #666; font-size: 0.85em; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 1em; }
.card { border: 1px solid #ccc; padding: 0.5em; }
.card.ai { border: 2px solid #2563eb; background: #eff6ff; }
.card img { width: 100%; height: 240px; object-fit: contain; background: #f5f5f5; display: block; }
.meta { padding: 0.5em 0; }
.title { font-weight: 600; word-break: break-word; }
.desc { font-size: 0.85em; margin: 0.5em 0; color: #333; }
details summary { cursor: pointer; color: #2563eb; }
</style></head><body>
<h1>Wilhelm Tell — landmark curation</h1>
<p>Generated ${escapeHtml(manifest.generatedAt)}. Pick favourites per location and reply with the slug → file mapping.</p>
${sections}
</body></html>`;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
