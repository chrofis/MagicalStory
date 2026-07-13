// Standalone verify for server/lib/coverTypography.js against REAL stored covers.
//
//   node scripts/analysis/verify-cover-typography.js [--env=staging|prod] [--n=8] [--ids=id1,id2]
//
// Pulls diverse covers (R2 image_url + bboxDetection.figures) and re-composites the title /
// dedication / brand app-side, then writes an HTML gallery. NOTE: existing covers still have the
// AI-baked title, so the front will show DOUBLE text — this run verifies the engine's placement,
// colour and character-avoidance on real art + real figure boxes, not the final textless look.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const ct = require('../../server/lib/coverTypography');

const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)=?(.*)$/); return m ? [m[1], m[2]] : [a, true]; }));
const ENV = args.env === 'prod' ? 'prod' : 'staging';
const N = parseInt(args.n || '8', 10);
const OUT = path.join('C:/Users/roger/AppData/Local/Temp/claude/C--Users-roger-MagicalStory/412cc6db-b6d4-4452-a08e-34356490ace3/scratchpad', 'covertypo');
const CONN = ENV === 'prod' ? process.env.DATABASE_URL : process.env.STAGING_DATABASE_URL;
const SAMPLE_DEDICATION = 'Für dich, mein kleiner Schatz — mögest du immer mutig träumen und wissen, dass wir dich von Herzen lieben.';

async function fetchBuf(url) { const r = await fetch(url); if (!r.ok) throw new Error(`fetch ${r.status} ${url}`); return Buffer.from(await r.arrayBuffer()); }

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const pool = new Pool({ connectionString: CONN, ssl: { rejectUnauthorized: false } });
  let ids;
  if (args.ids) ids = String(args.ids).split(',');
  else {
    const q = await pool.query(`
      SELECT id FROM stories
      WHERE jsonb_array_length(COALESCE(data->'coverImages'->'frontCover'->'bboxDetection'->'figures','[]'::jsonb)) >= 1
        AND data->>'title' NOT LIKE '%PARTIAL%'
      ORDER BY created_at DESC NULLS LAST LIMIT $1`, [N]);
    ids = q.rows.map(r => r.id);
  }
  console.log(`[${ENV}] verifying ${ids.length} covers`);
  const cards = [];
  for (const id of ids) {
    try {
      const s = await pool.query(`SELECT data->>'title' AS title, data->>'dedication' AS dedication,
        data->'coverImages'->'frontCover'->'bboxDetection'->'figures' AS figures,
        (data->'coverImages'->'frontCover'->>'activeVersion') AS av
        FROM stories WHERE id=$1`, [id]);
      if (!s.rows[0]) { console.log(`  ${id}  (no row)`); continue; }
      const { title, dedication, figures, av } = s.rows[0];
      const figs = (figures || []).map(f => ({ bodyBox: f.bodyBox, faceBox: f.faceBox, name: f.name }));
      // pick the active (or highest) frontCover image_url
      const iv = await pool.query(`SELECT version_index, image_url FROM story_images WHERE story_id=$1 AND image_type='frontCover' AND image_url IS NOT NULL ORDER BY version_index`, [id]);
      if (!iv.rows.length) { console.log(`  ${id}  (no image_url)`); continue; }
      const pick = iv.rows.find(r => String(r.version_index) === String(av)) || iv.rows[iv.rows.length - 1];
      const art = await fetchBuf(pick.image_url);

      const front = await ct.composeCover({ artBuffer: art, kind: 'front', title, seed: id, figures: figs });
      const ded = await ct.composeCover({ artBuffer: art, kind: 'initial', dedication: dedication || SAMPLE_DEDICATION, seed: id, figures: figs });
      const back = await ct.composeCover({ artBuffer: art, kind: 'back', figures: figs });
      const base = id.replace(/[^a-z0-9]/gi, '').slice(-12);
      fs.writeFileSync(path.join(OUT, `${base}_front.jpg`), front.buffer);
      fs.writeFileSync(path.join(OUT, `${base}_ded.jpg`), ded.buffer);
      fs.writeFileSync(path.join(OUT, `${base}_back.jpg`), back.buffer);
      cards.push({ id, base, title, nfig: figs.length, spec: front.spec });
      console.log(`  OK ${id}  fig=${figs.length}  ${front.spec.fontId}/${front.spec.layout} ${front.spec.face}  ${title}`);
    } catch (e) { console.log(`  ERR ${id}  ${e.message}`); }
  }
  await pool.end();
  const html = `<!doctype html><meta charset=utf-8><title>cover typography verify</title>
<style>body{margin:0;background:#12141a;color:#e8e8ee;font:13px system-ui;padding:20px}
h2{font-size:14px;margin:18px 0 8px;color:#cdd}.cols{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
figure{margin:0;background:#1c1f27;border-radius:8px;overflow:hidden}img{width:100%;display:block}
figcaption{padding:6px 8px;color:#9aa;font-size:11px}</style>
<h1>Cover typography — real covers (${ENV})</h1>
<p style="color:#9aa">Engine on real art + real figure boxes. Front shows the app-side title <b>on top of</b> the still-baked AI title (double text is expected here) — judge placement, colour, and character-avoidance.</p>
${cards.map(c => `<h2>${c.title} · ${c.nfig} figs · ${c.spec.fontId}/${c.spec.layout}</h2><div class=cols>
<figure><img src="${c.base}_front.jpg"><figcaption>front (title over baked)</figcaption></figure>
<figure><img src="${c.base}_ded.jpg"><figcaption>dedication</figcaption></figure>
<figure><img src="${c.base}_back.jpg"><figcaption>back · magicalstory.ch</figcaption></figure></div>`).join('\n')}`;
  fs.writeFileSync(path.join(OUT, 'gallery.html'), html);
  console.log(`\nwrote ${cards.length} covers -> ${path.join(OUT, 'gallery.html')}`);
})().catch(e => { console.error('FATAL', e.stack); process.exit(1); });
