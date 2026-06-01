#!/usr/bin/env node
/**
 * Refine round 7 — A4 PORTRAIT (3:4) for all priority pages.
 *
 * Apple Shot: crowd CLUSTERED (not lined up), LEFT HALF ONLY, faces small
 *             but visible. Tree slightly bigger and pushed further back.
 * Tellsplatte: rock CONNECTED to the LEFT cliff (not an island), ship to
 *              the RIGHT almost touching the stone.
 * Hohle Gasse: regen at 3:4 portrait (content good).
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { generateWithGrok } = require('../../server/lib/grok');

const OUT_DIR = path.resolve(__dirname, '..', '..', 'tests', 'tell-curated');

const REGENS = [
  {
    slug: 'apple-shot-altdorf',
    style: 'composition-v6-a4portrait-crowd-left',
    prompt: 'A4 PORTRAIT 3:4 vertical composition. Medieval Altdorf scene of the apple shot, late afternoon under soft warm light. RIGHT BACKGROUND (deep, far): a TALL LIME TREE — prominent thick trunk in clear view, the tree pushed FURTHER BACK into the middle-distance and made SLIGHTLY BIGGER (taller and more imposing) so it dominates the right side at depth. A small CHILD silhouette stands motionless against the trunk, an apple balanced on his head. CENTER FOREGROUND: open empty cobblestoned ground stretching across the bottom of the frame, EMPTY SPACE reserved for the archer Tell figure (NO figure drawn there). LEFT HALF ONLY: a CLUSTERED CROWD of medieval Swiss observers — peasants, soldiers, townsfolk all GROUPED TOGETHER as a tight informal cluster (NOT lined up, NOT in a row), tense and watching. The crowd fills only the LEFT HALF of the image, NEVER spilling onto the right side or behind the tree. The figures wear period 14th-century medieval Swiss costume — tunics, hooded cloaks, peasant garb, soldiers in chainmail and tabards — faces are SMALL but VISIBLE (not dominant, but you can see eyes and expressions of tension), distant enough to read as a crowd rather than portraits. Behind the crowd and tree: medieval timber-frame houses ringing the square, snow-capped Uri Alps in the far background. Style: 19th-century romantic Swiss watercolor, brown ink outlines, soft warm afternoon light, atmospheric depth. Single edge-to-edge illustration, no borders, no text.'
  },
  {
    slug: 'tellsplatte-boat-jump',
    style: 'watercolor-v9-a4portrait',
    prompt: 'A4 PORTRAIT 3:4 vertical composition. Tellsplatte on Lake Uri in heavy alpine rainstorm, late afternoon stormy light. LEFT SIDE of the composition: a SHEER ALPINE CLIFF WALL rising tall up the entire left side of the canvas — exposed grey rock with conifers (fir, spruce) clinging to ledges, distinctly Swiss alpine character (NOT tropical, NOT jungle). The cliff drops sharply to the lake. EXTENDING OUT FROM THE BASE OF THE LEFT CLIFF: a single LARGE NATURAL BOULDER, smooth grey stone, sloped flat top about 1-1.5 metres above the waterline. The boulder is CONNECTED to and continuous with the left cliff at its base — clearly part of the shore, NOT a floating island. The boulder projects out into the water toward the right. RIGHT OF THE BOULDER: a LARGE wooden rowboat, full-width broadside view, oriented horizontally (long axis left-to-right), positioned RIGHT NEXT TO the boulder — almost TOUCHING the stone, only inches of choppy water between the boat\'s side and the rock — clearly close enough that a person could step or jump from boat to boulder. Lake surface alive with whitecaps, dark green-grey water. HEAVY DIAGONAL RAIN STREAKS visible across the entire scene. Sky: dark stormy charcoal-slate clouds with diffused light filtering through, dramatic but NOT pitch black, atmospheric pale silver patches behind the dark clouds. NO PEOPLE — empty boat, empty rock. Style: 19th-century romantic Swiss landscape watercolor, brown ink outlines, dramatic stormy palette, alpine character, heavy visible rain. Single edge-to-edge illustration, no borders, no text.'
  },
  {
    slug: 'hohle-gasse-kuessnacht',
    style: 'watercolor-v7-a4portrait',
    prompt: 'A4 PORTRAIT 3:4 vertical composition. A medieval Hohle Gasse near Küssnacht — a deep V-shape ravine in the forest floor running DIAGONALLY from the lower-left up to the upper-right of the tall portrait canvas. The ravine bottom is the LOWEST POINT — wooded earth banks rise UPWARD steeply on BOTH sides like a V, 3-4 metres tall, dense with moss, ferns, exposed roots, and rocks. The trail along the ravine floor is barely a path — an ANIMAL CROSSING, uneven, irregular, MEANDERING — flattened leaf litter, scattered loose stones, exposed roots, NO defined edges, looks like deer or wild goats made it. In the FOREGROUND of the trail (lower portion of the canvas), a CLUSTER OF DENSE BUSHES grows partly across the path — head-height shrubs, ferns and brambles spilling onto the trail, forming a natural HIDING SPOT where a person could crouch behind to ambush someone passing. Mature beech trees lean over from the high banks above, dappled forest light filtering down. At the FAR UPPER-RIGHT END where the ravine bends out of sight, a TINY DISTANT SILHOUETTE of a horse and rider — small dark shape at the vanishing point. Style: 19th-century romantic Swiss landscape watercolor, soft diffused light from above, brown ink outlines, mossy green and warm brown washes, wild untouched feel. Single edge-to-edge illustration, no borders, no text.'
  }
];

const PRIORITY_SLUGS = [
  'marktplatz-altdorf', 'altdorf-panorama', 'apple-shot-altdorf',
  'tellsplatte-boat-jump', 'hohle-gasse-kuessnacht', 'tellshaus-buerglen',
];

(async () => {
  const manifestPath = path.join(OUT_DIR, 'manifest.json');
  let manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  for (const r of REGENS) {
    console.log(`\n=== GEN A4 PORTRAIT: ${r.slug} (${r.style}) ===`);
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
  return `<!doctype html><html><head><meta charset="utf-8"><title>Tell location curation</title><style>body{font-family:-apple-system,sans-serif;max-width:1400px;margin:1em auto;padding:0 1em}section{margin:2em 0;border-top:2px solid #ddd;padding-top:1em}section.priority{background:#fef9c3;padding:1em;border-radius:8px;border-top:4px solid #ca8a04}h2{margin:0 0 .5em 0}.dim{color:#666;font-size:.85em}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:1em}.card{border:1px solid #ccc;padding:.5em;background:#fff}.card.ai{border:2px solid #2563eb;background:#eff6ff}.card img{width:100%;height:340px;object-fit:contain;background:#f5f5f5;display:block}.meta{padding:.5em 0}.title{font-weight:600;word-break:break-word}.desc{font-size:.85em;margin:.5em 0;color:#333}details summary{cursor:pointer;color:#2563eb}</style></head><body><h1>Wilhelm Tell — landmark curation</h1><p>⭐ Priority locations at the top. New A4 portrait variants at end of each priority section.</p>${sections}</body></html>`;
}
function escapeHtml(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
