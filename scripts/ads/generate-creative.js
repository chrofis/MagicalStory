#!/usr/bin/env node
/**
 * Parametric ad-creative generator. Same open-book pattern as the original
 * Baden series: real DSLR photo on the LEFT page (kid at landmark), watercolour
 * fantasy version on the RIGHT page (kid as knight / princess / pirate / wizard
 * at the same landmark, with a costume callback that turns the kid's real-life
 * outfit motif into part of their fantasy costume).
 *
 * Usage:
 *   node scripts/ads/generate-creative.js --kid lily   --theme princess --landmark "Stadtkirche Winterthur"
 *   node scripts/ads/generate-creative.js --kid ethan  --theme knight   --landmark "Alte Kaserne (Winterthur)"
 *   node scripts/ads/generate-creative.js --kid ethan  --theme pirate   --landmark "Fischmädchenbrunnen"
 *   node scripts/ads/generate-creative.js --kid lily   --theme wizard   --landmark "Casinotheater Winterthur"
 *
 * Output: scripts/ads/drafts/<city>-book-<theme>-<landmark-slug>.jpg
 *
 * Landmarks resolved by exact-name match (or LIKE fallback) from landmark_index.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { editWithGrok } = require('../../server/lib/grok');

const DRAFTS_ROOT = path.join(__dirname, 'drafts');
if (!fs.existsSync(DRAFTS_ROOT)) fs.mkdirSync(DRAFTS_ROOT, { recursive: true });

// ─── Args ────────────────────────────────────────────────────────────────
const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)=(.*)$/);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), 'true'];
}));
const KID_KEY = (args.kid || '').toLowerCase();
const THEME = (args.theme || '').toLowerCase();
const LANDMARK_NAME = args.landmark;
if (!KID_KEY || !THEME || !LANDMARK_NAME) {
  console.error('Usage: --kid <lily|ethan> --theme <princess|wizard|knight|pirate> --landmark "<name>"');
  process.exit(1);
}

// ─── Kid profiles ────────────────────────────────────────────────────────
// portrait — DSLR-photo prose describing the real-photo identity locks.
// costumeNotes — how the kid's real outfit translates to each fantasy costume.
const KIDS = {
  lily: {
    photoPath: path.join(__dirname, '../../tests/fixtures/demo-photos/miller/Lily.jpg'),
    pronouns: { subj: 'she', obj: 'her', poss: 'her', possClause: 'her own' },
    portrait: `a SCHOOL-AGE 6-YEAR-OLD girl (NOT a 3-year-old, NOT a toddler) — taller, slimmer, with longer limbs than a small child. Use her face exactly as in reference image 1: shoulder-length wavy COPPER-RED HAIR, GREEN EYES, light skin with PROMINENT FRECKLES across nose and cheeks`,
    outfitReal: `her YELLOW CORDUROY OVERALL DRESS with the small brown horse-pocket emblem clearly visible on the chest, a CREAM LONG-SLEEVE TOP underneath, and bright RED RUBBER BOOTS on her feet`,
    callbackMotif: 'small BROWN HORSE EMBLEM on her chest exactly matching the horse pocket emblem on her overall on the left page — the horse is now her heraldic crest, the deliberate visual gag is that the print on her real clothing has become her costume emblem',
    costumeColors: 'YELLOW (matching her overall dress colour on the left page) with cream-coloured lace trim at the collar and hem (echoing her cream long-sleeve top from the left page)',
    feetCallback: 'RED LEATHER SHOES on her feet (echoing her red rubber boots from the left page)',
    realMotifElement: "a small friendly WHITE PONY with a flowing mane (the little horse from her real overall, come to life) standing just to her RIGHT",
    motifBecomesReal: true,
  },
  ethan: {
    photoPath: path.join(__dirname, '../../tests/fixtures/demo-photos/miller/Ethan.jpg'),
    pronouns: { subj: 'he', obj: 'him', poss: 'his', possClause: 'his own' },
    portrait: `a SCHOOL-AGE 5-6-YEAR-OLD boy (NOT a toddler) — average build, normal child proportions. Use his face exactly as in reference image 1: short curly DARK BROWN HAIR, BROWN EYES, light olive skin, gentle warm smile`,
    outfitReal: `his NAVY BLUE SHORT-SLEEVE T-SHIRT with a bold WHITE ROCKET SHIP PRINT (rocket pointing up surrounded by stars and a small cloud) clearly visible across the chest, BEIGE KHAKI CARGO SHORTS, and WHITE LACE-UP SNEAKERS on his feet`,
    callbackMotif: 'bold WHITE ROCKET EMBLEM on his chest exactly matching the rocket print on his real T-shirt on the left page — the rocket is now his costume crest, the deliberate visual gag is that the print on his real shirt has become his heraldic device',
    costumeColors: 'NAVY BLUE (matching his T-shirt colour on the left page) with white trim and accents (echoing the white rocket print)',
    feetCallback: 'WHITE LEATHER BOOTS on his feet (echoing his white sneakers from the left page)',
  },
  emma: {
    photoPath: path.join(__dirname, '../../tests/fixtures/demo-photos/berger/Emma.jpg'),
    pronouns: { subj: 'she', obj: 'her', poss: 'her', possClause: 'her own' },
    portrait: `a 5-YEAR-OLD girl with normal child proportions. Use her face exactly as in reference image 1: BROWN HAIR worn in TWO PIGTAILS tied with simple bands, warm BROWN EYES, light/fair skin with a small scatter of FRECKLES across the nose and cheeks`,
    outfitReal: `her PINK SHORT-SLEEVE T-SHIRT with a BOLD COLOURFUL BUTTERFLY PRINT (large butterfly with patterned wings) clearly visible across the chest, BLUE DENIM JEANS, and WHITE CANVAS SNEAKERS on her feet`,
    callbackMotif: 'large COLOURFUL BUTTERFLY EMBLEM on her chest exactly matching the butterfly print on her real T-shirt on the left page — the butterfly is now her heraldic crest, the deliberate visual gag is that the print on her real shirt has become her costume emblem',
    costumeColors: 'SOFT PINK (matching her T-shirt colour on the left page) with white trim and a hint of pale blue (echoing her blue jeans from the left page)',
    feetCallback: 'WHITE SATIN SLIPPERS on her feet (echoing her white canvas sneakers from the left page)',
    realMotifElement: 'a large COLOURFUL BUTTERFLY (the one from her real shirt, now flown off it and come to life) fluttering in the air just to her RIGHT',
    motifBecomesReal: true,
  },
  noah: {
    photoPath: path.join(__dirname, '../../tests/fixtures/demo-photos/berger/Noah.jpg'),
    pronouns: { subj: 'he', obj: 'him', poss: 'his', possClause: 'his own' },
    portrait: `a 7-YEAR-OLD boy with normal child proportions. Use his face exactly as in reference image 1: SHORT BLONDE HAIR, bright blue-grey eyes, light/fair skin, a few freckles across the nose`,
    outfitReal: `his FOREST-GREEN HOODED SWEATSHIRT with a BOLD WHITE T-REX DINOSAUR PRINT (clearly recognisable Tyrannosaurus silhouette) on the chest, DARK GREY JOGGER TROUSERS, and WHITE LACE-UP SNEAKERS on his feet`,
    callbackMotif: 'bold WHITE T-REX DINOSAUR EMBLEM on his chest exactly matching the T-Rex print on his real hoodie on the left page — the dinosaur is now his heraldic crest, the deliberate visual gag is that the print on his real hoodie has become his costume device',
    costumeColors: 'FOREST GREEN (matching his hoodie colour on the left page) with light silver trim and dark-grey accents (echoing his joggers from the left page)',
    feetCallback: 'WHITE LEATHER BOOTS on his feet (echoing his white sneakers from the left page)',
  },
  lea: {
    photoPath: path.join(__dirname, '../../tests/fixtures/demo-photos/dubois/Léa.jpg'),
    pronouns: { subj: 'she', obj: 'her', poss: 'her', possClause: 'her own' },
    portrait: `a 4-YEAR-OLD girl with normal small-child proportions. Use her face exactly as in reference image 1: SHORT CHESTNUT-BROWN HAIR in a soft bob, warm BROWN EYES, light/fair skin, gentle shy smile`,
    outfitReal: `her CHERRY-RED DRESS with LARGE WHITE POLKA DOTS (clearly visible round white spots scattered across the red fabric), WHITE TIGHTS, and BLACK PATENT-LEATHER MARY JANE SHOES on her feet`,
    callbackMotif: 'distinctive RED-AND-WHITE POLKA-DOT pattern carried over from her real dress — the polka dots are now woven through her costume, the deliberate visual gag is that the pattern on her real dress has become her signature costume motif',
    costumeColors: 'CHERRY RED with LARGE WHITE POLKA DOTS scattered across the fabric (the exact same pattern as her real dress on the left page) and white trim',
    feetCallback: 'BLACK PATENT-LEATHER SHOES on her feet (matching her real Mary Janes from the left page)',
    princessMotif: 'blowing a stream of shimmering round SOAP BUBBLES from her cupped hands — dozens of round bubbles drifting upward and catching the light (round like the white polka dots on her real dress) — eyes bright with wonder',
  },
  jules: {
    photoPath: path.join(__dirname, '../../tests/fixtures/demo-photos/dubois/Jules.jpg'),
    pronouns: { subj: 'he', obj: 'him', poss: 'his', possClause: 'his own' },
    portrait: `an 8-YEAR-OLD boy with normal child proportions. Use his face exactly as in reference image 1: SHORT BLACK HAIR, warm BROWN EYES, light olive skin, gentle calm expression`,
    outfitReal: `his NAVY-BLUE AND WHITE HORIZONTAL-STRIPED LONG-SLEEVE PULLOVER (classic French sailor/Breton stripes), BEIGE COTTON TROUSERS, and WHITE LACE-UP SNEAKERS on his feet`,
    callbackMotif: 'distinctive NAVY-AND-WHITE HORIZONTAL STRIPES carried over from his real Breton pullover — the sailor stripes are now woven through his costume shirt or sash, the deliberate visual gag is that the stripes on his real top have become his signature costume pattern',
    costumeColors: 'NAVY BLUE with thick WHITE HORIZONTAL STRIPES across the chest (the exact same Breton-stripe pattern as his real pullover on the left page) plus a wide black or brown leather belt',
    feetCallback: 'WHITE LEATHER BOOTS on his feet (echoing his white sneakers from the left page)',
  },
};

// ─── Theme profiles ──────────────────────────────────────────────────────
// fantasyPose — verb + body language for the watercolour panel
// fantasyOutfit — clothing prose; uses {colors}, {callback}, {feet} placeholders.
const THEMES = {
  princess: {
    label: 'PRINCESS',
    fantasyPose: ({ subj, poss }, kid) => `standing on the cobblestones in front of the landmark, ${kid && kid.realMotifElement ? kid.realMotifElement + ', and she happily reaches toward it' : 'holding a sparkly star-tipped magic wand raised in one hand'}. CRITICAL: the landmark behind stays LARGE, CLEAR and FULLY RECOGNISABLE, filling the page exactly like the left photo page — nothing covers or hides it`,
    fantasyOutfit: ({ colors, callback, feet }) => `flowing knee-length PRINCESS DRESS in ${colors}. A ${callback}. ${feet}. A small gold crown on the head, slightly tipped`,
  },
  wizard: {
    label: 'WIZARD',
    fantasyPose: ({ subj, poss }) => `standing in front of the landmark, one hand raised holding a tall wooden staff topped with a glowing crystal`,
    fantasyOutfit: ({ colors, callback, feet }) => `long flowing WIZARD ROBE in ${colors}, with wide sleeves and a wide leather belt at the waist. A ${callback}. ${feet}. A tall pointed wizard hat in matching colours, slightly tilted, with a small star or moon stitched on the band`,
  },
  knight: {
    label: 'KNIGHT',
    fantasyPose: ({ subj, poss }) => `standing in front of the landmark in a heroic stance, one hand on the hilt of a child-sized sword sheathed at the hip, the other resting at the side`,
    fantasyOutfit: ({ colors, callback, feet }) => `KNIGHT'S TUNIC in ${colors} worn over light silver chainmail, cinched with a leather belt and small scabbard. A ${callback}. ${feet}. NO full helmet covering the face — face fully visible`,
  },
  pirate: {
    label: 'PIRATE',
    fantasyPose: ({ subj, poss }) => `standing on the BOW of a SMALL wooden PIRATE SHIP in the LOWER FOREGROUND of the page — only the front part of the ship is visible (a raised carved wooden BOW with a solid HULL and SIDE BULWARKS — a proper little sailing ship with high wooden sides, NOT a flat open boat — a bit of plank deck and railing, a coil of rope, a sturdy mast with rigging and a sail kept to the far LEFT edge, a small SKULL-AND-CROSSBONES FLAG). It is clearly a small pirate sailing ship — NOT a rowing boat, NOT a barge, NOT a canoe, NOT a raft, NOT a dinghy, NOT a flat open dinghy with a pole — but it stays LOW in the foreground and must NOT fill the page. CRITICAL: the landmark behind, across the water, must stay LARGE, CLEAR and FULLY RECOGNISABLE, filling the upper two-thirds of the page exactly like the left photo page — the ship, mast and sail must NOT cover, hide, shrink or block the landmark; the landmark is the hero of the image, the ship is only a small foreground prop. One arm RAISED HIGH holding a full-length curved PIRATE SWORD pointed up toward the sky — the ENTIRE blade visible from hilt to tip, gleaming steel, unmistakably a complete sword (NOT sheathed, NOT broken, NOT a stub, NOT half a blade) — the other hand on the hip`,
    fantasyOutfit: ({ colors, callback, feet }) => `PIRATE'S WAISTCOAT over a SHIRT in ${colors}, with a wide leather belt and a brass buckle. A ${callback}. ${feet}. A red bandana tied around the head (or a small black tricorn pirate hat with a skull emblem), face fully visible`,
  },
};

// ─── Lookup landmark from landmark_index ─────────────────────────────────
async function resolveLandmark(name, slot = 1) {
  const slotN = Math.max(1, Math.min(6, parseInt(slot, 10) || 1));
  const urlCol = slotN === 1 ? 'photo_url' : `photo_url_${slotN}`;
  const descCol = slotN === 1 ? 'photo_description' : `photo_description_${slotN}`;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    const sql = `SELECT name, nearest_city, ${urlCol} AS photo_url, ${descCol} AS photo_description FROM landmark_index WHERE name = $1 LIMIT 1`;
    let r = await pool.query(sql, [name]);
    if (r.rowCount === 0) {
      const sqlLike = `SELECT name, nearest_city, ${urlCol} AS photo_url, ${descCol} AS photo_description FROM landmark_index WHERE name ILIKE $1 LIMIT 1`;
      r = await pool.query(sqlLike, [`%${name}%`]);
    }
    if (r.rowCount === 0 || !r.rows[0].photo_url) {
      throw new Error(`Landmark not found in landmark_index (or no photo at slot ${slotN}): "${name}"`);
    }
    return r.rows[0];
  } finally {
    await pool.end();
  }
}

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

function slugify(s) {
  return s.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

// ─── Main ────────────────────────────────────────────────────────────────
async function main() {
  const kid = KIDS[KID_KEY];
  const theme = THEMES[THEME];
  if (!kid)   throw new Error(`Unknown kid "${KID_KEY}". Options: ${Object.keys(KIDS).join(', ')}`);
  if (!theme) throw new Error(`Unknown theme "${THEME}". Options: ${Object.keys(THEMES).join(', ')}`);

  if (!fs.existsSync(kid.photoPath)) throw new Error('Missing kid photo: ' + kid.photoPath);
  const kidRef = fileToDataUri(kid.photoPath);
  console.log(`✓ Loaded ${KID_KEY} portrait`);

  const lm = await resolveLandmark(LANDMARK_NAME, args.photoSlot || args['photo-slot'] || 1);
  console.log(`✓ DB landmark: ${lm.name} [${lm.nearest_city}]`);
  console.log(`  photo_url: ${lm.photo_url}`);

  const landmarkRef = await fetchAsDataUri(lm.photo_url);
  console.log(`✓ Downloaded landmark photo`);

  // Save reference for visual sanity check
  const citySlug = slugify(lm.nearest_city || 'unknown');
  const cityDir = path.join(DRAFTS_ROOT, citySlug);
  if (!fs.existsSync(cityDir)) fs.mkdirSync(cityDir, { recursive: true });

  const refSlug = slugify(lm.name);
  const refBuf = Buffer.from(landmarkRef.replace(/^data:image\/\w+;base64,/, ''), 'base64');
  fs.writeFileSync(path.join(cityDir, `_ref_${refSlug}.jpg`), refBuf);

  const fantasyPose = theme.fantasyPose(kid.pronouns, kid);
  // When a kid's motif "becomes real", the costume carries NO emblem in ANY theme —
  // the motif instead appears as a live element in the scene (realMotifClause below).
  const callbackMotif = kid.motifBecomesReal
    ? "PLAIN costume with NO printed emblem, crest, badge or motif anywhere on it — the child's signature motif is NOT on the fabric"
    : kid.callbackMotif;
  const fantasyOutfit = theme.fantasyOutfit({
    colors: kid.costumeColors,
    callback: callbackMotif,
    feet: kid.feetCallback,
  }, kid);
  // Princess weaves the live motif into its own pose; other themes get it appended here.
  const realMotifClause = (kid.motifBecomesReal && kid.realMotifElement && THEME !== 'princess')
    ? ` Also in the watercolour scene, ${kid.realMotifElement}.`
    : '';

  const prompt = `A 16:9 children's-book ad illustration. Composition: an open hardcover children's picture book filling most of the frame — book spans roughly 90% of the width and 75% of the height. Only a thin border of soft cream-coloured surface and a slightly out-of-focus warm cosy living-room background visible around the book. Book centred, viewed slightly from above so both pages are clearly visible. Both pages must read clearly.

LEFT PAGE — a REAL UNRETOUCHED DSLR PHOTOGRAPH (Canon EOS R5, 50mm f/1.8, natural daylight, RAW capture look) printed onto the storybook paper. NOT an illustration, NOT painted, NOT digitally smoothed.

LEFT PAGE BACKGROUND IS MANDATORY: the ${lm.name} from reference image 2 must appear as a real photograph spanning the full width of the LEFT PAGE alone. Match reference image 2 LITERALLY — same architecture, same proportions, same colours, same lighting direction. ${lm.photo_description ? 'Description: ' + lm.photo_description : ''} Do NOT substitute a generic building or generic Swiss scene.

The child from reference image 1 stands in the foreground in front of the landmark. ${kid.portrait}. ${kid.pronouns.subj.charAt(0).toUpperCase() + kid.pronouns.subj.slice(1)} is in three-quarter profile, body and shoulders angled to the right, head turned to the right, eyes looking off the RIGHT edge toward the right page — gazing longingly at their costumed fantasy self on the other page with a WISTFUL, slightly ENVIOUS, yearning expression (lips closed, quietly wishing they could be that hero). NOT looking at the camera, NOT a big smile. Wearing ${kid.outfitReal}. Photographic realism: visible real skin texture, individual hair strands, real fabric weave, DEEP depth of field — BOTH the child's face AND the landmark architecture behind in TACK-SHARP focus (shot at f/8 or smaller aperture, NOT shallow DoF, NOT bokeh, NOT blurred background). Every architectural detail of the landmark — stones, windows, ornaments, rooflines — must be crisply legible. Real natural daylight, no painterly brushstrokes, no smoothing.

RIGHT PAGE — TRADITIONAL HAND-PAINTED WATERCOLOUR ILLUSTRATION in the style of classic European children's picture books (Beatrix Potter, Jan Brett, Inga Moore). Pure watercolour: visibly wet brushstrokes, soft pigment bleed, slightly uneven washes, granulation in shadowed areas, visible cold-press paper grain, fine soft pencil outlines barely showing through. NOT digital art, NOT smooth gradients, NOT airbrushed.

RIGHT PAGE BACKGROUND IS MANDATORY: the SAME ${lm.name} view as the left page, spanning the full width of the RIGHT PAGE alone, but rendered in watercolour. Same architecture, same proportions, same composition. Each page is a self-contained complete view — the landmark does NOT span across the spine. BOTH pages must contain the FULL landmark, each within its own page bounds.

Foreground action: the SAME CHILD, with the IDENTICAL FACE AND HAIR as reference image 1 and the left page — ${kid.portrait}. Keep the EXACT same hairstyle (do NOT change it to loose, flowing, longer, or any different style — if the hair is in two pigtails it stays in two pigtails) AND the EXACT same hair COLOUR as the photo (never lighten dark-brown or black hair toward blond in the watercolour — dark hair stays dark), the same face shape, same eyes, same freckles, same age and proportions. ONLY the clothing changes — never the face or the hair. The child is reimagined as a little ${theme.label} ${fantasyPose}. ${kid.pronouns.subj.charAt(0).toUpperCase() + kid.pronouns.subj.slice(1)} wears a ${fantasyOutfit}. The costumed child looks STRAIGHT INTO THE CAMERA / at the viewer with a big, bright, proud, joyful smile — head and eyes turned to face the camera, NOT looking off to the side.${realMotifClause} Soft watercolour washes, hand-painted texture, visible paper grain, warm golden afternoon light, friendly storybook mood.

INTENTIONAL CONTRAST between the two figures: the LEFT (real-photo) child gazes sideways toward the right page at their costumed self with quiet longing/envy; the RIGHT (costumed) child faces the viewer and beams a big proud smile straight into the camera. This difference is deliberate — do NOT make both look the same way.

Book has clearly readable paper texture, slight curve at the spine, faint shadow in the gutter. A few small magical sparkles drift from the right page like fairy dust.

Composition: book centred. Calm space top-right above the watercolour page (leaves room for an ad headline). NO text anywhere in the image. NO logos. NO watermarks. NO brand names. NO captions. NO signatures. NO fake AI watermarks in any corner. Completely clean image with zero text overlays.

Reference image 1 = the child's face/identity (use across both pages — same child).
Reference image 2 = ${lm.name} (use as backdrop on BOTH pages).

Aspect 16:9, warm cinematic light, cosy mood.`;

  console.log(`\nPrompt length: ${prompt.length} chars`);
  console.log(`Theme: ${theme.label}, Kid: ${KID_KEY}, Landmark: ${lm.name}`);
  console.log('Generating with Grok edit (2 references, 16:9)…\n');

  const t0 = Date.now();
  const result = await editWithGrok(prompt, [kidRef, landmarkRef], {
    aspectRatio: '16:9',
    resolution: '2k',
  });
  const ms = Date.now() - t0;

  const b64 = result.imageData.replace(/^data:image\/\w+;base64,/, '');
  const buf = Buffer.from(b64, 'base64');
  const lmSlug = slugify(lm.name);
  const outPath = path.join(cityDir, `${citySlug}-book-${THEME}-${KID_KEY}-${lmSlug}.jpg`);
  fs.writeFileSync(outPath, buf);

  console.log(`✅ Done in ${ms}ms`);
  console.log(`   Saved: ${outPath}`);
  console.log(`   Size:  ${(buf.length / 1024).toFixed(1)} KB`);
}

main().catch(e => { console.error('❌ Failed:', e.message); process.exit(1); });
