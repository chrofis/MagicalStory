#!/usr/bin/env node
/**
 * Winterthur creative #1 — Lily as a princess at Stadtkirche Winterthur.
 * Same open-book layout as the Baden series: real DSLR photo LEFT, watercolour RIGHT,
 * costume callback (yellow overall + horse pocket emblem → yellow princess dress + horse crest).
 *
 *   LEFT PAGE  = real photo Lily in front of Stadtkirche Winterthur (Gothic church on Kirchplatz)
 *   RIGHT PAGE = watercolour Lily as a little princess in front of/inside the same church
 *
 * References:
 *   1. Lily demo portrait — tests/fixtures/demo-photos/miller/Lily.jpg
 *   2. Stadtkirche Winterthur photo — from swiss_landmarks DB
 *
 * Format: 16:9 LANDSCAPE (Demand Gen primary)
 * Output: scripts/ads/output/winterthur-book-princess-stadtkirche.jpg
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

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const r = await pool.query(
    `SELECT name, photo_url, photo_description
       FROM landmark_index
      WHERE LOWER(name) LIKE '%stadtkirche%winterthur%' OR name = 'Stadtkirche Winterthur'
      LIMIT 1`
  );
  await pool.end();
  if (r.rowCount === 0 || !r.rows[0].photo_url) throw new Error('Stadtkirche Winterthur not found in DB');
  const lm = r.rows[0];
  console.log(`✓ DB landmark: ${lm.name}`);
  console.log(`  photo_url: ${lm.photo_url}`);

  const landmarkRef = await fetchAsDataUri(lm.photo_url);
  console.log(`✓ Downloaded Stadtkirche photo`);

  // Save the reference for the user to verify what we're using
  const refSaveBuf = Buffer.from(landmarkRef.replace(/^data:image\/\w+;base64,/, ''), 'base64');
  fs.writeFileSync(path.join(OUTPUT_DIR, '_ref_stadtkirche-winterthur.jpg'), refSaveBuf);

  const prompt = `A 16:9 children's-book ad illustration. Composition: an open hardcover children's picture book filling most of the frame — book spans roughly 90% of the width and 75% of the height. Only a thin border of soft cream-coloured surface and a slightly out-of-focus warm cosy living-room background visible around the book. Book centred, viewed slightly from above so both pages are clearly visible. Both pages must read clearly.

LEFT PAGE — a REAL UNRETOUCHED DSLR PHOTOGRAPH (Canon EOS R5, 50mm f/1.8, natural daylight, RAW capture look) printed onto the storybook paper. NOT an illustration, NOT painted, NOT digitally smoothed.

LEFT PAGE BACKGROUND IS MANDATORY: the Stadtkirche Winterthur from reference image 2 must appear as a real photograph spanning the full width of the LEFT PAGE alone. Match reference image 2 LITERALLY: the late-Gothic sandstone façade of the church with its TWIN slim tall steeples — the slightly shorter, more ornate clock tower on one side and the taller, plainer spire on the other — set on the Kirchplatz cobblestones with old town buildings visible around it. Do NOT replace this view with a generic cathedral, do NOT use Zürich Grossmünster, do NOT use any other Swiss church.

The girl from reference image 1 stands in the foreground on the Kirchplatz in front of the church. She is a SCHOOL-AGE 6-YEAR-OLD (NOT a 3-year-old, NOT a toddler) — taller, slimmer, with longer limbs than a small child. Use her face exactly as in reference image 1: shoulder-length wavy COPPER-RED HAIR, GREEN EYES, light skin with PROMINENT FRECKLES across nose and cheeks. She is in three-quarter profile, body and shoulders angled to the right, head turned to the right, eyes clearly looking off the right edge of the page toward the next page (NOT at the camera, NOT forward). Calm, serious, slightly thoughtful expression — lips closed, no smile. Wearing her YELLOW CORDUROY OVERALL DRESS with the small brown horse-pocket emblem clearly visible on the chest, a CREAM LONG-SLEEVE TOP underneath, and bright RED RUBBER BOOTS on her feet. Photographic realism: visible real skin texture, individual hair strands of red, real fabric weave, sharp focus on her face with shallow depth of field softening the church behind, real natural daylight, no painterly brushstrokes, no smoothing, looks indistinguishable from a real family snapshot.

RIGHT PAGE — TRADITIONAL HAND-PAINTED WATERCOLOUR ILLUSTRATION in the style of classic European children's picture books (Beatrix Potter, Jan Brett, Inga Moore). Pure watercolour: visibly wet brushstrokes, soft pigment bleed, slightly uneven washes, granulation in shadowed areas, visible cold-press paper grain, fine soft pencil outlines barely showing through. NOT digital art, NOT smooth gradients, NOT airbrushed.

RIGHT PAGE BACKGROUND IS MANDATORY: the SAME Stadtkirche Winterthur view as the left page, spanning the full width of the RIGHT PAGE alone, but rendered in watercolour. Same late-Gothic façade, same TWIN slim tall steeples (shorter ornate clock tower on one side, taller plainer spire on the other), same Kirchplatz cobblestones, same surrounding old-town buildings. Each page is a self-contained complete view of the church — the two views match each other in composition, but the church does NOT span across the spine. BOTH pages must contain the FULL Stadtkirche Winterthur, each within its own page bounds.

Foreground action: the SAME 6-YEAR-OLD GIRL (school-age, same proportions and height as on the left page — NOT younger, NOT a toddler; same face, same shoulder-length copper-red wavy hair, same green eyes, same prominent freckles) reimagined as a little PRINCESS standing or walking on the cobblestones in front of the church. Pose: body angled to the right, head turned right with a calm, gentle smile, eyes looking toward the right edge of the page (toward where her adventure waits). She wears a flowing knee-length PRINCESS DRESS in YELLOW (matching her overall dress colour on the left page) with cream-coloured lace trim at the collar and hem (echoing her cream long-sleeve top from the left page). A small BROWN HORSE EMBLEM is embroidered on the chest of her dress — exactly matching the horse pocket emblem on her overall on the left page. The horse on her overall has become her royal crest, the deliberate visual gag is that the print on her real clothing has become her princess emblem. RED LEATHER SHOES on her feet (echoing her red rubber boots from the left page). A small gold crown on her head, slightly tipped. Soft watercolour washes, hand-painted texture, visible paper grain, warm golden afternoon light, friendly storybook mood.

Both girls (left photo, right watercolour) face and look toward the right side of the spread.

Book has clearly readable paper texture, slight curve at the spine, faint shadow in the gutter. A few small magical sparkles drift from the right page like fairy dust.

Composition: book centred. Calm space top-right above the watercolour page (leaves room for an ad headline). NO text anywhere in the image. NO logos. NO watermarks. NO brand names. NO captions. NO signatures. NO fake AI watermarks in any corner. Completely clean image with zero text overlays.

Reference image 1 = the girl's face/identity (use across both pages — same 6-year-old red-haired girl).
Reference image 2 = Stadtkirche Winterthur (use as backdrop on BOTH pages).

Aspect 16:9, warm cinematic light, cosy mood.`;

  console.log(`\nPrompt length: ${prompt.length} chars`);
  console.log('Generating with Grok edit (2 references, 16:9)…\n');

  const t0 = Date.now();
  const result = await editWithGrok(prompt, [lilyRef, landmarkRef], {
    aspectRatio: '16:9',
    resolution: '2k',
  });
  const ms = Date.now() - t0;

  const b64 = result.imageData.replace(/^data:image\/\w+;base64,/, '');
  const buf = Buffer.from(b64, 'base64');
  const outPath = path.join(OUTPUT_DIR, 'winterthur-book-princess-stadtkirche.jpg');
  fs.writeFileSync(outPath, buf);

  console.log(`✅ Done in ${ms}ms`);
  console.log(`   Saved: ${outPath}`);
  console.log(`   Size:  ${(buf.length / 1024).toFixed(1)} KB`);
}

main().catch(e => { console.error('❌ Failed:', e.message); process.exit(1); });
