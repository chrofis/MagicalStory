#!/usr/bin/env node
/**
 * Local re-evaluation of an existing 2×4 attempt-set with EXPANDED context:
 *   - Image 1: source face photo (same as production)
 *   - Image 2: standard avatar (single-image body reference) [NEW]
 *   - Image 3: the 2×4 sheet [was Image 2]
 *   - Text:   character profile (age/gender/hair/build/glasses) [NEW]
 *
 * Doesn't touch production code. Just calls Gemini directly with the new
 * shape and prints old-vs-new scores for each attempt so we can see whether
 * the expanded context actually discriminates the visually-different sheets
 * (which the production eval scored identically at S=9).
 *
 * Usage:
 *   node scripts/test-2x4-eval-with-context.js                   # Manuel, costumed:medieval, Tell story
 *   node scripts/test-2x4-eval-with-context.js --char=Sophie     # different char
 *   node scripts/test-2x4-eval-with-context.js --story-id=...    # different story
 *   node scripts/test-2x4-eval-with-context.js --no-avatar       # skip Image 2 (face-only, for A/B comparison)
 *   node scripts/test-2x4-eval-with-context.js --no-desc         # skip text description
 */

'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);

const STORY_ID = args['story-id'] || 'job_1779829275600_12ru2yayv';
const CHAR_NAME = args.char || 'Manuel';
const COSTUME = args.costume || 'costumed:medieval';
const INCLUDE_AVATAR = args['no-avatar'] !== 'true';
const INCLUDE_DESC = args['no-desc'] !== 'true';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) { console.error('GEMINI_API_KEY missing'); process.exit(1); }

const r2 = require(path.resolve(__dirname, '..', 'server', 'lib', 'r2.js'));

const STAMP = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const OUT_DIR = path.resolve(__dirname, '..', 'drafts', '2x4-eval-test', STAMP);
fs.mkdirSync(OUT_DIR, { recursive: true });

// ────────────────────────────────────────────────────────────────────────
// Build the upgraded eval prompt. Differs from prompts/sheet-2x4-evaluation
// in two places:
//   1. Mentions Image 2 = standard avatar, renumbers sheet to Image 3
//   2. Includes a CHARACTER PROFILE block with declared traits
//   3. Task 4 expanded: source-photo match uses BOTH Image 1 (face) and
//      Image 2 (avatar body/proportions/age cues) as identity references
// ────────────────────────────────────────────────────────────────────────
function buildPrompt({ characterDescription, costumeDescription, hasAvatar }) {
  const sheetImageNum = hasAvatar ? 3 : 2;
  const avatarLine = hasAvatar
    ? `  - Image 2: STANDARD AVATAR — a single-image body reference (modern clothing) showing the SAME PERSON at full height. Use this for body proportions, age cues, build, and identity confirmation alongside Image 1.\n`
    : '';
  const descBlock = characterDescription
    ? `\nCHARACTER PROFILE (the declared spec for this person):\n${characterDescription}\n\nThis profile is the AUTHORITY on age/gender/build. When a generated cell looks like the wrong age decade or wrong gender vs the profile, score it 1-3 even if the face features approximately match Image 1.\n`
    : '';
  const sourceImagesPhrase = hasAvatar ? 'Image 1 (face photo) + Image 2 (standard avatar)' : 'Image 1 (source photo)';

  return `You are evaluating a 2×4 character reference sheet produced by an image model.

You receive ${hasAvatar ? 'THREE' : 'TWO'} images:
  - Image 1: the SOURCE FACE PHOTO of the real person the sheet is supposed to depict.
${avatarLine}  - Image ${sheetImageNum}: the GENERATED 2×4 sheet to evaluate.
${descBlock}
Image ${sheetImageNum} is a single grid: 4 columns × 2 rows = 8 cells, separated by thin white gutters. Layout:
  Row 1 (cells 1-4, top):    HEAD AND NECK ONLY. Four facing angles: front, three-quarter, profile, back of head.
  Row 2 (cells 5-8, bottom): FULL BODY head to feet, wearing the requested costume. Same four facing angles.

Your job: rate the sheet on FOUR checks and return a JSON verdict.

TASK 1: LAYOUT
- Top row: 4 head-and-neck portraits, no shoulders/torso. Score 1-10.
- Bottom row: 4 full-body figures. Score 1-10.
- Horizontal gutter: white space, no figure crosses it. Score 1-10.
- Cell containment: every figure inside its own cell with white margin on all four sides. Score 1-10.
- \`layoutScore\` = lowest of the four. A waist-cutting failure or figure spanning two cells must score 1-3.

TASK 2: IDENTITY MATCHES THE STANDARD AVATAR (per cell, lowest wins)
${hasAvatar
  ? `- Image 2 (standard avatar) is the IDENTITY ANCHOR — a known-good rendering of the same person. Compare EVERY cell of the sheet against Image 2, not against cell 1 of the sheet itself.\n- For each of the 8 cells in Image 3: does it show the same person as Image 2? Same face structure, hair colour and length, skin tone, gender, age bucket.\n- Pose / framing / render-angle differs by design (front, three-quarter, profile, back, head-only, full-body) — do NOT penalise that. Score by IDENTITY only.\n- Per-cell score 1-10:\n   * 8-10: clearly the same person; only pose/angle differs.\n   * 4-6: ambiguous — face structure similar but age, hair, or build visibly drifted from Image 2.\n   * 1-3: clearly a different person from Image 2 (wrong gender, wrong race, or face structure unrelated).\n- \`identityScore\` = LOWEST of the 8 per-cell scores. Do not average. Same person rendered slightly younger or older than Image 2 is NOT a 1-3; it's a 4-7 depending on degree.`
  : `- Pick cell 1 as the reference (no standard avatar provided this run).\n- Score cells 2-8 against cell 1: same face structure, hair, gender, skin tone. Pose may differ.\n- \`identityScore\` = LOWEST of the 7 per-cell scores.`}

