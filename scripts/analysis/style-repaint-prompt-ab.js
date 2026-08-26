#!/usr/bin/env node
/**
 * A/B the style-repair WORDING on real pages, without a deploy.
 *
 * Context (2026-08-23): the production prompt tells the model "the background
 * is already correct, the CHARACTERS are too realistic — repaint the people".
 * It never says HOW FAR to push. Measured on job_1787493968756_4fgr5nukroz,
 * Grok changed the image by only ~8-9/255 on 3 of 4 pages — it read the page as
 * already in-style and effectively no-op'd (which docs/image-routing.md already
 * recorded on 2026-08-09). Gemini does repaint but fogs the whole image.
 *
 * This runs the CURRENT prompt and an INTENSITY-FIRST prompt side by side on
 * the same pages and reports the mean pixel delta for each, so "did it actually
 * do anything" is a number rather than an impression.
 *
 * Costs real money (one image edit per page per variant). Default 4 pages x 1
 * variant = 4 Grok calls.
 *
 *   node scripts/analysis/style-repaint-prompt-ab.js [--model=grok] [--pages=7,8,9,10]
 */
'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const args = process.argv.slice(2);
const arg = (n, d) => { const h = args.find(a => a.startsWith(`--${n}=`)); return h ? h.split('=')[1] : d; };
const MODEL = arg('model', 'grok');
const PAGES = arg('pages', '7,8,9,10').split(',').map(Number);
const STORY = arg('story', 'job_1787493968756_4fgr5nukroz');
const OUT = path.join(__dirname, 'test-output', 'style-prompt-ab');

// The owner's framing: the page is ALREADY the right medium, it is just far too
// weak. Says how far to push, and still story-agnostic (repo rule: no names,
// characters, settings or plot).
const INTENSITY_PROMPT = (styleDesc) =>
`This illustration is already in the right medium, but the effect is far too weak — it still reads as a photograph with a light filter over it. Push it much further into a genuine ${styleDesc}: visible pigment washes, wet-on-wet blooms where colours meet, granulation settling into the paper grain, soft bleeding edges instead of crisp photographic ones, and bare paper showing through in the lightest areas. The PEOPLE above all must look painted rather than photographed — skin, hair and faces rendered in washes and brushstrokes, not photographic gradients.
Change ONLY how it is rendered, never what is shown. Every person keeps identical facial features, eyes exactly as shown, identical expression, identical eyewear or lack of eyewear, identical hair and clothing. Add nothing and remove nothing. Keep the background, composition and framing unchanged; add no white paper border.`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const { loadPromptTemplates } = require('../../server/services/prompts');
  await loadPromptTemplates();
  const { repairPageStyle } = require('../../server/lib/styleRepair');
  const { resolveArtStyle } = require('../../server/lib/storyHelpers');
  const sharp = require('sharp');

  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const story = (await pool.query('SELECT data FROM stories WHERE id = $1', [STORY])).rows[0];
  const artStyle = story?.data?.artStyle || null;
  const styleDesc = (artStyle && resolveArtStyle(artStyle, MODEL)) || 'the art style of the rest of the illustration';
  console.log(`story ${STORY} | artStyle=${artStyle} | model=${MODEL}`);
  console.log(`styleDesc: ${String(styleDesc).slice(0, 110)}…\n`);

  const imgs = await pool.query(
    `SELECT page_number, image_url FROM story_images
      WHERE story_id = $1 AND image_type = 'scene' AND version_index = 0 AND page_number = ANY($2::int[])
      ORDER BY page_number`, [STORY, PAGES]);
  await pool.end();

  const raw = async (buf) => (await sharp(buf).resize(512, 512, { fit: 'fill' }).removeAlpha().raw().toBuffer());
  const meanDelta = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };

  const rows = [];
  for (const r of imgs.rows) {
    const origBuf = Buffer.from(await (await fetch(r.image_url)).arrayBuffer());
    fs.writeFileSync(path.join(OUT, `p${r.page_number}-original.jpg`), origBuf);
    const origRaw = await raw(origBuf);
    const dataUri = `data:image/jpeg;base64,${origBuf.toString('base64')}`;

    const rep = await repairPageStyle(dataUri, null, {
      model: MODEL, artStyle, promptOverride: INTENSITY_PROMPT(styleDesc),
    });
    const outBuf = Buffer.from(String(rep.imageData).split(',')[1], 'base64');
    fs.writeFileSync(path.join(OUT, `p${r.page_number}-intensity.jpg`), outBuf);
    const delta = meanDelta(origRaw, await raw(outBuf));
    console.log(`p${r.page_number}: delta ${delta.toFixed(1)}/255  gate=${rep.passedGate}  (${(outBuf.length / 1024).toFixed(0)}KB)`);
    rows.push({ page: r.page_number, delta });
  }

  console.log('\nReference from the earlier run (same pages, same model):');
  console.log('  current prompt -> p7 8.0, p8 9.4, p9 29.5, p10 9.4   (<=10 = effectively unchanged)');
  console.log(`Output: ${OUT}`);
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
