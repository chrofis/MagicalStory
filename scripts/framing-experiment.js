#!/usr/bin/env node
/**
 * Framing experiment — tests safe-framing strategies for violence-adjacent
 * story moments. Uses REAL story data (characters, empty scene, art style,
 * landmark photos) from a specific story + page, runs N alternative framings
 * through Grok Imagine, records blocks/passes, saves everything to a review
 * folder for human eval.
 *
 * Usage:
 *   node scripts/framing-experiment.js
 *
 * Hardcoded for Tell story P6 (apple-shot moment). Edit FRAMINGS below to
 * change scenes. Re-run is idempotent — existing outputs are not overwritten.
 */
'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const ROOT = path.resolve(__dirname, '..');
const STORY_ID = 'job_1776554957628_pw7g3k0d5';
const PAGE = 6; // The apple-shot moment
const OUT_DIR = path.join(ROOT, 'tests', 'framing-experiment');

// Art style (realistic photorealistic children's book — matches the story)
const ART_STYLE = `A photorealistic children's book illustration. Real people in real settings. Natural lighting, cinematic composition, shallow depth of field. Characters are real humans — natural proportions, real skin texture with pores, natural hair. NOT illustrated, NOT stylized, NOT animated. Think professional children's photography with storybook staging. Faces: real human faces with visible skin texture, natural eye size, defined features, warm natural lighting. Never cartoonish or stylized. Preserve each character's actual age.`;