TASK 3: OUTFIT MATCHES REQUESTED COSTUME (item-by-item)
- Read REQUESTED_OUTFIT and split into items.
- For each item, check whether cells 5-8 visibly wear it.
- All present = 10. ONE missing = ≤4. TWO+ missing = ≤2. Wrong colour = ≤5.
- Cross-cell consistency: all 4 body cells wear the same outfit. Varying = 1-3.
- \`outfitScore\` = LOWER of item-match and cross-cell consistency.

TASK 4: SOURCE PHOTO IDENTITY MATCH (per head cell, lowest wins)
This task is SEPARATE from Task 2. Task 2 checks "does the sheet match the standard avatar"; this task checks "does the rendered character match the real person in Image 1 + the declared profile".
- Compare Image 1 (face photo) against EACH of the 4 head cells (cells 1, 2, 3, 4) in Image 3.
- Cross-check against CHARACTER PROFILE${characterDescription ? '' : ' (not provided)'} — apparent age in the rendered cells must match the profile's age bucket. If the profile says young-teen (12-15) and the head cell looks 6-9, score that cell 1-3 regardless of how good the face features look.
- Per-cell score 1-10. Different person (wrong gender, wrong age decade, wrong race, unrelated face) must score 1-3.
- \`sourceMatchScore\` = LOWEST of the 4 per-cell scores. Do not average.
- Style/medium difference (photo vs illustration) scores 8-10 ONLY when face structure + hair + age bucket + gender ALL match. Drop to 6-7 if any one is visibly off. Drop to ≤5 if 2+ are off.

REQUESTED_OUTFIT: ${costumeDescription}

\`finalScore\` = LOWEST of layoutScore, identityScore, outfitScore, sourceMatchScore.
\`valid\` = (finalScore ≥ 6).

Return EXACTLY:
{
  "layout":     {"topRowHeadsOnly":{"score":N,"reason":"..."},"bottomRowFullBody":{"score":N,"reason":"..."},"cleanGutter":{"score":N,"reason":"..."},"cellContainment":{"score":N,"reason":"..."},"layoutScore":N},
  "identity":   {"perCell":{"cell1":N,"cell2":N,"cell3":N,"cell4":N,"cell5":N,"cell6":N,"cell7":N,"cell8":N},"identityScore":N,"reason":"..."},
  "outfit":     {"crossCellConsistency":{"score":N,"reason":"..."},"matchesRequested":{"score":N,"reason":"..."},"outfitScore":N},
  "sourceMatch":{"perCell":{"cell1":N,"cell2":N,"cell3":N,"cell4":N},"sourceMatchScore":N,"reason":"..."},
  "finalScore":N,"valid":B,"failureReasons":[]
}`;
}

function buildCharacterDescription(char) {
  if (!char) return '';
  const parts = [];
  if (char.name) parts.push(`Name: ${char.name}`);
  if (char.age) parts.push(`Age: ${char.age} years old`);
  if (char.ageCategory) parts.push(`Age category: ${char.ageCategory}`);
  if (char.gender) parts.push(`Gender: ${char.gender}`);
  if (char.height) parts.push(`Height: ${char.height} cm`);
  if (char.build) parts.push(`Build: ${char.build}`);
  const phys = char.physical || {};
  if (phys.hairColor || phys.hairLength || phys.hairStyle) {
    const hairParts = [];
    if (phys.hairColor) hairParts.push(phys.hairColor);
    if (phys.hairLength) hairParts.push(phys.hairLength);
    if (phys.hairStyle) hairParts.push(phys.hairStyle);
    parts.push(`Hair: ${hairParts.join(', ')}`);
  }
  if (phys.facialFeatures) parts.push(`Facial features: ${phys.facialFeatures}`);
  if (phys.facialHair) parts.push(`Facial hair: ${phys.facialHair}`);
  if (phys.glasses) parts.push(`Glasses: ${phys.glasses}`);
  if (phys.distinctiveMarks) parts.push(`Distinctive marks: ${phys.distinctiveMarks}`);
  return parts.join('\n');
}

