#!/usr/bin/env node
/**
 * Framing experiment v2 — proper production-matching references.
 *
 * Improvements over v1:
 *   - Loads costumed avatars from char.avatars.styledAvatars.realistic.costumed.mittelalterlich
 *     (v1 fell back to char.avatars.standard — characters showed up in contemporary clothing).
 *   - Loads the cached VB grid from scene.visualBibleGrid.
 *   - Pre-builds Grok reference slots via packReferences and saves each slot as a
 *     visible JPG so we can see exactly what the model received.
 *   - Drops the D1 framing (Grok can't do "30m apart with two character refs").
 *
 * Output: tests/framing-experiment-v2/
 */
'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const ROOT = path.resolve(__dirname, '..');
const STORY_ID = 'job_1776554957628_pw7g3k0d5';
const PAGE = 6;
const OUT_DIR = path.join(ROOT, 'tests', 'framing-experiment-v2');

const ART_STYLE = `A photorealistic children's book illustration. Real people in real settings. Natural lighting, cinematic composition, shallow depth of field. Characters are real humans — natural proportions, real skin texture with pores, natural hair. NOT illustrated, NOT stylized, NOT animated. Think professional children's photography with storybook staging. Faces: real human faces with visible skin texture, natural eye size, defined features, warm natural lighting. Never cartoonish or stylized. Preserve each character's actual age.`;