// The 5 framings we test. Each defines:
// - name: short identifier used in filenames
// - description: human-readable summary
// - characters: which named characters appear (references will be attached)
// - prompt: full illustration prompt sent to Grok
const FRAMINGS = [
  {
    name: 'A_before_manuel_closeup',
    description: 'BEFORE — close-up on Manuel preparing the crossbow (checking it, not aiming). Calm readiness.',
    characters: ['Manuel'],
    prompt: `Generate a SINGLE illustration filling the ENTIRE canvas edge-to-edge. No borders, no frames, no margins, no white edges. Do NOT add any text, letters, words, labels, signatures, or watermarks.

Chest-and-hands close-up of a teenage boy preparing a medieval wooden crossbow — not aiming, just getting ready. He holds it in front of himself, looking down at it, turning it in his hands to check that the bolt sits properly in the groove and the bowstring is seated. The bowstring is relaxed, not drawn. His expression is calm, methodical, focused on the tool itself — not tense, not aggressive. Just an archer making sure his equipment is in order. Torso and hands dominate the frame. Soft out-of-focus autumn village square in the far background — grey cobblestones, low stone roofs, cold overcast November morning light. He wears a dark grey wool jerkin over a white linen shirt and a heavy leather belt.

The attached reference photo is the source of truth for his face, hair, build, and clothing. Match them exactly.

${ART_STYLE}`,
  },
  {
    name: 'B_before_lukas_solo_apple',
    description: 'BEFORE — close-up on Lukas alone, apple on head, tense and frightened (eyes OPEN, afraid).',
    characters: ['Lukas'],
    prompt: `Generate a SINGLE illustration filling the ENTIRE canvas edge-to-edge. No borders, no frames, no margins, no white edges. Do NOT add any text, letters, words, labels, signatures, or watermarks.

Close-up portrait of a small medieval boy standing stiffly against a massive oak trunk, a single perfectly round red apple balanced upright on the top of his head. His eyes are OPEN WIDE with fear — pupils small, brow furrowed, lips pressed tightly together, jaw clenched, a small wrinkle between his brows. His whole body is rigid with tension: shoulders drawn up, arms pressed flat at his sides, chin tucked slightly. He is trying not to move a muscle. His expression is frightened but brave — a child holding himself perfectly still despite being scared. He wears a simple light-brown wool tunic to the knees, narrow leather belt, dark brown wool hose. Cold flat November morning light. Rough dark oak bark fills the background behind him. Nothing else in the scene — no other people, no weapons, no crowd visible.

The attached reference photo is the source of truth for his face, hair, build, and clothing.

${ART_STYLE}`,
  },
  {
    name: 'C_pov_through_crossbow',
    description: 'POV through the crossbow sight — Lukas in far distance with apple on head (like a mini B).',
    characters: ['Lukas'],
    prompt: `Generate a SINGLE illustration filling the ENTIRE canvas edge-to-edge. No borders, no frames, no margins, no white edges. Do NOT add any text, letters, words, labels, signatures, or watermarks.

First-person viewpoint looking directly along the length of a medieval wooden crossbow. The dark oak stock and iron fittings fill the lower third of the frame, in sharp focus. The taut bowstring stretches across the middle. Down the line of the bolt groove, in the far distance at the exact centre of the frame, a small medieval boy stands very still against a massive old oak trunk — a single round red apple balanced upright on top of his head. The distant boy is tiny in the frame (about one-eighth of the image height) and softly focused, but his face is visible and looks tense, eyes open, holding his breath. He wears a light-brown medieval tunic. Cold overcast November morning, grey cobblestones in front of him. Shallow depth of field — crossbow sharp, distant boy soft. The composition reads as a practice shot from the archer's point of view.

The attached reference photo is the source of truth for the boy's face, hair, build, and clothing — even at small scale.

${ART_STYLE}`,
  },
  {
    name: 'D1_left_right_facing',
    description: 'WIDE — Manuel far left aiming right across the frame; Lukas far right in profile against the tree, apple on head.',
    characters: ['Manuel', 'Lukas'],
    prompt: `Generate a SINGLE illustration filling the ENTIRE canvas edge-to-edge. No borders, no frames, no margins, no white edges. Do NOT add any text, letters, words, labels, signatures, or watermarks.

Wide side-view shot of a medieval cobblestone market square. On the FAR LEFT of the frame, a teenage boy stands in side-profile — his body faces right, his feet on the cobblestones, a medieval wooden crossbow raised at chest height and pointing horizontally toward the right side of the frame. He wears a dark grey wool jerkin over a white linen shirt, a leather belt, medieval leggings. His expression is calm and focused. The entire MIDDLE of the frame is empty cobblestone plaza — no characters, no obstacles, just pavement and a little mist. On the FAR RIGHT of the frame, a small medieval boy stands in side-profile facing LEFT (toward the archer) — his back against the rough bark of a massive old oak trunk, a single round red apple balanced upright on the top of his head. He wears a light-brown medieval tunic, narrow belt, dark wool hose. Both figures are the same approximate height in the frame — neither is tiny, neither is dominant. The empty space between them is the subject of the composition. Cold overcast November morning, pale grey sky above, stone houses softly visible in the deep background.

The attached reference photos are the source of truth for the two boys' faces, hair, build, and clothing. Match them exactly.

${ART_STYLE}`,
  },
  {
    name: 'D2_over_shoulder_distant_kid',
    description: 'Over-the-shoulder on Manuel (foreground, big). Lukas tiny in the far-far distance — generic medieval kid with red apple.',
    characters: ['Manuel'],
    prompt: `Generate a SINGLE illustration filling the ENTIRE canvas edge-to-edge. No borders, no frames, no margins, no white edges. Do NOT add any text, letters, words, labels, signatures, or watermarks.

Over-the-shoulder view from behind a teenage boy who holds a medieval wooden crossbow raised at chest height. His back, shoulder, short tousled dark hair, and hands on the crossbow stock fill the LEFT FOREGROUND of the frame — large, partly out of focus, sharply lit from the right side. He wears a dark grey wool jerkin. Down the line of the bolt groove, in the very far distance at the centre of the frame, a TINY generic small boy stands against a massive old oak trunk — only a few percent of the image height, no facial features visible, just silhouette: short brown hair, a plain light-brown medieval tunic, arms at his sides. A bright red apple balanced on top of his head is the only clearly visible detail at that distance. Empty cobblestone plaza fills the space between them. Cold overcast November morning. Shallow depth of field — archer's shoulder sharp, distant boy soft and small.

The attached reference photo is the source of truth for the foreground archer's face, hair, build, and clothing. The distant boy should look like a generic medieval child — no close-up detail at that scale.

${ART_STYLE}`,
  },
  {
    name: 'E_aftermath_pierced_apple',
    description: 'AFTERMATH — bolt has pierced THROUGH the apple and is stuck in the tree. Lukas standing in front, relieved.',
    characters: ['Lukas'],
    prompt: `Generate a SINGLE illustration filling the ENTIRE canvas edge-to-edge. No borders, no frames, no margins, no white edges. Do NOT add any text, letters, words, labels, signatures, or watermarks.

A small medieval boy stands quietly on grey cobblestones in front of a massive old oak trunk. He is still — arms at his sides, body relaxed, shoulders lowered, expression one of quiet dawning relief. He wears a simple light-brown medieval wool tunic to the knees, narrow leather belt, dark brown wool hose. ABOVE his head, a short wooden crossbow bolt with dark fletching is embedded deep into the rough oak bark at head-height, pointing horizontally into the tree — and a single round red apple is skewered firmly on the shaft of the bolt, impaled clean through its centre. The apple rests hard against the bark, the bolt passing through it like a spit, the fletching of the bolt visible behind the apple. The apple was shot off his head. The boy is unharmed. Cold overcast November morning, soft flat shadows on the stones.

The attached reference photo is the source of truth for the boy's face, hair, build, and clothing.

${ART_STYLE}`,
  },
];

