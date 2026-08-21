#!/usr/bin/env node
/**
 * Can ArcFace tell WHICH face on a finished page is wrong?
 *
 * This is a different question from the avatar gate. On an avatar sheet there
 * is one face and one reference, so a single cosine answers it. On a story page
 * there are several figures, so the useful output is a MATRIX: every detected
 * face against every character reference. Two things fall out of it:
 *
 *   - attribution: each face's best-matching character
 *   - a wrong-face signal: a face whose BEST match is still low matches nobody
 *
 * The open risk this script exists to measure: page art is STYLISED (watercolor,
 * pixar, comic), while the reference avatars are photorealistic renders. ArcFace
 * is style-invariant in principle, but cross-domain photo->illustration is much
 * harder than the photo->photorealistic-render comparison the avatar gate does.
 * If the matrix has no contrast, ArcFace is the wrong tool for this job and we
 * should say so rather than ship a confident-looking number.
 *
 *   node scripts/analysis/audit-page-face-identity.js [--story=<id>] [--pages=4]
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { ch } = require('../lib/chTime');

const PY = process.env.PHOTO_ANALYZER_URL || 'http://127.0.0.1:5000';
const args = process.argv.slice(2);
const arg = (n, d) => { const h = args.find(a => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const STORY = arg('story', null);
const MAX_PAGES = parseInt(arg('pages', '4'), 10);
const OUT = path.join(__dirname, 'test-output', 'page-face-identity.html');
const CROPS = path.join(__dirname, 'test-output', 'page-face-crops');

async function py(endpoint, body) {
  const res = await fetch(`${PY}${endpoint}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${endpoint} ${res.status}: ${j?.error || ''}`);
  return j;
}
const toB64 = async (url) => Buffer.from(await (await fetch(url)).arrayBuffer()).toString('base64');
const cos = (a, b) => { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return d / (Math.sqrt(x) * Math.sqrt(y) || 1); };

/** Embed with detect+align — the same contract the avatar audit settled on. */
async function embed(imgDataUri) {
  const r = await py('/face-embedding', { image: imgDataUri, extract_face: true });
  if (!Array.isArray(r.embedding) || r.faceDetected === false) return null;
  return r.embedding;
}

