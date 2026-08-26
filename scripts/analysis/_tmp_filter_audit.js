// Filter audit (owner, 2026-08-23): across recent DINO-detected stories, crop
// EVERY figure that the two proposed junk filters would cut:
//   A) DINO score < 0.45
//   B) faceless AND box area < 0.8% of the frame
// Group by named-vs-unknown so the owner can see whether any REAL character
// would be kicked out. No paid calls — DB reads + image crops only.
require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const sharp = require('sharp');

const OUT = 'C:/Users/roger/AppData/Local/Temp/claude/C--Users-roger-MagicalStory/53ca16ce-9e51-4b2f-a36b-c324ee59638f/scratchpad/filter-audit';
const BASE = 'https://magicalstory.ch';
const STORIES = [
  'job_1787262655143_s9zb960muni',
  'job_1787349305313_hpv76p0rokg',
  'job_1787423677246_r9llf5yi9',
];

async function login() {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'demo-b-hnecf@magicalstory.ch', password: 'DemoStory2026!' }) });
  return (await r.json()).token;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const token = await login();
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

  const cuts = []; // {story,page,idx,name,score,area,hasFace,file,reasons}
  let totalFigures = 0, dinoPages = 0;

  for (const sid of STORIES) {
    const q = await pool.query(`select data->'sceneImages' as si, data->'coverImages' as ci from stories where id=$1`, [sid]);
    if (!q.rows.length) continue;
    const pages = [];
    for (const s of (q.rows[0].si || [])) pages.push({ page: s.pageNumber, det: s.bboxDetection });
    const coverPage = { frontCover: -1, initialPage: -2, backCover: -3 };
    for (const [k, c] of Object.entries(q.rows[0].ci || {})) pages.push({ page: coverPage[k], det: c.bboxDetection });

    for (const { page, det } of pages) {
      if (!det || !/dino/.test(det.detectionBackend || '')) continue;
      const figs = det.figures || [];
      if (!figs.length) continue;
      dinoPages++;
      // candidates on this page?
      const cand = figs.map((f, i) => {
        const b = f.bodyBox; if (!Array.isArray(b) || b.length !== 4) return null;
        const area = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
        const score = Number(f.score ?? f.faceScore ?? NaN);
        const hasFace = !!(f.faceBox && f.faceBox.length === 4);
        const reasons = [];
        if (Number.isFinite(score) && score < 0.45) reasons.push('score<0.45');
        if (!hasFace && area < 0.008) reasons.push('faceless<0.8%');
        return reasons.length ? { i, f, b, area, score, hasFace, reasons } : null;
      }).filter(Boolean);
      totalFigures += figs.length;
      if (!cand.length) continue;

      // fetch the active page image once
      let buf = null;
      try {
        const url = `${BASE}/api/admin/testlab/baseline-image/${sid}/${page}`;
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        if (res.ok) {
          const jj = await res.json();
          if (/^https?:/.test(String(jj.imageData))) buf = Buffer.from(await (await fetch(jj.imageData)).arrayBuffer());
          else buf = Buffer.from(String(jj.imageData).replace(/^data:image\/\w+;base64,/, ''), 'base64');
        } else if (page < 0) {
          const ct = { '-1': 'frontCover', '-2': 'initialPage', '-3': 'backCover' }[String(page)];
          const res2 = await fetch(`${BASE}/api/admin/testlab/baseline-cover/${sid}/${ct}`, { headers: { Authorization: `Bearer ${token}` } });
          if (res2.ok) {
            const jj = await res2.json();
            if (/^https?:/.test(String(jj.imageData))) buf = Buffer.from(await (await fetch(jj.imageData)).arrayBuffer());
            else buf = Buffer.from(String(jj.imageData).replace(/^data:image\/\w+;base64,/, ''), 'base64');
          }
        }
      } catch (e) { /* skip page */ }
      if (!buf) { console.log(sid.slice(-10), 'p' + page, 'image unavailable — skipped', cand.length, 'candidates'); continue; }
      const meta = await sharp(buf).metadata();
      const W = meta.width, H = meta.height;

      for (const c of cand) {
        const x = Math.max(0, Math.round(c.b[1] * W) - 6), y = Math.max(0, Math.round(c.b[0] * H) - 6);
        const w = Math.min(W - x, Math.round((c.b[3] - c.b[1]) * W) + 12), h = Math.min(H - y, Math.round((c.b[2] - c.b[0]) * H) + 12);
        if (w < 4 || h < 4) continue;
        const fname = `cut-${sid.slice(-8)}-p${page}-f${c.i}-${(c.f.name || 'UNK').replace(/[^a-z0-9]/gi, '_')}.png`;
        try {
          await sharp(buf).extract({ left: x, top: y, width: w, height: h }).resize({ height: Math.min(260, h * 3) }).png().toFile(`${OUT}/${fname}`);
        } catch (e) { continue; }
        cuts.push({ story: sid, page, idx: c.i, name: c.f.name || 'UNKNOWN', score: Number.isFinite(c.score) ? +c.score.toFixed(3) : null, area: +(c.area * 100).toFixed(2), hasFace: c.hasFace, file: fname, reasons: c.reasons });
      }
      console.log(sid.slice(-10), 'p' + page, cand.length, 'candidates cropped');
    }
  }
  await pool.end();
  fs.writeFileSync(`${OUT}/cuts.json`, JSON.stringify({ totalFigures, dinoPages, cuts }, null, 1));
  const named = cuts.filter(c => c.name !== 'UNKNOWN');
  console.log(`DONE: ${dinoPages} dino pages, ${totalFigures} figures, ${cuts.length} would-cut boxes (${named.length} NAMED)`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