const FRAMINGS = [
  {
    name: 'A_before_manuel_ready',
    description: 'BEFORE — Manuel at shoulder-mount with crossbow, gaze follows the barrel, side-profile, bowstring relaxed.',
    characters: ['Manuel'],
    prompt: `Generate a SINGLE illustration filling the ENTIRE canvas edge-to-edge. No borders, no frames, no margins, no white edges. Do NOT add any text, letters, words, labels, signatures, or watermarks.

Medium side-profile shot of a teenage boy in medieval clothing, standing calmly on a cobblestone market square. He holds a medieval wooden crossbow raised and mounted at his SHOULDER like a rifle — the stock pressed firmly against his right shoulder, his right hand gripping the narrow neck of the stock, his left hand steady on the fore-end supporting the bow. The crossbow points forward in the same direction his body faces. His HEAD IS TURNED FORWARD, his GAZE FIXED DOWN THE BARREL IN THE SAME DIRECTION THE CROSSBOW IS POINTING — eyes looking out into the distance at what the crossbow points toward. The bowstring is relaxed (NOT drawn back). A bolt sits seated in the groove. His expression is calm, focused, professional — a hunter or skilled archer readying his weapon, not tense, not aggressive. Cold overcast November morning light, soft grey plaza blurred behind him. He wears a dark grey wool jerkin over a white linen shirt, a heavy leather belt, dark wool trousers, leather boots.

The attached reference photo is the source of truth for his face, hair, build, and clothing. Match them exactly.

${ART_STYLE}`,
  },
  {
    name: 'B_before_lukas_tense_scared',
    description: 'BEFORE — Lukas alone, apple on head, tense and frightened, natural child proportions, medium close-up.',
    characters: ['Lukas'],
    prompt: `Generate a SINGLE illustration filling the ENTIRE canvas edge-to-edge. No borders, no frames, no margins, no white edges. Do NOT add any text, letters, words, labels, signatures, or watermarks.

Medium close-up, waist-up, of a small grade-school medieval boy standing stiffly against a massive oak trunk, a single perfectly round red apple balanced upright on the top of his head. NATURAL GRADE-SCHOOL-CHILD PROPORTIONS — the boy's head is about ONE SIXTH of his full body height, NOT oversized or cartoony. Real child-human anatomy, not stylized. His eyes are OPEN WIDE with fear — pupils small, brow furrowed, lips pressed tightly together, jaw clenched. His whole body is rigid with tension: shoulders drawn up, arms pressed flat at his sides, chin tucked slightly. He is trying not to move a muscle. His expression is frightened but brave. He wears a simple light-brown wool medieval tunic to the knees, narrow leather belt, dark brown wool hose. Cold flat November morning light. Rough dark oak bark fills the background behind him.

The attached reference photo is the source of truth for his face, hair, build, and clothing.

${ART_STYLE}`,
  },
  {
    name: 'C_pov_distant_lukas',
    description: 'POV — tight strip of crossbow at bottom edge only; Lukas very far back with apple on head.',
    characters: ['Lukas'],
    prompt: `Generate a SINGLE illustration filling the ENTIRE canvas edge-to-edge. No borders, no frames, no margins, no white edges. Do NOT add any text, letters, words, labels, signatures, or watermarks.

First-person viewpoint looking along the length of a medieval wooden crossbow. The dark oak stock and taut bowstring occupy only the very LOWER EDGE of the frame — at most the bottom 18% of the image height — in sharp focus as a thin strip across the bottom. The entire rest of the frame is the deep empty perspective of a cobblestone market square stretching into the distance. FAR BACK at the horizon, at the exact centre-back of the frame, a tiny small medieval boy stands against a massive old oak trunk — he is VERY SMALL, roughly 1/12th of the image height, almost at the vanishing point. A single bright red apple balances upright on top of his head, the only clearly visible detail at his distance. He wears a light-brown medieval tunic. Cold overcast November morning, grey cobblestones receding into the middle distance. Shallow depth of field — crossbow sharp, distant boy softly focused.

The attached reference photo is the source of truth for the boy's appearance even at small scale.

${ART_STYLE}`,
  },
  {
    name: 'D2_over_shoulder_distant_kid',
    description: 'Over-the-shoulder Manuel foreground, Lukas tiny in distance (generic medieval kid with red apple). THE WINNER PATTERN.',
    characters: ['Manuel'],
    prompt: `Generate a SINGLE illustration filling the ENTIRE canvas edge-to-edge. No borders, no frames, no margins, no white edges. Do NOT add any text, letters, words, labels, signatures, or watermarks.

Over-the-shoulder view from behind a teenage boy who holds a medieval wooden crossbow raised at chest height. His back, shoulder, short tousled dark hair, and hands on the crossbow stock fill the LEFT FOREGROUND of the frame — large, partly out of focus, sharply lit from the right side. He wears a dark grey wool jerkin. Down the line of the bolt groove, in the very far distance at the centre of the frame, a TINY generic small boy stands against a massive old oak trunk — only a few percent of the image height, no facial features visible, just silhouette: short brown hair, a plain light-brown medieval tunic, arms at his sides. A bright red apple balanced on top of his head is the only clearly visible detail at that distance. Empty cobblestone plaza fills the space between them. Cold overcast November morning. Shallow depth of field — archer's shoulder sharp, distant boy soft and small.

The attached reference photo is the source of truth for the foreground archer's face, hair, build, and clothing. The distant boy should look like a generic medieval child — no close-up detail at that scale.

${ART_STYLE}`,
  },
  {
    name: 'E_aftermath_pierced_apple',
    description: 'AFTERMATH — Lukas facing camera; bolt went forward-to-backward (into tree away from camera), fletching toward viewer, apple impaled on shaft pressed against bark above his head.',
    characters: ['Lukas'],
    prompt: `Generate a SINGLE illustration filling the ENTIRE canvas edge-to-edge. No borders, no frames, no margins, no white edges. Do NOT add any text, letters, words, labels, signatures, or watermarks.

A small medieval boy stands on grey cobblestones facing directly toward the camera, arms relaxed at his sides, shoulders lowered, an expression of quiet dawning relief breaking across his face. He wears a simple light-brown medieval wool tunic to the knees, narrow leather belt, dark brown wool hose. The massive rough dark bark of an old oak trunk fills the frame behind him. DIRECTLY ABOVE his head, a short wooden crossbow bolt has struck the oak from the viewer's side — the bolt points STRAIGHT AWAY from the camera INTO the tree bark (not sideways, not left-to-right). Its dark feathered fletching protrudes OUTWARD toward the viewer, clearly visible. A single round red apple is impaled firmly on the bolt's shaft, pressed flat against the rough oak bark — the shaft passes through the apple's centre, the fletching is between the apple and the viewer. The apple sits directly above Lukas's head level. The shot came from the viewer's direction, past his head, buried itself in the tree. Cold overcast November morning, soft flat shadows on the stones.

The attached reference photo is the source of truth for the boy's face, hair, build, and clothing.

${ART_STYLE}`,
  },
];

// ──────────────────────────────────────────────────────────────────────────
// Setup
// ──────────────────────────────────────────────────────────────────────────
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(path.join(OUT_DIR, 'characters'), { recursive: true });

