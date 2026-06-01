#!/usr/bin/env node
/**
 * Refine round 2:
 *   - Apple Shot: regenerate as a DIFFERENT location from the marketplace
 *     (not the same plaza). Same composition (Walter against tree right-back,
 *     Tell space front-left, shadow crowd), but a separate setting — a
 *     wider tree-flanked clearing or shooting ground.
 *   - Tellsplatte: bigger NATURAL stone (less geometric/artificial), with rain.
 *   - Hohle Gasse: single narrow footpath (not a wide road), with a tiny
 *     horse-and-rider silhouette at the FAR end of the path.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { generateWithGrok } = require('../../server/lib/grok');

const OUT_DIR = path.resolve(__dirname, '..', '..', 'tests', 'tell-curated');

const REGENS = [
  {
    slug: 'apple-shot-altdorf',
    style: 'composition-watercolor-v2',
    prompt: 'A wooded forest clearing at the edge of medieval Altdorf, NOT a town square — open grassy ground bordered by ancient lime and oak trees, the cobblestone marketplace just visible far behind through the trees. Late afternoon light filtering through leaves. COMPOSITION: FAR RIGHT BACKGROUND — a small CHILD-SHAPED SILHOUETTE stands with his back pressed against the trunk of a tall lime tree, motionless, an apple balanced on his head. FOREGROUND-LEFT — a WIDE EMPTY OPEN SPACE on the grass, no figure drawn, reserved space where an archer will stand and aim across the clearing toward the boy. Behind and around the clearing in the middle distance, a SEMI-CIRCLE of dark shadow silhouette figures — soldiers and townspeople rendered as featureless backlit shapes only, no faces, no detail, conveying tense stillness. The wide grassy distance between the empty front-left and the tree on the far right is the dramatic focus. Snow-capped Uri Alps just visible above the treetops in the far background. Style: 19th-century romantic Swiss watercolor, soft diffused afternoon light, brown ink outlines, restrained earth-tone wash, atmospheric haze. Single edge-to-edge illustration, no borders, no text.'
  },
  {
    slug: 'tellsplatte-boat-jump',
    style: 'watercolor-v4',
    prompt: 'Tellsplatte on Lake Uri (Vierwaldstättersee) in a heavy rainstorm at dusk. Foreground RIGHT: a LARGE natural BOULDER — a single big irregular weathered slab of grey stone rising out of the water, not architectural or geometric, with rough natural edges, lichen and moss patches, slightly higher than the waterline so a person could step up onto its sloped natural top. The boulder is massive and natural, like real lakeside rocks. Foreground LEFT: a LARGE wooden rowboat with a high curved prow, riding choppy whitecapped waves only one body-length from the boulder. Heavy DIAGONAL RAIN visible across the entire scene — long visible streaks of rain falling, water bouncing off the boulder and boat. Lake surface alive with churning waves, foam crests, dark green-grey water. Sky: dramatic moody storm — slate, charcoal, dark plum tones with weak light breaking through low clouds, NOT pitch black, atmospheric and ominous. Mist rising off the water. Steep wooded cliffs and a small chapel barely visible behind through the rain. NO PEOPLE. Style: 19th-century romantic Swiss landscape watercolor, brown ink outlines, dramatic stormy palette, atmospheric mist and visible rain streaks, Caspar Wolf influence. Single edge-to-edge illustration, no borders, no text.'
  },
  {
    slug: 'hohle-gasse-kuessnacht',
    style: 'watercolor-v3',
    prompt: 'A medieval narrow FOOTPATH (not a road) cutting DIAGONALLY across the canvas from the lower-left in cool shadow up to the upper-right — barely wide enough for one person, dirt track snaking between high grass-and-fern banks. The path is single-file narrow throughout. Steep mossy banks rise tall on both sides, mature beech trees lean over from the high banks, dappled forest light filtering through the canopy. At the FAR UPPER-RIGHT END of the path, where it disappears around a bend, a TINY DISTANT SILHOUETTE of a horse and rider — just a small dark shape at the vanishing point, indicating a Habsburg knight slowly approaching down the path. Nothing else — no other figures, no other animals, no buildings. The narrow single path and the distant approaching rider are the entire focus. Style: 19th-century romantic Swiss landscape watercolor, soft diffused light, brown ink outlines, mossy green and warm brown washes, gentle atmospheric haze, fine detail at the distant rider. Single edge-to-edge illustration, no borders, no text.'
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
<p>⭐ Priority locations at the top.</p>
${sections}
</body></html>`;
}
function escapeHtml(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
