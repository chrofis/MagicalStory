#!/usr/bin/env node
/**
 * Refine round 5:
 *   - Altdorf Panorama: Grok EDIT based on Wikimedia "Altdorf Schweiz 1900"
 *     photo (the historic town panorama). Watercolor styling, remove modern.
 *   - Apple Shot: Grok EDIT on previous best (ai-04-composition-watercolor) —
 *     remove the wooden pole, place ONE BIG TREE TRUNK on the right with
 *     the boy silhouette standing against it.
 *   - Tellsplatte: regenerate with sharply descending shore, the boulder is
 *     the ONLY accessible landing point, the rest of the shore is a 2m
 *     cliff overgrown with plants (impassable), lighter sky.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { generateWithGrok, editWithGrok } = require('../../server/lib/grok');

const OUT_DIR = path.resolve(__dirname, '..', '..', 'tests', 'tell-curated');

const EDITS = [
  {
    slug: 'altdorf-panorama',
    sourceFolder: 'marktplatz-altdorf',
    sourceFile: '01-Altdorf_Schweiz_1900.jpg',
    style: 'watercolor-from-wiki',
    editPrompt: 'Re-render this exact same panoramic view of Altdorf, Switzerland — preserve the town layout, building positions, valley shape, surrounding mountains, perspective, and overall composition exactly as in the source image. Convert to 19th-century romantic Swiss landscape WATERCOLOR style — soft brown ink outlines on the buildings and tree edges, gentle warm earth-tone wash (terracotta tile roofs, cream stone walls, green fields and meadows, blue-grey alpine peaks in the distance), atmospheric haze deep in the valley. Remove any modern elements (cars, paved roads, power lines, modern signs, modern vehicles, antennas) — replace with cobblestone paths, dirt tracks, traditional wooden hayracks, and natural meadow. Keep ALL the medieval and historic timber-frame buildings. NO PEOPLE. Single edge-to-edge illustration, no borders, no text.'
  },
  {
    slug: 'apple-shot-altdorf',
    sourceFolder: 'apple-shot-altdorf',
    sourceFile: 'ai-06-composition-watercolor-v3-treeback.jpg',
    style: 'composition-v4-tree-no-pole',
    editPrompt: 'Edit this medieval Altdorf marketplace scene with these changes: REMOVE the wooden pole entirely from the middle of the square — paint over it so the cobblestones are clean and uninterrupted. ADD ONE BIG TREE on the RIGHT side of the composition — a single tall lime or oak tree, prominent thick trunk in clear view, the trunk is the visual focus on the right. Place a SMALL CHILD SILHOUETTE standing motionless against this tree trunk on the right, an apple balanced on the boy\'s head. The empty front-left of the composition stays empty (reserved space for the archer Tell figure). Keep everything else: medieval timber-frame houses ringing the square, the shadow silhouette crowd in the middle distance, snow-capped Uri Alps behind, 19th-century Swiss watercolor style with brown ink outlines, soft afternoon light. Single edge-to-edge illustration, no borders, no text.'
  }
];

const REGENS = [
  {
    slug: 'tellsplatte-boat-jump',
    style: 'watercolor-v7',
    prompt: 'Tellsplatte on Lake Uri (Vierwaldstättersee) in moderate rainstorm at dusk. RIGHT SIDE: a SHARPLY DESCENDING wooded shoreline that drops STEEPLY into the lake — most of the shore is a vertical small cliff about 2 metres tall, completely overgrown with thick ferns, brambles, ivy, and tangled bushes spilling down the cliff face into the water — IMPASSABLE green wall of vegetation, no foothold. ONLY ONE single LARGE NATURAL BOULDER projects out at the base of the cliff into the lake — a smooth grey rock with sloped flat top about 1-1.5 metres above the water — it is THE ONLY accessible landing point along this entire stretch of shore, the only break in the impassable plant-covered cliff. CENTER FOREGROUND: a LARGE wooden rowboat shown FULL-WIDTH and HORIZONTAL across the lower-center (broadside view, long axis runs left-to-right, NOT angled in perspective), positioned just behind the boulder, only an arm\'s length of choppy water between the boat\'s side and the rock — the boat is angled so a person could step or jump out directly onto the boulder. Lake surface alive with whitecaps, dark green-grey water, light diagonal rain streaks across the scene. Sky: STORMY but BRIGHTER — pale grey and silver-white clouds with broken light pushing through, atmospheric and moody but NOT dark, MUCH LIGHTER overall than dusk-black, late-afternoon storm rather than dusk. Steep wooded cliffs behind continue into the distance. NO PEOPLE — empty boat, empty rock, the visual story is the rock as the only escape from the boat. Style: 19th-century romantic Swiss landscape watercolor, brown ink outlines, atmospheric stormy palette but generally lighter/airier than previous versions, mist and rain visible. Single edge-to-edge illustration, no borders, no text.'
  },
  {
    slug: 'hohle-gasse-kuessnacht',
    style: 'watercolor-v5',
    prompt: 'A medieval Hohle Gasse near Küssnacht — a deep narrow VALLEY-CUT in the forest floor running DIAGONALLY from lower-left up to upper-right. The bottom of the cut IS the lowest point of the entire scene — both sides of the path rise UPWARD from the path floor. There is NO drop to either side; the path itself is the valley floor, and the wooded earth banks rise steeply UP from it on BOTH sides like a V-shape ravine, 3-4 metres tall, dense with moss, ferns, exposed roots, and rocks. The "path" itself is just a faint TRAMPELPFAD — a rough informal trail of trampled earth and matted grass between rocks and roots, NOT a defined road or carriage track, no clear edges, no compacted surface — it could easily be missed. Mature beech trees lean over from the high banks above, dappled forest light filtering down. At the FAR UPPER-RIGHT END where the trail bends out of sight, a TINY DISTANT SILHOUETTE of a horse and rider — a small dark shape at the vanishing point. Nothing else. Style: 19th-century romantic Swiss landscape watercolor, soft diffused light from above, brown ink outlines, mossy green and warm brown washes, claustrophobic atmospheric depth, the trampled trail barely distinct from the surrounding forest floor. Single edge-to-edge illustration, no borders, no text.'
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

  // Edits first
  for (const e of EDITS) {
    console.log(`\n=== EDIT: ${e.slug} (${e.style}) base=${e.sourceFolder}/${e.sourceFile} ===`);
    const sourcePath = path.join(OUT_DIR, e.sourceFolder, e.sourceFile);
    if (!fs.existsSync(sourcePath)) { console.log(`  SKIP: source not found ${sourcePath}`); continue; }
    const sourceBuf = fs.readFileSync(sourcePath);
    const sourceDataUri = `data:image/jpeg;base64,${sourceBuf.toString('base64')}`;
    const sceneDir = path.join(OUT_DIR, e.slug);
    if (!fs.existsSync(sceneDir)) fs.mkdirSync(sceneDir, { recursive: true });
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
          file: fname, style: e.style, prompt: e.editPrompt,
          generatedBy: 'grok-imagine-edit',
          basedOn: `${e.sourceFolder}/${e.sourceFile}`,
          bytes: buf.length,
        }];
      }
    } catch (err) {
      console.log(`  FAILED — ${err.message.slice(0, 200)}`);
    }
  }

  // Pure regenerations
  for (const r of REGENS) {
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
<p>⭐ Priority locations at the top.</p>
${sections}
</body></html>`;
}
function escapeHtml(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