(async () => {
  try {
    const h = await fetch(`${PY}/health`, { signal: AbortSignal.timeout(5000) });
    if (!h.ok) throw new Error('bad health');
  } catch { console.error(`\nPython service not reachable at ${PY} — run: npm run dev:python\n`); process.exit(1); }

  fs.mkdirSync(CROPS, { recursive: true });
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

  // A story that actually has several named characters — attribution is
  // meaningless with a single cast member.
  const storyRow = STORY
    ? (await pool.query('SELECT id, user_id, data FROM stories WHERE id = $1', [STORY])).rows[0]
    : (await pool.query(`SELECT s.id, s.user_id, s.data FROM stories s
         WHERE s.data ? 'sceneImages'
           AND jsonb_array_length(COALESCE(s.data->'characters','[]'::jsonb)) > 1
         ORDER BY s.created_at DESC LIMIT 1`)).rows[0];
  if (!storyRow) { console.error('No suitable story found.'); process.exit(1); }

  console.log(`Story: ${storyRow.id}`);

  // ── References: one embedding per character, from the avatar head cell ────
  const chars = await pool.query(`SELECT data FROM characters WHERE user_id = $1`, [storyRow.user_id]);
  const refs = [];
  for (const row of chars.rows) {
    for (const c of row.data.characters || []) {
      const sheet = c.avatars?.standardUrl || c.avatars?.summerUrl || c.avatars?.winterUrl;
      const photo = c.photos?.face || c.photos?.original;
      if (!sheet && !photo) continue;
      let emb = null, from = null;
      if (sheet) {
        const fc = await py('/extract-face', { image: await toB64(sheet), quadrant: 'top-left', size: 256 });
        if (fc.faceDetected && fc.face) { emb = await embed(fc.face); from = 'avatar'; }
      }
      if (!emb && photo) { emb = await embed(`data:image/jpeg;base64,${await toB64(photo)}`); from = 'photo'; }
      if (emb) refs.push({ name: c.name, emb, from });
    }
  }
  if (!refs.length) { console.error('No character references could be embedded.'); process.exit(1); }
  console.log(`References: ${refs.map(r => `${r.name}(${r.from})`).join(', ')}\n`);

  // ── Pages: detect every face, embed it, score against every reference ─────
  const pages = await pool.query(
    `SELECT DISTINCT ON (page_number) page_number, image_url
       FROM story_images
      WHERE story_id = $1 AND image_type = 'scene' AND image_url IS NOT NULL
      ORDER BY page_number, version_index DESC
      LIMIT $2`, [storyRow.id, MAX_PAGES]);

  const results = [];
  for (const pg of pages.rows) {
    const b64 = await toB64(pg.image_url);
    let faces = [];
    try {
      const det = await py('/detect-illustration-faces', { image: b64, pad_percent: 60 });
      faces = det.faces || [];
    } catch (e) { console.log(`p${pg.page_number}: detect failed — ${e.message.slice(0, 60)}`); continue; }

    const rows = [];
    for (const [i, f] of faces.entries()) {
      if (!f.cropData) continue;
      const file = path.join(CROPS, `p${pg.page_number}-face${i}.jpg`);
      fs.writeFileSync(file, Buffer.from(f.cropData.split(',')[1], 'base64'));
      const emb = await embed(f.cropData);
      if (!emb) { rows.push({ i, crop: file, scores: null, note: 'no embeddable face' }); continue; }
      const scores = refs.map(r => ({ name: r.name, sim: cos(emb, r.emb) })).sort((a, b) => b.sim - a.sim);
      rows.push({ i, crop: file, scores, conf: f.confidence });
    }
    results.push({ page: pg.page_number, url: pg.image_url, faces: rows });

    console.log(`p${pg.page_number}: ${faces.length} face(s) detected`);
    rows.forEach(r => {
      if (!r.scores) { console.log(`   face${r.i}: ${r.note}`); return; }
      const top = r.scores[0], second = r.scores[1];
      console.log(`   face${r.i}: best=${top.name} ${top.sim.toFixed(3)}` +
        (second ? `  | 2nd=${second.name} ${second.sim.toFixed(3)}  | margin ${(top.sim - second.sim).toFixed(3)}` : ''));
    });
  }
  await pool.end();

  // ── Verdict material: is the matrix actually discriminative? ──────────────
  const allTop = results.flatMap(p => p.faces.filter(f => f.scores).map(f => f.scores[0].sim));
  const margins = results.flatMap(p => p.faces.filter(f => f.scores && f.scores.length > 1)
    .map(f => f.scores[0].sim - f.scores[1].sim));
  console.log(`\n${'─'.repeat(70)}`);
  console.log(`Faces embedded: ${allTop.length}`);
  if (allTop.length) {
    const med = [...allTop].sort((a, b) => a - b)[Math.floor(allTop.length / 2)];
    console.log(`Best-match similarity: median ${med.toFixed(3)}  max ${Math.max(...allTop).toFixed(3)}`);
  }
  if (margins.length) {
    const mm = [...margins].sort((a, b) => a - b)[Math.floor(margins.length / 2)];
    console.log(`Margin over runner-up: median ${mm.toFixed(3)}  max ${Math.max(...margins).toFixed(3)}`);
    console.log(mm < 0.05
      ? 'MARGIN TOO SMALL — attribution is a coin flip; ArcFace cannot tell these characters apart on stylised art.'
      : 'Margin is usable — the top match stands clear of the runner-up.');
  }
  console.log('─'.repeat(70));

  const cards = results.map(p => `
   <h2>Page ${p.page}</h2>
   <div class="row"><img class="page" src="${p.url}">
    <div class="faces">${p.faces.map(f => `
      <div class="face">
        <img src="${path.relative(path.dirname(OUT), f.crop).replace(/\\/g, '/')}">
        <div>${!f.scores ? '<i>no embeddable face</i>'
          : f.scores.map((s, i) => `<div class="${i === 0 ? 'top' : ''}">${s.name}: ${s.sim.toFixed(3)}</div>`).join('')}</div>
      </div>`).join('')}</div></div>`).join('');

  fs.writeFileSync(OUT, `<!doctype html><meta charset="utf-8"><title>Page face identity</title>
<style>body{font:14px/1.6 system-ui;margin:26px;background:#fafafa;color:#1f2937}
 h1{font-size:21px}h2{font-size:16px;margin:24px 0 8px}
 .row{display:flex;gap:16px;align-items:flex-start}
 .page{width:340px;border-radius:8px}
 .faces{display:flex;gap:12px;flex-wrap:wrap}
 .face{width:130px;font-size:11px;background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:8px}
 .face img{width:100%;border-radius:6px;margin-bottom:6px}
 .top{font-weight:700;color:#3730a3}
 .legend{background:#fff;border-left:3px solid #6366f1;padding:12px 16px;margin-bottom:18px;font-size:13px}</style>
<h1>Which face is whose — ArcFace on finished pages</h1>
<div class="legend">Every detected face scored against every character reference (avatar head cell,
 photo as fallback). Bold = best match. What matters is not the top score but the <b>margin</b> over the
 runner-up: a small margin means attribution is guesswork. Page art is stylised while references are
 photorealistic, so this is a cross-domain comparison and much harder than the avatar check.
 ${ch(new Date())} · story ${storyRow.id}</div>
${cards}`);
  console.log(`\nReport: ${OUT}\n`);
})();