async function fetchStoryAssets() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  console.log(`Fetching ${STORY_ID} P${PAGE}...`);

  // Empty scene
  const emp = await pool.query(
    `SELECT image_data FROM story_images WHERE story_id=$1 AND image_type='empty_scene' AND page_number=$2 AND version_index=0`,
    [STORY_ID, PAGE]
  );
  let sceneBackground = null;
  if (emp.rows[0]) {
    sceneBackground = emp.rows[0].image_data;
    const b64 = sceneBackground.replace(/^data:image\/\w+;base64,/, '');
    fs.writeFileSync(path.join(OUT_DIR, 'input_empty_scene.jpg'), Buffer.from(b64, 'base64'));
    console.log('  saved input_empty_scene.jpg');
  }

  // Original P6 scene for reference
  const sc = await pool.query(
    `SELECT image_data FROM story_images WHERE story_id=$1 AND image_type='scene' AND page_number=$2 AND version_index=0`,
    [STORY_ID, PAGE]
  );
  if (sc.rows[0]) {
    const b64 = sc.rows[0].image_data.replace(/^data:image\/\w+;base64,/, '');
    fs.writeFileSync(path.join(OUT_DIR, 'production_original_p6.jpg'), Buffer.from(b64, 'base64'));
    console.log('  saved production_original_p6.jpg');
  }

  // Visual Bible grid cached on the scene (what production sent to Grok)
  const sceneData = await pool.query(
    `SELECT scene->>'visualBibleGrid' as vb FROM stories, jsonb_array_elements(data->'sceneImages') scene WHERE stories.id=$1 AND (scene->>'pageNumber')::int=$2`,
    [STORY_ID, PAGE]
  );
  let visualBibleGrid = null;
  if (sceneData.rows[0]?.vb) {
    visualBibleGrid = sceneData.rows[0].vb;
    const b64 = visualBibleGrid.replace(/^data:image\/\w+;base64,/, '');
    fs.writeFileSync(path.join(OUT_DIR, 'input_vb_grid.jpg'), Buffer.from(b64, 'base64'));
    console.log('  saved input_vb_grid.jpg');
  } else {
    console.log('  (no VB grid cached on scene)');
  }

  // Characters — costumed medieval from styledAvatars.realistic.costumed.mittelalterlich
  const chars = await pool.query(`SELECT data->'characters' as chars FROM stories WHERE id=$1`, [STORY_ID]);
  const allChars = chars.rows[0].chars || [];
  const charMap = {};
  for (const c of allChars) {
    const costumedImg = c.avatars?.styledAvatars?.realistic?.costumed?.mittelalterlich;
    const clothingDesc = c.avatars?.clothing?.['costumed:mittelalterlich'];
    if (typeof costumedImg === 'string' && costumedImg.startsWith('data:image')) {
      const ext = (costumedImg.match(/^data:image\/(\w+)/) || [null, 'jpeg'])[1];
      const b64 = costumedImg.replace(/^data:image\/\w+;base64,/, '');
      fs.writeFileSync(path.join(OUT_DIR, 'characters', `${c.name}.${ext}`), Buffer.from(b64, 'base64'));
      charMap[c.name] = {
        name: c.name,
        photoUrl: costumedImg,
        clothingDescription: clothingDesc || '',
        description: `${c.name}, age ${c.age || '?'}, ${c.gender || ''}`,
        photoType: 'costumed:mittelalterlich',
      };
      console.log(`  saved characters/${c.name}.${ext}  (costumed:mittelalterlich)`);
    }
  }
  await pool.end();

  return { sceneBackground, visualBibleGrid, charMap };
}