async function callGemini({ facePhoto, avatar, sheet, prompt, hasAvatar }) {
  const parts = [];
  const dataUriToInline = (dataUri) => {
    const b64 = dataUri.replace(/^data:image\/\w+;base64,/, '');
    const mime = dataUri.match(/^data:(image\/\w+);base64,/)?.[1] || 'image/jpeg';
    return { inline_data: { mime_type: mime, data: b64 } };
  };
  parts.push(dataUriToInline(facePhoto));
  if (hasAvatar && avatar) parts.push(dataUriToInline(avatar));
  parts.push(dataUriToInline(sheet));
  parts.push({ text: prompt });
  const body = {
    contents: [{ parts }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 4000, responseMimeType: 'application/json' },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
    ],
  };
  const t0 = Date.now();
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) }
  );
  const ms = Date.now() - t0;
  if (!resp.ok) throw new Error(`Gemini HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  const j = await resp.json();
  const text = j?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned no text');
  const usage = j?.usageMetadata || {};
  return { verdict: JSON.parse(text), ms, usage };
}

async function bytesToDataUri(src, label) {
  if (!src) return null;
  // String input. Could be data URI, https URL, or raw base64.
  if (typeof src === 'string' && src.startsWith('data:')) return src;
  const bytes = await r2.bytesFromAnyImage(src);
  if (!bytes) {
    console.warn(`  ⚠ Could not load ${label} from`, typeof src === 'string' ? src.slice(0, 80) : '(non-string)');
    return null;
  }
  return `data:image/jpeg;base64,${bytes.toString('base64')}`;
}

(async () => {
  const dbUrl = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  if (!dbUrl) { console.error('DATABASE_URL not set'); process.exit(1); }
  const pool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

  console.log('═══ 2×4 Eval — re-evaluation with expanded context ═══');
  console.log(`Story: ${STORY_ID}  Character: ${CHAR_NAME}  Costume: ${COSTUME}`);
  console.log(`Include avatar: ${INCLUDE_AVATAR}  Include description: ${INCLUDE_DESC}`);
  console.log(`Output dir: ${OUT_DIR}\n`);

  const r = await pool.query(
    `SELECT data->'styledAvatarGeneration' AS sag, data->'characters' AS chars
     FROM stories WHERE id = $1`,
    [STORY_ID]
  );
  if (!r.rows[0]) { console.error('Story not found'); await pool.end(); process.exit(1); }

  const sag = r.rows[0].sag || [];
  const entry = sag.find(e => e.characterName === CHAR_NAME && e.clothingCategory === COSTUME);
  if (!entry) {
    console.error(`No styled-avatar entry for ${CHAR_NAME} / ${COSTUME}. Available:`);
    for (const e of sag) console.error(`  ${e.characterName} / ${e.clothingCategory}`);
    await pool.end(); process.exit(1);
  }
  const p1 = entry.passes?.pass1;
  if (!p1?.attempts?.length) { console.error('No pass1 attempts stored'); await pool.end(); process.exit(1); }
  console.log(`Found ${p1.attempts.length} pass1 attempt(s). selectedAttempt=#${p1.selectedAttempt} finalScore=${p1.finalScore}\n`);

  const chars = r.rows[0].chars || [];
  const charRecord = chars.find(c => c.name === CHAR_NAME);
  const characterDescription = INCLUDE_DESC ? buildCharacterDescription(charRecord) : '';
  if (INCLUDE_DESC) {
    console.log('CHARACTER PROFILE being passed to Gemini:');
    console.log(characterDescription.split('\n').map(l => '  ' + l).join('\n'));
    console.log();
  }

  // Resolve inputs once. Falls back to avatars.faceThumbnailsUrl when the
  // standard helper misses (pre-R2-normalization schema, see field-naming
  // mismatch documented elsewhere). Picks the 'standard' variant of the face
  // thumbnail to most closely match what production would feed Grok.
  const { getFacePhoto } = require(path.resolve(__dirname, '..', 'server', 'lib', 'characterPhotos.js'));
  let faceSrc = getFacePhoto(charRecord) || charRecord?.facePhoto || null;
  if (!faceSrc) {
    const ft = charRecord?.avatars?.faceThumbnailsUrl;
    if (ft && typeof ft === 'object') {
      faceSrc = ft.standard || ft.summer || ft.winter || null;
      if (faceSrc) console.log('(face fallback: avatars.faceThumbnailsUrl)');
    }
  }
  const facePhoto = await bytesToDataUri(faceSrc, 'face photo');
  if (!facePhoto) { console.error('Could not load face photo for', CHAR_NAME); await pool.end(); process.exit(1); }
  console.log(`Loaded face photo (${(facePhoto.length / 1024).toFixed(1)} KB data URI)`);

  let avatar = null;
  if (INCLUDE_AVATAR) {
    const avatarSrc = charRecord?.avatars?.standardUrl || charRecord?.avatars?.standard;
    avatar = await bytesToDataUri(avatarSrc, 'standard avatar');
    console.log(avatar ? `Loaded standard avatar (${(avatar.length / 1024).toFixed(1)} KB)` : 'No standard avatar available');
  }

  const costumeText = entry.costumeDescription || COSTUME;
  const prompt = buildPrompt({
    characterDescription,
    costumeDescription: costumeText,
    hasAvatar: !!avatar && INCLUDE_AVATAR,
  });
  fs.writeFileSync(path.join(OUT_DIR, 'prompt.txt'), prompt);

  // Save inputs once (face + avatar) at the run level so we can inspect them.
  fs.writeFileSync(path.join(OUT_DIR, 'input-face.jpg'), Buffer.from(facePhoto.replace(/^data:image\/\w+;base64,/, ''), 'base64'));
  if (avatar) fs.writeFileSync(path.join(OUT_DIR, 'input-avatar.jpg'), Buffer.from(avatar.replace(/^data:image\/\w+;base64,/, ''), 'base64'));

  const rows = [];
  for (let i = 0; i < p1.attempts.length; i++) {
    const a = p1.attempts[i];
    console.log(`\n--- Attempt #${a.attempt} (production scored: ${a.stage}, score=${a.score}, L=${a.layoutScore} I=${a.identityScore} O=${a.outfitScore} S=${a.sourceMatchScore}) ---`);
    if (!a.imageData) { console.log('  no imageData stored, skipping'); continue; }
    const sheetDataUri = a.imageData.startsWith('data:')
      ? a.imageData
      : `data:image/jpeg;base64,${a.imageData}`;
    fs.writeFileSync(path.join(OUT_DIR, `attempt-${a.attempt}-sheet.jpg`), Buffer.from(sheetDataUri.replace(/^data:image\/\w+;base64,/, ''), 'base64'));
    try {
      const { verdict, ms, usage } = await callGemini({ facePhoto, avatar, sheet: sheetDataUri, prompt, hasAvatar: !!avatar });
      console.log(`  NEW eval (${ms}ms, ${usage.promptTokenCount}→${usage.candidatesTokenCount} tokens):`);
      console.log(`    L=${verdict.layout?.layoutScore} I=${verdict.identity?.identityScore} O=${verdict.outfit?.outfitScore} S=${verdict.sourceMatch?.sourceMatchScore}  final=${verdict.finalScore}  valid=${verdict.valid}`);
      console.log(`    sourceMatch reason: ${verdict.sourceMatch?.reason || '(none)'}`);
      console.log(`    perCell: ${JSON.stringify(verdict.sourceMatch?.perCell || {})}`);
      if (verdict.failureReasons?.length) {
        console.log(`    failureReasons: ${verdict.failureReasons.join(' · ')}`);
      }
      fs.writeFileSync(path.join(OUT_DIR, `attempt-${a.attempt}-verdict.json`), JSON.stringify(verdict, null, 2));
      rows.push({
        attempt: a.attempt,
        oldL: a.layoutScore, oldI: a.identityScore, oldO: a.outfitScore, oldS: a.sourceMatchScore, oldFinal: a.score, oldValid: a.stage === 'valid',
        newL: verdict.layout?.layoutScore, newI: verdict.identity?.identityScore, newO: verdict.outfit?.outfitScore, newS: verdict.sourceMatch?.sourceMatchScore, newFinal: verdict.finalScore, newValid: verdict.valid,
      });
    } catch (err) {
      console.log(`  ✗ eval failed: ${err.message}`);
    }
  }

  console.log('\n═══ Summary ═══');
  console.log('attempt | L old→new | I old→new | O old→new | S old→new | final old→new | valid old→new');
  for (const r of rows) {
    console.log(`  #${r.attempt}    | ${r.oldL}→${r.newL}     | ${r.oldI}→${r.newI}     | ${r.oldO}→${r.newO}     | ${r.oldS}→${r.newS}     | ${r.oldFinal}→${r.newFinal}        | ${r.oldValid}→${r.newValid}`);
  }
  fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(rows, null, 2));
  console.log(`\nFiles saved: ${OUT_DIR}`);
  await pool.end();
})().catch(err => { console.error('FATAL:', err); process.exit(1); });
