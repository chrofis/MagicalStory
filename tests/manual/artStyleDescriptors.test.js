/**
 * Per-style invariants for ART_STYLES (server/lib/promptBuilders.js).
 *
 * These descriptors ride in EVERY page and cover prompt, and they are the thing
 * that decides painted-vs-photographic. They have been rewritten wholesale at
 * least once (2026-08-17, "compressed and evened out"). That rewrite claimed
 * "every embedded rule was preserved verbatim in meaning (asserted by a
 * per-style regex check)" — but the check was ad hoc and never committed, its
 * watercolour assertion covered only `fully opaque`, and its re-validation
 * covered only oil and concept.
 *
 * Consequence: watercolour silently lost "never a photo with a filter", "no
 * sharp photoreal rendering" and "paint-dominant", and went from 7/7 stored
 * books scoring styleMatch=`matches` to 2/2 scoring `wrong_medium`
 * (job_1787252581387_6sn8z0nh2 and job_1787250416967_9owpz1j3b, both 2026-08-20).
 *
 * This file is that check, made permanent. If you are rewriting a descriptor and
 * a line here fails, the rule you dropped is one a real story regressed on —
 * carry the meaning across rather than deleting the assertion.
 *
 * Run: node tests/manual/artStyleDescriptors.test.js
 */

'use strict';

const assert = require('assert');
const { ART_STYLES } = require('../../server/lib/promptBuilders');

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ✓ ${msg}`); passed++; };
const has = (style, re, label) => ok(re.test(ART_STYLES[style]), `${style}: ${label}`);

const PAINTERLY = ['watercolor', 'oil', 'concept'];   // the NOT_A_PHOTOGRAPH users
const NEVER_PHOTO = ['pixar', 'cartoon', 'lowpoly', 'pixel', 'cyber', 'anime', 'chibi', 'comic', 'manga', 'steampunk'];

console.log('\nevery style exists and names its medium first');
{
  const expected = ['pixar', 'cartoon', 'anime', 'chibi', 'comic', 'manga', 'watercolor', 'oil',
                    'lowpoly', 'concept', 'pixel', 'cyber', 'steampunk', 'realistic'];
  for (const s of expected) ok(typeof ART_STYLES[s] === 'string' && ART_STYLES[s].length > 100, `${s} present`);
}

console.log('\npainterly styles carry the full anti-photograph guard');
for (const s of PAINTERLY) {
  has(s, /never captured by a camera/i, 'camera denial');
  has(s, /no skin pores/i, 'no skin pores');
  // The clause that the camera-fingerprint list cannot cover: an evenly-lit
  // photo has no bokeh/flare/grain and passes every other item.
  has(s, /painterly filter is still a photograph/i, 'hybrid loophole closed');
  has(s, /no sharp photoreal rendering/i, 'photoreal rendering denied');
  has(s, /visible brushwork on every surface, faces included/i, 'brushwork covers faces');
}

console.log('\nnon-painterly illustrated styles still deny photography');
for (const s of NEVER_PHOTO) {
  has(s, /never photographic|never photograph/i, 'denies photography');
}

console.log('\nstyle-specific rules that a rewrite must not drop');
{
  has('watercolor', /fully opaque/i, 'characters fully opaque (the 2026-08-17 assertion)');
  // The intensity words. Measured load-bearing: their removal flipped
  // watercolour from 7/7 matches to 2/2 wrong_medium.
  has('watercolor', /expressive/i, 'INTENSITY: expressive');
  has('watercolor', /prominent/i, 'INTENSITY: prominent brushstrokes');
  has('watercolor', /strong wet-on-wet/i, 'INTENSITY: strong wet-on-wet');
  has('watercolor', /throughout/i, 'INTENSITY: paper texture throughout');
  has('watercolor', /paint-dominant/i, 'INTENSITY: paint-dominant');

  has('oil', /alla prima/i, 'oil alla prima');
  has('concept', /STAGED/, 'concept STAGED light');
  has('pixar', /no pores/i, 'pixar no pores');
  has('cartoon', /never 3D-looking/i, 'cartoon never 3D');
  has('anime', /3[05]-40%|large expressive eyes|eyes/i, 'anime eye rule');
  has('chibi', /blush/i, 'chibi blush marks');
  has('steampunk', /never on people|never worn by people|mechanisms/i, 'steampunk mechanisms not on people');
  has('comic', /halftone/i, 'comic halftone rule');
  has('manga', /screentone/i, 'manga screentones');
  has('lowpoly', /isometric/i, 'lowpoly isometric');
  has('pixel', /anti-aliasing/i, 'pixel no anti-aliasing');
  has('cyber', /never add rain|never switch day to night/i, 'cyber keeps the story weather');
  has('realistic', /subsurface/i, 'realistic subsurface scattering');
}

console.log('\nrealistic is the one style that IS a camera');
{
  ok(/A photograph/i.test(ART_STYLES.realistic), 'realistic leads with "A photograph"');
  ok(!/painterly filter is still a photograph/i.test(ART_STYLES.realistic),
     'realistic does NOT carry the anti-photo guard');
}

console.log('\nlength stays in the band the compression established');
{
  const lens = Object.entries(ART_STYLES).map(([k, v]) => [k, v.length]);
  const max = Math.max(...lens.map(l => l[1]));
  const longest = lens.find(l => l[1] === max);
  ok(max < 1000, `longest descriptor ${longest[0]} = ${max} chars, under the 1000 ceiling`);
  for (const [k, n] of lens) ok(n > 250, `${k} is not a stub (${n} chars)`);
}

console.log(`\n✅ ALL ${passed} assertions passed (art-style descriptor invariants)\n`);
