#!/usr/bin/env node
/**
 * Regenerate three Tell location refs with user-corrected composition:
 *   - Tellsplatte: larger rock platform + larger boat, jumping distance
 *   - Hohle Gasse: path runs DIAGONALLY bottom-left → top-right
 *   - Apple Shot: silhouettes positioned — Walter against tree at right-back,
 *     Tell has empty space on front-left, crowd as shadow silhouettes
 *
 * Output: tests/tell-curated/<slug>/ai-NN-<style>.jpg (continues numbering)
 * Manifest + review.html updated.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { generateWithGrok } = require('../../server/lib/grok');

const OUT_DIR = path.resolve(__dirname, '..', '..', 'tests', 'tell-curated');

const SCENES = [
  {
    slug: 'tellsplatte-boat-jump',
    location_name: 'Tellsplatte (boat jump landscape)',
    variants: [
      {
        style: 'lithograph-v2',
        prompt: 'Lake Uri (Vierwaldstättersee) under a stormy dusk sky. Steep dark wooded cliffs along the shore. PROMINENT FOREGROUND: a LARGE flat rock platform — the Tellsplatte — juts out wide and low into the water occupying the full lower-right third of the image, smooth grey stone wet with spray. A LARGE wooden rowboat sits parallel to the platform, only 2-3 meters away, rocking on choppy dark green-grey waves — the boat is clearly close enough that a person standing in it could jump to the rock. The boat is sized similar to the rock platform, both dominate the foreground. Heavy rain clouds, distant lightning, snowy alps in far background. NO PEOPLE in the boat or on the rock — empty composition showing the JUMP-DISTANCE relationship. Style: 19th-century Swiss landscape lithograph, dramatic stormy light, fine ink linework, sepia and slate-blue wash. Single edge-to-edge illustration, no borders, no text.'
      },
      {
        style: 'watercolor-v2',
        prompt: 'Tellsplatte on Lake Uri under storm dusk. The flat rock shelf is large and prominent in the right-foreground, smooth wet stone extending into the choppy lake. Right next to it, only a body-length away, sits a LARGE wooden rowboat with high curved prow, oars raised, rocking on the dark waves. Both the rock platform and the boat are huge in the composition — the viewer immediately reads "a person could jump from the boat to the rock". Steep wooded cliffs rise behind, alpine peaks in the storm clouds beyond. NO PEOPLE — empty boat, empty rock. Style: 19th-century romantic Swiss landscape watercolor, brown ink outlines, dark blue-green wash, dramatic stormy mood. Single edge-to-edge illustration, no borders, no text.'
      }
    ]
  },
  {
    slug: 'hohle-gasse-kuessnacht',
    location_name: 'Hohle Gasse (Küssnacht sunken road)',
    variants: [
      {
        style: 'lithograph-v2',
        prompt: 'A medieval Hohle Gasse near Küssnacht — a deep sunken cart-track running DIAGONALLY across the composition from the BOTTOM-LEFT corner up to the UPPER-RIGHT, curving slightly. Steep grass-and-fern earth banks rise tall on both sides of the track, mature beech trees lean over from the high banks. The dirt path is in deep shadow lower-left and brightens into dappled forest sunlight as it climbs into the upper-right distance, vanishing around a slight bend. NO PEOPLE, NO HORSES, NO BUILDINGS. Style: 19th-century Swiss landscape lithograph, fine ink linework, restrained earth-tone wash (mossy green, warm brown, ochre), atmospheric depth, light shafts breaking through the canopy. Single edge-to-edge illustration, no borders, no text.'
      },
      {
        style: 'watercolor-v2',
        prompt: 'A deep wooded sunken road (Hohle Gasse) cutting DIAGONALLY across the canvas — starts at the lower-left in cool shadow, climbs and curves up to the upper-right where late afternoon sun breaks through old beeches onto the path. High grass-and-fern banks loom on both sides, roots and stones at the edges. The dirt cart-track is the clear leading line of the composition. NO PEOPLE, NO ANIMALS, NO STRUCTURES. Style: 19th-century romantic Swiss landscape watercolor, soft diffused light, brown ink outlines, mossy green and warm brown washes, gentle atmospheric haze. Single edge-to-edge illustration, no borders, no text.'
      }
    ]
  },
  {
    slug: 'apple-shot-altdorf',
    location_name: 'Apple Shot Scene (Altdorf marketplace, populated)',
    variants: [
      {
        style: 'composition-lithograph',
        prompt: '14th-century Altdorf market square in canton Uri. Cobblestone plaza ringed by tall steep-roofed timber-frame medieval houses. COMPOSITION GUIDE (silhouettes only, no faces or detail): in the FAR RIGHT BACKGROUND a small child SILHOUETTE stands with back against the trunk of a tall lime tree, an apple on top of his head. In the FOREGROUND-LEFT, a clear EMPTY SPACE — open ground reserved for a single archer figure to be added later. Behind and ringing the square, a CROWD of dim shadowy silhouette figures observe in tense stillness — these are dark backlit silhouettes only, no detail. A tall wooden pole with a felt hat stands in the middle distance to the right of center. Snow-capped Uri Alps in the far background, low overcast light. Style: 19th-century Swiss landscape lithograph, fine ink linework, sepia and grey wash, dramatic atmospheric depth. Single edge-to-edge illustration, no borders, no text.'
      },
      {
        style: 'composition-watercolor',
        prompt: 'Medieval Altdorf market square, dramatic afternoon light. COMPOSITION: FAR RIGHT BACKGROUND — a small CHILD-SHAPED SILHOUETTE stands against the trunk of a tall lime tree, motionless, an apple balanced on his head. FOREGROUND-LEFT — a WIDE EMPTY SPACE on the open cobblestones, reserved space (no figure drawn) where the archer will stand. Behind and around the square, a SEMI-CIRCLE OF SHADOW SILHOUETTE FIGURES — Habsburg soldiers and townspeople rendered as dark mass silhouettes only, no faces, no detail, just the dark crowd shape conveying tense stillness. A wooden pole with a hat stands in the mid-right distance. Tall steep-roofed medieval timber houses ring the square; alpine peaks beyond. Style: 19th-century romantic Swiss watercolor, soft diffused light, brown ink outlines, restrained earth-tone wash, atmospheric haze. Single edge-to-edge illustration, no borders, no text.'
      }
    ]
  }
];

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const manifestPath = path.join(OUT_DIR, 'manifest.json');
  let manifest = { generatedAt: new Date().toISOString(), locations: [] };
  if (fs.existsSync(manifestPath)) {
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { /* keep default */ }
  }

  for (const scene of SCENES) {
    console.log(`\n=== REGEN: ${scene.location_name} (${scene.slug}) ===`);
    const sceneDir = path.join(OUT_DIR, scene.slug);
    if (!fs.existsSync(sceneDir)) fs.mkdirSync(sceneDir, { recursive: true });

    // Find next available index suffix to avoid clobbering originals
    const existing = fs.readdirSync(sceneDir).filter(f => /^ai-\d+-/.test(f));
    let nextIdx = existing.length + 1;

    const newCandidates = [];
    for (const v of scene.variants) {
      const idx = String(nextIdx++).padStart(2, '0');
      try {
        const result = await generateWithGrok(v.prompt, { aspectRatio: '4:3', resolution: '1k' });
        if (!result?.imageData) {
          console.log(`  ${idx}-${v.style}: FAILED (no imageData)`);
          continue;
        }
        const b64 = result.imageData.replace(/^data:image\/\w+;base64,/, '');
        const buf = Buffer.from(b64, 'base64');
        const fname = `ai-${idx}-${v.style}.jpg`;
        fs.writeFileSync(path.join(sceneDir, fname), buf);
        console.log(`  ${idx}-${v.style}: ${(buf.length / 1024).toFixed(0)}KB written`);
        newCandidates.push({
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

    const loc = manifest.locations.find(l => l.slug === scene.slug);
    if (loc) {
      loc.ai_candidates = [...(loc.ai_candidates || []), ...newCandidates];
    }
  }

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  // Re-render review.html using the existing renderer
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
