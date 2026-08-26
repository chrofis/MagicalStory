#!/usr/bin/env node
/**
 * Variant 4: Lily (Miller family, 6y) at Baden panorama — girl → superhero cliché.
 *
 *   LEFT PAGE  = real photo Lily at a Baden viewpoint, panorama of the city
 *                (Ruine Stein hill, old town, river bridge, church spire) behind her,
 *                yellow overall dress + red boots, looking RIGHT
 *   RIGHT PAGE = watercolour Lily as a little superhero flying above the SAME
 *                Baden panorama, cape billowing, hands forward in flight pose
 *
 * Callback: yellow corduroy overall dress (with horse pocket emblem) + red boots →
 *           yellow superhero suit, red cape, horse logo on chest (like a hero crest)
 *
 * References:
 *   1. Lily demo portrait — tests/fixtures/demo-photos/miller/Lily.jpg
 *   2. Baden panorama (Schlossberg) — pulled from swiss_landmarks DB
 *
 * Format: 16:9 LANDSCAPE (Demand Gen primary)
 *
 * Output: scripts/ads/output/baden-book-superhero-panorama.jpg
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { editWithGrok } = require('../../server/lib/grok');

const OUTPUT_DIR = path.join(__dirname, 'drafts');
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

async function fetchAsDataUri(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Fetch ${url} → HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const mime = res.headers.get('content-type') || 'image/jpeg';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

function fileToDataUri(p) {
  const buf = fs.readFileSync(p);
  const mime = p.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

async function main() {
  const lilyPath = path.join(__dirname, '../../tests/fixtures/demo-photos/miller/Lily.jpg');
  if (!fs.existsSync(lilyPath)) throw new Error('Missing Lily photo: ' + lilyPath);
  const lilyRef = fileToDataUri(lilyPath);
  console.log(`✓ Loaded Lily portrait`);

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  const r = await pool.query(
    `SELECT name, photo_url, photo_description
       FROM landmark_index
      WHERE name ILIKE 'Schlossberg%' AND LOWER(nearest_city)='baden'
      LIMIT 1`
  );
  await pool.end();

  if (r.rowCount === 0 || !r.rows[0].photo_url) {
    throw new Error('Schlossberg/Baden panorama not found in DB');
  }
  const lm = r.rows[0];
  console.log(`✓ DB landmark: ${lm.name}`);
  console.log(`  photo_url: ${lm.photo_url}`);

  const panoramaRef = await fetchAsDataUri(lm.photo_url);
  console.log(`✓ Downloaded Baden panorama photo`);

  const prompt = `A 16:9 children's-book ad illustration. Composition: an open hardcover children's picture book filling most of the frame — book spans roughly 90% of the width and 75% of the height. Only a thin border of soft cream-coloured surface and a slightly out-of-focus warm cosy living-room background visible around the book. Book centred, viewed slightly from above so both pages are clearly visible. Both pages must read clearly.

LEFT PAGE — a REAL UNRETOUCHED DSLR PHOTOGRAPH (Canon EOS R5, 50mm f/1.8, natural daylight, RAW capture look) printed onto the storybook paper. NOT an illustration, NOT painted, NOT digitally smoothed.

LEFT PAGE BACKGROUND IS MANDATORY: the actual Baden cityscape from reference image 2 must appear as a real photograph spanning the full width of the LEFT PAGE alone. Match reference image 2 LITERALLY: on the LEFT side of the page, the wooded hill of Schlossberg crowned with the broken sandstone walls of Ruine Stein and a small Swiss flag; in the CENTRE, the slate-roofed buildings of Baden's medieval old town climbing the hillside, the tall white-and-blue Stadtturm clock tower visible mid-frame, and the dark slate spire of the Stadtkirche church on the right; at the BOTTOM, the stone arched bridge spanning the Limmat river. Do NOT replace this view with a generic cityscape, do NOT use a forest, do NOT use a park.

The girl from reference image 1 stands in the foreground at a Baden viewpoint overlooking this cityscape. She is a SCHOOL-AGE 6-YEAR-OLD (NOT a 3-year-old, NOT a toddler) — taller, slimmer, with longer limbs than a small child. Use her face exactly as in reference image 1: shoulder-length wavy COPPER-RED HAIR, GREEN EYES, light skin with PROMINENT FRECKLES across nose and cheeks. She is in three-quarter profile, body and shoulders angled to the right, head turned to the right, eyes clearly looking off the right edge of the page toward the next page (NOT at the camera, NOT forward). Calm, serious, slightly thoughtful expression — lips closed, no smile. Wearing her YELLOW CORDUROY OVERALL DRESS with the small brown horse-pocket emblem clearly visible on the chest, a CREAM LONG-SLEEVE TOP underneath, and bright RED RUBBER BOOTS on her feet. Photographic realism: visible real skin texture, individual hair strands of red, real fabric weave, sharp focus on her face with shallow depth of field softening the cityscape behind, real natural daylight, no painterly brushstrokes, no smoothing, looks indistinguishable from a real family snapshot.

RIGHT PAGE — TRADITIONAL HAND-PAINTED WATERCOLOUR ILLUSTRATION in the style of classic European children's picture books (Beatrix Potter, Jan Brett, Inga Moore). Pure watercolour: visibly wet brushstrokes, soft pigment bleed, slightly uneven washes, granulation in shadowed areas, visible cold-press paper grain, fine soft pencil outlines barely showing through. NOT digital art, NOT smooth gradients, NOT airbrushed.

RIGHT PAGE BACKGROUND IS MANDATORY: the SAME Baden cityscape view as the left page, spanning the full width of the RIGHT PAGE alone, but rendered in watercolour. Same Schlossberg hill with Ruine Stein on the left, same medieval old town climbing the hillside in the centre, same Stadtturm clock tower mid-frame, same Stadtkirche church spire on the right, same arched bridge across the Limmat at the bottom. Each page is a self-contained complete view of Baden — the two views match each other in composition, but the cityscape does NOT span across the spine. BOTH pages must contain the FULL Baden cityscape, each within its own page bounds.

Foreground action: the SAME 6-YEAR-OLD GIRL (school-age, the same proportions and height as on the left page — NOT younger, NOT a toddler; same face, same shoulder-length copper-red wavy hair, same green eyes, same prominent freckles) reimagined as a little superhero FLYING above the Baden cityscape. Mid-flight pose: body horizontal, both fists extended forward to the RIGHT in classic flying-hero pose, head facing right with a wide bright happy smile, eyes shining with adventure. Her flowing RED CAPE billows behind her to the LEFT (because she is flying right). She wears a fitted YELLOW SUPERHERO BODYSUIT (the colour palette of her overall dress carried over) with a small BROWN HORSE EMBLEM on her chest exactly matching the horse pocket emblem on her overall dress on the left page — the horse is now her superhero crest, the deliberate visual gag is that the print on her overall has become her hero logo. RED BOOTS on her feet matching the red rubber boots from the left page. A few wisps of cloud trail from her flight path. She is hovering in the sky ABOVE the Baden cityscape so the city panorama is visible below her. Soft watercolour washes, hand-painted texture, visible paper grain, warm golden afternoon light, friendly storybook mood.

Both girls (left photo, right watercolour) face and look toward the right side of the spread.

Book has clearly readable paper texture, slight curve at the spine, faint shadow in the gutter. A few small magical sparkles drift from the right page like fairy dust.

Composition: book centred. Calm space top-right above the watercolour page (leaves room for an ad headline). NO text anywhere in the image. NO logos. NO watermarks. NO brand names. NO captions. NO signatures. NO fake AI watermarks in any corner. Completely clean image with zero text overlays.

Reference image 1 = the girl's face/identity (use across both pages — same 6-year-old red-haired girl).
Reference image 2 = Baden cityscape panorama (use as backdrop on BOTH pages).

Aspect 16:9, warm cinematic light, cosy mood.`;

  console.log(`\nPrompt length: ${prompt.length} chars`);
  console.log('Generating with Grok edit (2 references, 16:9)...\n');

  const t0 = Date.now();
  const result = await editWithGrok(prompt, [lilyRef, panoramaRef], {
    aspectRatio: '16:9',
    resolution: '2k',
  });
  const ms = Date.now() - t0;

  const b64 = result.imageData.replace(/^data:image\/\w+;base64,/, '');
  const buf = Buffer.from(b64, 'base64');
  const outPath = path.join(OUTPUT_DIR, 'baden-book-superhero-panorama.jpg');
  fs.writeFileSync(outPath, buf);

  console.log(`✅ Done in ${ms}ms`);
  console.log(`   Saved: ${outPath}`);
  console.log(`   Size:  ${(buf.length / 1024).toFixed(1)} KB`);
}

main().catch(e => {
  console.error('❌ Failed:', e.message);
  process.exit(1);
});