async function runFraming(framing, assets) {
  const { packReferences, editWithGrok } = require(path.join(ROOT, 'server/lib/grok.js'));

  const frameDir = path.join(OUT_DIR, framing.name);
  if (!fs.existsSync(frameDir)) fs.mkdirSync(frameDir, { recursive: true });

  console.log(`\n▶ ${framing.name}`);
  console.log(`  "${framing.description}"`);

  // Build reference photos array
  const characterPhotos = framing.characters.map(n => assets.charMap[n]).filter(Boolean);

  // Pre-pack slots (same logic production uses)
  const slots = await packReferences({
    characterPhotos,
    sceneBackground: assets.sceneBackground,
    visualBibleGrid: null, // We'll leave VB off since it's now bundled with chars in prod — keeping same here
    landmarkPhotos: [],
  }, {
    aspectRatio: '3:4',
    pageLabel: String(PAGE),
  });

  // Save each slot as a visible JPG
  slots.forEach((slot, i) => {
    const b64 = slot.replace(/^data:image\/\w+;base64,/, '');
    fs.writeFileSync(path.join(frameDir, `slot_${i + 1}.jpg`), Buffer.from(b64, 'base64'));
  });
  console.log(`  saved ${slots.length} slot images → ${framing.name}/slot_*.jpg`);

  // Save the prompt
  fs.writeFileSync(path.join(frameDir, 'prompt.txt'), framing.prompt);

  // Run the edit
  const t0 = Date.now();
  try {
    const result = await editWithGrok(framing.prompt, slots, {
      aspectRatio: '3:4',
    });
    const elapsed = Date.now() - t0;
    if (!result?.imageData) {
      fs.writeFileSync(path.join(frameDir, 'BLOCKED.txt'), 'No image data returned');
      console.log(`  ✗ no image returned (${elapsed}ms)`);
      return { framing: framing.name, status: 'no-image' };
    }
    const b64 = result.imageData.replace(/^data:image\/\w+;base64,/, '');
    fs.writeFileSync(path.join(frameDir, 'output.jpg'), Buffer.from(b64, 'base64'));
    const meta = {
      framing: framing.name,
      description: framing.description,
      elapsedMs: elapsed,
      costUsd: result.usage?.cost ?? null,
      slotsSent: slots.length,
      characters: framing.characters,
    };
    fs.writeFileSync(path.join(frameDir, 'meta.json'), JSON.stringify(meta, null, 2));
    console.log(`  ✅ output.jpg (${(elapsed / 1000).toFixed(1)}s, ${slots.length} slots)`);
    return { framing: framing.name, status: 'ok', elapsedMs: elapsed };
  } catch (err) {
    const elapsed = Date.now() - t0;
    const msg = err.message || String(err);
    fs.writeFileSync(path.join(frameDir, 'BLOCKED.txt'), msg);
    console.log(`  ✗ FAILED (${elapsed}ms): ${msg.slice(0, 140)}`);
    return { framing: framing.name, status: 'error', error: msg };
  }
}

function writeReadme(results) {
  const md = `# Framing Experiment v2 — Tell apple-shot (${STORY_ID} P${PAGE})

Proper production-matching references:
- Costumed medieval avatars (\`styledAvatars.realistic.costumed.mittelalterlich\`)
- Empty scene from story_images (\`input_empty_scene.jpg\`)
- VB grid available but not packed into slots (matches new prod: VB rides with char slots, not scene)

## Files
- \`input_empty_scene.jpg\` — empty scene used as scene background in slot 1
- \`input_vb_grid.jpg\` — the VB grid cached on the scene (for reference)
- \`production_original_p6.jpg\` — the image production actually generated for P6
- \`characters/<name>.jpeg\` — costumed medieval avatars used as reference refs

## Framings (each has its own folder)

${FRAMINGS.map((f, i) => `### ${i + 1}. \`${f.name}\`
${f.description}

**Characters attached as refs:** ${f.characters.length ? f.characters.join(', ') : '(none)'}

Inside \`${f.name}/\`:
- \`slot_1.jpg\`, \`slot_2.jpg\`, … — the exact Grok reference slots
- \`prompt.txt\` — the full prompt sent to Grok
- \`output.jpg\` — what Grok generated
- \`meta.json\` — timing + cost
`).join('\n')}

## Results
${results.map(r => `- ${r.framing}: **${r.status}**${r.elapsedMs ? `  (${(r.elapsedMs / 1000).toFixed(1)}s)` : ''}`).join('\n')}
`;
  fs.writeFileSync(path.join(OUT_DIR, 'README.md'), md);
}

(async () => {
  const assets = await fetchStoryAssets();
  const results = [];
  for (const framing of FRAMINGS) {
    const result = await runFraming(framing, assets);
    results.push(result);
  }
  fs.writeFileSync(path.join(OUT_DIR, 'results.json'), JSON.stringify(results, null, 2));
  writeReadme(results);
  console.log('\n═══════════════════════════════════════');
  results.forEach(r => console.log(`  ${r.framing}: ${r.status}`));
  console.log(`\nAll outputs in: ${OUT_DIR}`);
  process.exit(0);
})().catch(e => {
  console.error('ERR:', e.stack || e.message);
  process.exit(1);
});
