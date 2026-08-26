#!/usr/bin/env node
/**
 * Single-framing re-test: fix D2 so the crossbow's aim line ends at the
 * distant boy's apple. Output to tests/framing-experiment-v2/D2b_aimed/
 * without touching any of the existing v2 runs.
 */
'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const ROOT = path.resolve(__dirname, '..');
const STORY_ID = 'job_1776554957628_pw7g3k0d5';
const PAGE = 6;
const OUT_DIR = path.join(ROOT, 'tests', 'framing-experiment-v2', 'D2b_aimed');
fs.mkdirSync(OUT_DIR, { recursive: true });

const ART_STYLE = `A photorealistic children's book illustration. Real people in real settings. Natural lighting, cinematic composition, shallow depth of field. Characters are real humans — natural proportions, real skin texture with pores, natural hair. NOT illustrated, NOT stylized, NOT animated. Think professional children's photography with storybook staging. Faces: real human faces with visible skin texture, natural eye size, defined features, warm natural lighting. Never cartoonish or stylized. Preserve each character's actual age.`;

const PROMPT = `Generate a SINGLE illustration filling the ENTIRE canvas edge-to-edge. No borders, no frames, no margins, no white edges. Do NOT add any text, letters, words, labels, signatures, or watermarks.

Over-the-shoulder view from directly behind a teenage boy who holds a medieval wooden crossbow raised in a FIRING POSITION — stock pressed against his right shoulder, body oriented forward, both hands on the weapon. The crossbow's BOLT GROOVE IS PERFECTLY HORIZONTAL, parallel to the ground, with the bolt itself pointing STRAIGHT FORWARD along a horizontal line that ends exactly at the distant target. His back, right shoulder, short tousled dark hair, and his hands on the crossbow fill the LEFT FOREGROUND of the frame — large, partly out of focus, sharply lit from the right side. He wears a dark grey wool jerkin.

The crossbow's horizontal aim line goes from his shoulder directly across the empty cobblestone plaza to the EXACT CENTRE-BACK of the frame, where a TINY generic small boy stands against a massive old oak trunk. The bolt is pointed EXACTLY at the bright red apple balanced on top of the distant boy's head — aim line and apple sit on the same horizontal level, the target at the end of the line of fire. The distant boy is only a few percent of the image height, no facial features visible at that scale, just silhouette: short brown hair, a plain light-brown medieval tunic, arms at his sides. The apple is the single clearly visible detail on him at that distance.

Empty cobblestone plaza fills the space between archer and target. Cold overcast November morning. Shallow depth of field — archer's shoulder sharp, distant boy soft and small. The SAME horizontal line runs from the archer's crossbow straight to the apple — target locked in.

The attached reference photo is the source of truth for the foreground archer's face, hair, build, and clothing. The distant boy should look like a generic medieval child — no close-up detail at that scale.

${ART_STYLE}`;

(async () => {
  const { packReferences, editWithGrok } = require(path.join(ROOT, 'server/lib/grok.js'));
  const pool = new Pool({
    connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  // Empty scene
  const emp = await pool.query(
    `SELECT image_data FROM story_images WHERE story_id=$1 AND image_type='empty_scene' AND page_number=$2 AND version_index=0`,
    [STORY_ID, PAGE]
  );
  const sceneBackground = emp.rows[0]?.image_data;

  // Manuel's costumed avatar
  const chars = await pool.query(`SELECT data->'characters' as chars FROM stories WHERE id=$1`, [STORY_ID]);
  const manuel = (chars.rows[0].chars || []).find(c => c.name === 'Manuel');
  const photoUrl = manuel?.avatars?.styledAvatars?.realistic?.costumed?.mittelalterlich;
  const clothingDescription = manuel?.avatars?.clothing?.['costumed:mittelalterlich'];
  await pool.end();

  // Pack slots
  const slots = await packReferences({
    characterPhotos: [{ name: 'Manuel', photoUrl, clothingDescription, photoType: 'costumed:mittelalterlich' }],
    sceneBackground,
    visualBibleGrid: null,
    landmarkPhotos: [],
  }, { aspectRatio: '3:4', pageLabel: String(PAGE) });

  // Save slots
  slots.forEach((slot, i) => {
    const b64 = slot.replace(/^data:image\/\w+;base64,/, '');
    fs.writeFileSync(path.join(OUT_DIR, `slot_${i + 1}.jpg`), Buffer.from(b64, 'base64'));
  });
  fs.writeFileSync(path.join(OUT_DIR, 'prompt.txt'), PROMPT);
  console.log(`Saved ${slots.length} slot images + prompt.txt`);

  // Run Grok
  console.log('Calling Grok...');
  const t0 = Date.now();
  try {
    const result = await editWithGrok(PROMPT, slots, { aspectRatio: '3:4' });
    const elapsed = Date.now() - t0;
    if (!result?.imageData) {
      fs.writeFileSync(path.join(OUT_DIR, 'BLOCKED.txt'), 'No image data returned');
      console.log(`✗ no image (${elapsed}ms)`);
      process.exit(1);
    }
    const b64 = result.imageData.replace(/^data:image\/\w+;base64,/, '');
    fs.writeFileSync(path.join(OUT_DIR, 'output.jpg'), Buffer.from(b64, 'base64'));
    fs.writeFileSync(path.join(OUT_DIR, 'meta.json'), JSON.stringify({
      elapsedMs: elapsed,
      costUsd: result.usage?.cost ?? null,
      slotsSent: slots.length,
      fix: 'explicit horizontal aim line from crossbow to apple on distant boy',
    }, null, 2));
    console.log(`✅ ${path.basename(OUT_DIR)}/output.jpg (${(elapsed / 1000).toFixed(1)}s)`);
  } catch (err) {
    fs.writeFileSync(path.join(OUT_DIR, 'BLOCKED.txt'), err.message);
    console.log(`✗ FAILED: ${err.message}`);
  }
  process.exit(0);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