// ──────────────────────────────────────────────────────────────────────────
// Setup
// ──────────────────────────────────────────────────────────────────────────
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(path.join(OUT_DIR, 'characters'), { recursive: true });
fs.mkdirSync(path.join(OUT_DIR, 'landmarks'), { recursive: true });

async function fetchStoryAssets() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  console.log(`Fetching story assets for ${STORY_ID} P${PAGE}...`);

  // Empty scene
  const emp = await pool.query(
    `SELECT image_data FROM story_images WHERE story_id=$1 AND image_type='empty_scene' AND page_number=$2 AND version_index=0`,
    [STORY_ID, PAGE]
  );
  if (emp.rows[0]) {
    const b64 = emp.rows[0].image_data.replace(/^data:image\/\w+;base64,/, '');
    fs.writeFileSync(path.join(OUT_DIR, 'empty_scene.jpg'), Buffer.from(b64, 'base64'));
    console.log('  saved empty_scene.jpg');
  }

  // Original generated P6 for reference
  const sc = await pool.query(
    `SELECT image_data FROM story_images WHERE story_id=$1 AND image_type='scene' AND page_number=$2 AND version_index=0`,
    [STORY_ID, PAGE]
  );
  if (sc.rows[0]) {
    const b64 = sc.rows[0].image_data.replace(/^data:image\/\w+;base64,/, '');
    fs.writeFileSync(path.join(OUT_DIR, 'original_p6_scene.jpg'), Buffer.from(b64, 'base64'));
    console.log('  saved original_p6_scene.jpg');
  }

  // Character data (need Manuel and Lukas for the framings)
  const chars = await pool.query(`SELECT data->'characters' as chars FROM stories WHERE id=$1`, [STORY_ID]);
  const allChars = chars.rows[0].chars || [];
  const charMap = {};
  for (const c of allChars) {
    // Pick the costumed medieval avatar (matching the story's visual style).
    // Fall back to standard if costumed not available.
    const avatars = c.avatars || {};
    const styled = avatars.styledAvatars || {};
    let photoUrl = null;
    let clothingDesc = null;
    // Prefer any costumed:mittelalterlich generated avatar
    const mittelKey = Object.keys(styled).find(k => /mittelalterlich/i.test(k));
    if (mittelKey && styled[mittelKey]?.imageData) {
      photoUrl = styled[mittelKey].imageData;
      clothingDesc = styled[mittelKey].clothingDescription || avatars.clothing?.['costumed:mittelalterlich'] || '';
    } else if (avatars.standard?.imageData) {
      photoUrl = avatars.standard.imageData;
      clothingDesc = avatars.clothing?.standard || '';
    } else if (c.photos?.body) {
      photoUrl = c.photos.body;
    }
    if (photoUrl) {
      const ext = (photoUrl.match(/^data:image\/(\w+)/) || [null, 'jpeg'])[1];
      const b64 = photoUrl.replace(/^data:image\/\w+;base64,/, '');
      const fname = `${c.name}.${ext}`;
      fs.writeFileSync(path.join(OUT_DIR, 'characters', fname), Buffer.from(b64, 'base64'));
      charMap[c.name] = {
        name: c.name,
        photoUrl,
        clothingDescription: clothingDesc,
        description: `${c.name}, age ${c.age || '?'}, ${c.gender || ''}`,
        photoType: 'body',
      };
      console.log(`  saved characters/${fname}`);
    }
  }
  await pool.end();
  return { charMap };
}

