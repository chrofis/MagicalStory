#!/usr/bin/env node
/**
 * Refine round 4:
 *   - Add 2 new locations: Altdorf panorama, Tellshaus Bürglen
 *   - Inpaint Apple Shot middle (ai-04-composition-watercolor) — push tree
 *     further back to add distance between Tell and Walter
 *   - Tellsplatte: smaller stone, boat full-width (horizontal, not angled),
 *     boat positioned close behind/next to the stone for jumping distance
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { generateWithGrok, editWithGrok } = require('../../server/lib/grok');

const OUT_DIR = path.resolve(__dirname, '..', '..', 'tests', 'tell-curated');

// New text-only generations
const GENS = [
  {
    slug: 'altdorf-panorama',
    location_name: 'Altdorf Panorama',
    location_query: 'Altdorf panorama Uri',
    location_type: 'Town',
    aliases: ['altdorf town panorama', 'altdorf canton uri', 'altdorf view'],
    style: 'watercolor',
    prompt: 'WIDE PANORAMIC view of medieval Altdorf, capital of canton Uri, Switzerland — based on the historical 1900 panorama. The town nestles in a green alpine valley, ringed by tall steep snow-capped peaks of the Schwyz and Uri Alps. Compact cluster of medieval timber-frame houses with steep red-tiled roofs, a tall church spire rising in the centre, surrounded by cultivated fields and meadows in the foreground. The Reuss valley plain stretches into the distance toward Lake Uri (Vierwaldstättersee), barely visible as a sliver of grey water far in the back. Late afternoon golden light, soft mist rising from the valley floor. NO PEOPLE, NO MODERN ELEMENTS — no cars, no power lines, no paved roads, no signs. Style: 19th-century romantic Swiss landscape watercolor, brown ink outlines, restrained earth-tone wash with green meadows and warm tile reds, atmospheric distance haze. Single edge-to-edge panoramic illustration, no borders, no text.'
  },
  {
    slug: 'tellshaus-buerglen',
    location_name: 'Tellshaus Bürglen',
    location_query: 'Tellshaus Bürglen',
    location_type: 'Building',
    aliases: ["tell's house bürglen", 'tell birthplace', 'tellshaus uri'],
    style: 'watercolor',
    prompt: 'A medieval stone-and-timber Swiss farmhouse — the legendary Tellshaus in Bürglen, Uri canton — based on the 1786 historical engraving. Sturdy two-storey building with thick whitewashed stone ground floor and dark timber-clad upper storey, small shuttered windows, steep wood-shingle roof with wide overhanging eaves, a wooden balcony along the front upper level, a low arched stone doorway. Set on a grassy alpine meadow with wildflowers in the foreground, a few traditional wooden hayracks (Heinzen) nearby, a low stone wall along the path. Behind the house, the steep wooded slopes of the Schächental valley rise sharply, snow-capped peaks of the Uri Alps in the distance under a mild summer sky with scattered clouds. NO PEOPLE, NO ANIMALS, NO MODERN ELEMENTS. Style: 19th-century romantic Swiss landscape watercolor, brown ink outlines, soft warm earth-tone wash, atmospheric depth, gentle alpine light. Single edge-to-edge illustration, no borders, no text.'
  },
  {
    slug: 'tellsplatte-boat-jump',
    location_name: 'Tellsplatte',
    style: 'watercolor-v6',
    prompt: 'Tellsplatte on Lake Uri (Vierwaldstättersee) in heavy rainstorm at dusk. RIGHT SIDE: a steep wooded SHORELINE — a MEDIUM-SIZED natural BOULDER (not enormous, just bigger than a person — about a metre or two across) projecting from the shore into the water at the cliff base, lichen and moss on weathered grey stone, attached to and continuous with the wooded bank rising behind. The rock is part of the SHORE, not a floating island. CENTER FOREGROUND: a LARGE wooden rowboat shown FULL-WIDTH and HORIZONTAL across the lower-center of the composition (not angled, not in perspective — viewed from the side, broadside-on, the boat\'s long axis runs LEFT-TO-RIGHT across the image). The boat is positioned just BEHIND and slightly LEFT of the boulder, very close — only an arm\'s length of choppy water between the side of the boat and the boulder, so a person standing in the boat could step or leap out directly onto the rock. The boat\'s side rail is roughly level with the top of the boulder, suggesting feasible exit. Heavy diagonal rain streaks across the entire scene, whitecaps on the dark water, mist rising. Sky: dramatic stormy slate-charcoal-plum tones with weak light breaking through, ominous but NOT pitch black. NO PEOPLE — empty boat, empty rock, the visual story is the boat positioned for jumping out onto the shore boulder. Style: 19th-century romantic Swiss landscape watercolor, brown ink outlines, dramatic stormy palette, atmospheric mist, visible rain streaks. Single edge-to-edge illustration, no borders, no text.'
  }
];

// Inpaint edits — input: existing local image; output: new file in same folder
const EDITS = [
  {
    slug: 'apple-shot-altdorf',
    sourceFile: 'ai-04-composition-watercolor.jpg',
    style: 'composition-watercolor-v3-treeback',
    editPrompt: 'Edit this scene: move the lime tree (with the small child silhouette against its trunk) FURTHER BACK into the deep background — push the tree from its current right-background position even further back into the distance. The empty front-left space (reserved for the archer Tell) should now feel much larger and the distance between the front-left and the boy under the tree should feel dramatic and far. Keep everything else identical: medieval Altdorf marketplace setting, the wooden pole with hat in mid-distance, the shadow silhouette crowd ringing the square, the snow-capped Uri Alps behind, 19th-century Swiss watercolor style, brown ink outlines. Increase atmospheric haze on the distant tree to emphasize the distance. Single edge-to-edge illustration, no borders, no text.'
  }
];

const PRIORITY_SLUGS = [
  'marktplatz-altdorf',
  'altdorf-panorama',
  'apple-shot-altdorf',
  'tellsplatte-boat-jump',
  'hohle-gasse-kuessnacht',
  'tellshaus-buerglen',
];

(async () => {
  const manifestPath = path.join(OUT_DIR, 'manifest.json');
  let manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  // Pure generations
  for (const r of GENS) {
    console.log(`\n=== GEN: ${r.slug} (${r.style}) ===`);
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
      let loc = manifest.locations.find(l => l.slug === r.slug);
      if (!loc) {
        loc = {
          slug: r.slug,
          location_name: r.location_name,
          location_query: r.location_query,
          location_type: r.location_type,
          aliases: r.aliases,
          candidates: [],
          ai_candidates: [],
        };
        manifest.locations.push(loc);
      }
      loc.ai_candidates = [...(loc.ai_candidates || []), {
        file: fname, style: r.style, prompt: r.prompt, generatedBy: 'grok-imagine', bytes: buf.length,
      }];
    } catch (e) {
      console.log(`  FAILED — ${e.message.slice(0, 200)}`);
    }
  }

  // Inpaint edits
  for (const e of EDITS) {
    console.log(`\n=== EDIT: ${e.slug} (${e.style}) base=${e.sourceFile} ===`);
    const sceneDir = path.join(OUT_DIR, e.slug);
    const sourcePath = path.join(sceneDir, e.sourceFile);
    if (!fs.existsSync(sourcePath)) {
      console.log(`  SKIP: source not found ${sourcePath}`);
      continue;
    }
    const sourceBuf = fs.readFileSync(sourcePath);
    const sourceDataUri = `data:image/jpeg;base64,${sourceBuf.toString('base64')}`;
    const existing = fs.readdirSync(sceneDir).filter(f => /^ai-\d+-/.test(f));
    const idx = String(existing.length + 1).padStart(2, '0');
    try {
      const result = await editWithGrok(e.editPrompt, [sourceDataUri], { aspectRatio: '4:3' });
      if (!result?.imageData) { console.log('  FAILED'); continue; }
      const b64 = result.imageData.replace(/^data:image\/\w+;base64,/, '');
      const buf = Buffer.from(b64, 'base64');
      const fname = `ai-${idx}-${e.style}.jpg`;
      fs.writeFileSync(path.join(sceneDir, fname), buf);
      console.log(`  ${idx}-${e.style}: ${(buf.length / 1024).toFixed(0)}KB`);
      const loc = manifest.locations.find(l => l.slug === e.slug);
      if (loc) {
        loc.ai_candidates = [...(loc.ai_candidates || []), {
          file: fname, style: e.style, prompt: e.editPrompt, generatedBy: 'grok-imagine-edit',
          basedOn: e.sourceFile, bytes: buf.length,
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
        <div class="dim">${(c.bytes / 1024).toFixed(0)}KB${c.basedOn ? ' · edit of ' + escapeHtml(c.basedOn) : ''}</div>
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
<p>⭐ Priority locations at the top. 6 needed: Marktplatz, Altdorf Panorama, Apple Shot, Tellsplatte, Hohle Gasse, Tellshaus Bürglen.</p>
${sections}
</body></html>`;
}
function escapeHtml(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
