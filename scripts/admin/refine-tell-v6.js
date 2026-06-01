#!/usr/bin/env node
/**
 * Refine round 6:
 *   - Altdorf Panorama: edit v5 to extend bottom with empty meadow (Wiese)
 *     for character placement
 *   - Apple Shot: edit v7 — tree slightly back, observer crowd on LEFT and
 *     BACK (not behind tree), period-appropriate medieval Swiss costumes
 *     (silhouettes), faces unidentifiable
 *   - Tellsplatte: regen — alpine cliff walls (NOT tropical jungle), boat
 *     BEHIND the boulder, heavier rain, dark clouds but not pitch-black
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { generateWithGrok, editWithGrok } = require('../../server/lib/grok');

const OUT_DIR = path.resolve(__dirname, '..', '..', 'tests', 'tell-curated');

const EDITS = [
  {
    slug: 'altdorf-panorama',
    sourceFolder: 'altdorf-panorama',
    sourceFile: 'ai-02-watercolor-from-wiki.jpg',
    style: 'watercolor-with-meadow',
    editPrompt: 'Edit this Altdorf panorama: extend the bottom of the composition with a LARGE EMPTY GRASSY MEADOW (Wiese) — the lower one-third of the image should be soft green alpine pasture with wildflowers, low grass, no buildings, no figures, no fences. The town panorama and mountains stay in the upper two-thirds exactly as they are. The meadow is reserved space where characters will be placed later, so leave it empty and uncluttered. Keep the watercolor style, brown ink outlines, soft alpine light. Single edge-to-edge illustration, no borders, no text.'
  },
  {
    slug: 'apple-shot-altdorf',
    sourceFolder: 'apple-shot-altdorf',
    sourceFile: 'ai-07-composition-v4-tree-no-pole.jpg',
    style: 'composition-v5-tree-back-observers-left',
    editPrompt: 'Edit this medieval Altdorf apple-shot scene with these adjustments: 1) Push the big lime tree (with the boy silhouette against its trunk) slightly further back into the right-background, increasing the depth of the scene. 2) Move the OBSERVER CROWD: place the shadow-silhouette observers on the LEFT side and across the BACK of the image, NOT behind the tree on the right. The observers form a crowd along the left edge and stretch across the back — leaving the right area around the tree clear except for the boy. 3) The observer figures should wear PERIOD-APPROPRIATE 14th-century Swiss medieval costumes — long tunics, hooded cloaks, simple peasant garb, soldiers in chainmail and tabards — but rendered as DIM SILHOUETTES with FACES NOT IDENTIFIABLE (hooded, in shadow, or distant). 4) Keep the empty front-left foreground space (reserved for the archer Tell). Keep the medieval timber-frame houses, snow-capped Uri Alps, watercolor style, brown ink outlines, soft afternoon light. Single edge-to-edge illustration, no borders, no text.'
  }
];

const REGENS = [
  {
    slug: 'tellsplatte-boat-jump',
    style: 'watercolor-v8-alpine',
    prompt: 'Tellsplatte on Lake Uri (Vierwaldstättersee) in heavy alpine rainstorm at dusk. SHORE on the RIGHT: SHEER ALPINE CLIFF WALLS — sharply rising rocky mountainsides, exposed grey stone with patches of conifer (fir, spruce, pine) clinging to ledges, alpine character. NOT tropical, NOT jungle — clearly Swiss alpine. The cliff wall drops sharply into the lake. ONE single LARGE NATURAL BOULDER projects out from the cliff base into the water — smooth grey stone with sloped flat top about 1-1.5 metres above the waterline, the only landing point along the entire impassable cliff. The wooden ROWBOAT is positioned BEHIND the boulder, on the far side of the rock from the viewer — only the upper part of the boat visible above the rock, full-width broadside-on, boat rocking on choppy waves on the lake-side of the boulder. Foreground center-front: the boulder takes the focus, the boat partially hidden behind it. HEAVY DIAGONAL RAIN — long visible rain streaks across the entire scene, rain hitting the lake surface raising splash, mist rising. Lake surface alive with whitecaps. Sky: DARK STORM CLOUDS — heavy charcoal grey and slate clouds, threatening, but the overall image is NOT PITCH BLACK — there\'s diffused light filtering through the storm, atmospheric pale grey-silver patches behind the dark clouds, late afternoon storm light. Steep alpine peaks visible in the rain-haze beyond. NO PEOPLE. Style: 19th-century romantic Swiss landscape watercolor, brown ink outlines, dramatic stormy palette, alpine cliff character (NOT lush vegetation), heavy visible rain. Single edge-to-edge illustration, no borders, no text.'
  },
  {
    slug: 'hohle-gasse-kuessnacht',
    style: 'watercolor-v6-animal-trail',
    prompt: 'PANORAMIC wide view of a medieval Hohle Gasse near Küssnacht — a deep narrow V-shape ravine in the forest floor running DIAGONALLY from lower-left up to upper-right across the wide canvas. The ravine bottom is the LOWEST POINT — wooded earth banks rise UPWARD steeply on BOTH sides like a V, 3-4 metres tall, dense with moss, ferns, exposed roots, and rocks. The trail is barely a path — an organic ANIMAL CROSSING, uneven, irregular, MEANDERING — flattened leaf litter, scattered loose stones, exposed roots crossing the route, NO defined edges, NO uniform width. Looks like deer or wild goats made it, NOT humans, NOT a road. In the FOREGROUND of the trail (lower-left area), a CLUSTER OF DENSE BUSHES grows partly across the path — head-height shrubs, ferns and brambles spilling onto the trail, forming a natural HIDING SPOT where a person could crouch behind to ambush someone passing. The bushes leave a small visible gap on one side. Mature beech trees lean over from the high banks above, dappled forest light filtering down. At the FAR UPPER-RIGHT END where the ravine bends out of sight, a TINY DISTANT SILHOUETTE of a horse and rider — a small dark shape at the vanishing point. Style: 19th-century romantic Swiss landscape watercolor, soft diffused light from above, brown ink outlines, mossy green and warm brown washes, wild untouched feel. Single edge-to-edge illustration, no borders, no text.'
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
      const result = await editWithGrok(e.editPrompt, [sourceDataUri], { aspectRatio: '16:9' });
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
          basedOn: `${e.sourceFolder}/${e.sourceFile}`, bytes: buf.length,
        }];
      }
    } catch (err) {
      console.log(`  FAILED — ${err.message.slice(0, 200)}`);
    }
  }

  for (const r of REGENS) {
    console.log(`\n=== GEN: ${r.slug} (${r.style}) ===`);
    const sceneDir = path.join(OUT_DIR, r.slug);
    if (!fs.existsSync(sceneDir)) fs.mkdirSync(sceneDir, { recursive: true });
    const existing = fs.readdirSync(sceneDir).filter(f => /^ai-\d+-/.test(f));
    const idx = String(existing.length + 1).padStart(2, '0');
    try {
      const result = await generateWithGrok(r.prompt, { aspectRatio: '16:9', resolution: '1k' });
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
  // Rebuild HTML with broader filter (exclude only lithograph)
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
  return `<!doctype html><html><head><meta charset="utf-8"><title>Tell location curation</title><style>body{font-family:-apple-system,sans-serif;max-width:1400px;margin:1em auto;padding:0 1em}section{margin:2em 0;border-top:2px solid #ddd;padding-top:1em}section.priority{background:#fef9c3;padding:1em;border-radius:8px;border-top:4px solid #ca8a04}h2{margin:0 0 .5em 0}.dim{color:#666;font-size:.85em}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:1em}.card{border:1px solid #ccc;padding:.5em;background:#fff}.card.ai{border:2px solid #2563eb;background:#eff6ff}.card img{width:100%;height:240px;object-fit:contain;background:#f5f5f5;display:block}.meta{padding:.5em 0}.title{font-weight:600;word-break:break-word}.desc{font-size:.85em;margin:.5em 0;color:#333}details summary{cursor:pointer;color:#2563eb}</style></head><body><h1>Wilhelm Tell — landmark curation</h1><p>⭐ Priority locations at the top.</p>${sections}</body></html>`;
}
function escapeHtml(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