async function runFraming(framing, charMap) {
  const { loadPromptTemplates } = require(path.join(ROOT, 'server/services/prompts'));
  await loadPromptTemplates();
  const { generateImageOnly } = require(path.join(ROOT, 'server/lib/images'));

  // Character references for this framing
  const referencePhotos = framing.characters
    .map(name => charMap[name])
    .filter(Boolean);

  // Optional scene background (empty scene)
  const emptyPath = path.join(OUT_DIR, 'empty_scene.jpg');
  let sceneBackground = null;
  if (fs.existsSync(emptyPath)) {
    sceneBackground = `data:image/jpeg;base64,${fs.readFileSync(emptyPath).toString('base64')}`;
  }

  const outPath = path.join(OUT_DIR, `${framing.name}_grok.jpg`);
  const metaPath = path.join(OUT_DIR, `${framing.name}_grok.json`);
  if (fs.existsSync(outPath)) {
    console.log(`  [SKIP] ${framing.name} already has output`);
    return { framing: framing.name, status: 'skipped' };
  }

  console.log(`\n▶ Running ${framing.name}  (${framing.characters.length} chars)`);
  console.log(`  "${framing.description}"`);
  const t0 = Date.now();
  try {
    const result = await generateImageOnly(framing.prompt, referencePhotos, {
      imageBackendOverride: 'grok',
      landmarkPhotos: [],
      visualBibleGrid: null,
      sceneBackground,
      textAreaMask: null,
      pageNumber: PAGE,
      skipCache: true,
      aspectRatio: '3:4',
    });
    const elapsed = Date.now() - t0;
    if (!result?.imageData) {
      console.log(`  ✗ no image returned (${elapsed}ms)`);
      fs.writeFileSync(path.join(OUT_DIR, `${framing.name}_grok.BLOCKED.txt`), 'No image data returned');
      return { framing: framing.name, status: 'no-image', elapsedMs: elapsed };
    }
    const b64 = result.imageData.replace(/^data:image\/\w+;base64,/, '');
    fs.writeFileSync(outPath, Buffer.from(b64, 'base64'));
    fs.writeFileSync(metaPath, JSON.stringify({
      framing: framing.name,
      description: framing.description,
      elapsedMs: elapsed,
      modelId: result.modelId,
      cost: result.usage?.cost,
      characters: framing.characters,
    }, null, 2));
    console.log(`  ✅ saved ${framing.name}_grok.jpg (${(elapsed / 1000).toFixed(1)}s)`);
    return { framing: framing.name, status: 'ok', elapsedMs: elapsed };
  } catch (err) {
    const elapsed = Date.now() - t0;
    const msg = err.message || String(err);
    console.log(`  ✗ FAILED (${elapsed}ms): ${msg.slice(0, 160)}`);
    fs.writeFileSync(path.join(OUT_DIR, `${framing.name}_grok.BLOCKED.txt`), msg);
    return { framing: framing.name, status: 'error', error: msg, elapsedMs: elapsed };
  }
}

function writeReadme() {
  const md = `# Framing Experiment — Tell Apple-Shot Scene

Testing safe-framing strategies for violence-adjacent children's book scenes.
All framings use the real Tell story's empty scene, characters, art style.

Story: \`${STORY_ID}\` page ${PAGE}.

## The 5 framings

${FRAMINGS.map((f, i) => `### ${i + 1}. \`${f.name}\`

${f.description}

**Characters in frame:** ${f.characters.length ? f.characters.join(', ') : '(none)'}
`).join('\n')}

## Files

- \`original_p6_scene.jpg\` — the actual image generated by the production pipeline for P6. Reference.
- \`empty_scene.jpg\` — the empty scene generated for P6. Used as scene background reference.
- \`characters/*.jpeg\` — character avatars used as reference photos (medieval costumed).
- \`<framing>_grok.jpg\` — Grok output for each framing.
- \`<framing>_grok.json\` — generation metadata (timing, cost, model).
- \`<framing>_grok.BLOCKED.txt\` — present only when Grok refused the generation.
`;
  fs.writeFileSync(path.join(OUT_DIR, 'README.md'), md);
}

// ──────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────
(async () => {
  const { charMap } = await fetchStoryAssets();
  writeReadme();

  const results = [];
  for (const framing of FRAMINGS) {
    const result = await runFraming(framing, charMap);
    results.push(result);
  }

  fs.writeFileSync(path.join(OUT_DIR, 'results.json'), JSON.stringify(results, null, 2));
  console.log('\n═══════════════════════════════════════');
  console.log('Summary:');
  for (const r of results) {
    console.log(`  ${r.framing}: ${r.status}`);
  }
  console.log(`\nAll outputs in: ${OUT_DIR}`);
  process.exit(0);
})().catch(e => {
  console.error('ERR:', e.stack || e.message);
  process.exit(1);
});
