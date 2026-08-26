/**
 * Run box-prompted MobileSAM (/figure-mask, the production char-repair path)
 * on every detected figure of one story page. Produces:
 *   - per-figure strips (original | SAM mask overlay)  → samfig-<name>.jpg
 *   - one combined image, every figure a distinct colour → samfig-ALL.jpg
 * Reads the same bodyBox the repair pipeline prompts SAM with.
 */
require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const STORY_ID = process.argv[2] || 'job_1783796749951_iqyo16j15';
const PAGE = Number(process.argv[3] || 3);
const OUT = 'C:/Users/roger/AppData/Local/Temp/claude/C--Users-roger-MagicalStory/f5744f7b-c499-46ca-85f3-52fc37a98884/scratchpad';
const PHOTO = 'http://127.0.0.1:5000';
const COLORS = [[235,64,52],[52,168,83],[66,133,244],[244,180,0],[171,71,188],[0,172,193]];

async function figureMask(pageBuf, boxPx) {
  const res = await fetch(`${PHOTO}/figure-mask`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: `data:image/jpeg;base64,${pageBuf.toString('base64')}`, box: boxPx, color: [255,255,255], alpha: 255 }),
    signal: AbortSignal.timeout(60_000),
  });
  const j = await res.json();
  if (!j.success) return null;
  const m = j.image.match(/^data:image\/\w+;base64,(.+)$/);
  return { png: Buffer.from(m[1], 'base64'), fill: j.fill_pixels };
}

(async () => {
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const figsQ = await pool.query(
    "SELECT fig->'bboxDetection'->'figures' as figures FROM stories, jsonb_array_elements(data->'sceneImages') fig WHERE id=$1 AND (fig->>'pageNumber')=$2",
    [STORY_ID, String(PAGE)]);
  const figures = figsQ.rows[0]?.figures || [];
  const imgQ = await pool.query(
    "SELECT image_url FROM story_images WHERE story_id=$1 AND page_number=$2 AND image_type='scene' ORDER BY version_index DESC LIMIT 1",
    [STORY_ID, PAGE]);
  await pool.end();

  const pageBuf = Buffer.from(await (await fetch(imgQ.rows[0].image_url)).arrayBuffer());
  const meta = await sharp(pageBuf).metadata();
  const W = meta.width, H = meta.height;
  console.log(`page ${PAGE}: ${W}x${H}, ${figures.length} figures`);

  const strips = [];
  const comboRGBA = Buffer.alloc(W * H * 4); // accumulate coloured masks
  let ci = 0;
  const summary = [];
  for (const fg of figures) {
    const [ymin, xmin, ymax, xmax] = fg.bodyBox;
    const boxPx = [Math.round(xmin*W), Math.round(ymin*H), Math.round(xmax*W), Math.round(ymax*H)];
    const t0 = Date.now();
    const r = await figureMask(pageBuf, boxPx);
    const dt = ((Date.now()-t0)/1000).toFixed(1);
    if (!r) { console.log(`  ${fg.name}: NO MASK`); summary.push({ name: fg.name, pct: 'none' }); continue; }
    const pct = (r.fill / (W*H) * 100).toFixed(1);
    console.log(`  ${fg.name}: ${pct}% of page, ${r.fill}px, ${dt}s`);
    summary.push({ name: fg.name, pct });

    const maskRaw = await sharp(r.png).resize(W, H, { fit: 'fill' }).greyscale().raw().toBuffer();
    const color = COLORS[ci % COLORS.length]; ci++;
    // per-figure overlay
    const overRGBA = Buffer.alloc(W*H*4);
    for (let i = 0; i < W*H; i++) if (maskRaw[i] > 128) { overRGBA[i*4]=color[0]; overRGBA[i*4+1]=color[1]; overRGBA[i*4+2]=color[2]; overRGBA[i*4+3]=120; }
    const over = await sharp(pageBuf).composite([{ input: overRGBA, raw: { width: W, height: H, channels: 4 } }]).jpeg({ quality: 88 }).toBuffer();
    const h = Math.min(H, 520), w = Math.round(W*(h/H));
    const parts = await Promise.all([pageBuf, over].map(b => sharp(b).resize(w, h).toBuffer()));
    const strip = await sharp({ create: { width: w*2+10, height: h, channels: 3, background: 'white' } })
      .composite(parts.map((p,k)=>({ input: p, left: k*(w+10), top: 0 }))).jpeg({ quality: 88 }).toBuffer();
    const safe = fg.name.replace(/[^a-z0-9]/gi,'');
    fs.writeFileSync(path.join(OUT, `samfig-${safe}.jpg`), strip);
    // add to combo (later figure wins on overlap → foreground drawn last if ordered so; here just OR)
    for (let i = 0; i < W*H; i++) if (maskRaw[i] > 128) { comboRGBA[i*4]=color[0]; comboRGBA[i*4+1]=color[1]; comboRGBA[i*4+2]=color[2]; comboRGBA[i*4+3]=130; }
  }
  const combo = await sharp(pageBuf).composite([{ input: comboRGBA, raw: { width: W, height: H, channels: 4 } }]).jpeg({ quality: 90 }).toBuffer();
  fs.writeFileSync(path.join(OUT, 'samfig-ALL.jpg'), combo);
  fs.writeFileSync(path.join(OUT, 'samfig-page.jpg'), pageBuf);
  console.log('\nlegend:');
  summary.forEach((s,i) => console.log(`  ${COLORS[i%COLORS.length].join(',')} = ${s.name} (${s.pct}%)`));
  console.log('saved samfig-ALL.jpg + per-figure strips to scratchpad');
})().catch(e => { console.error('FAIL:', e); process.exit(1); });
