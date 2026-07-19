'use strict';
// Cover-composite FIGURE ORIENTATION A/B (2026-07-19). Same 5 oil figures +
// borrowed plate through generateCoverViaComposite 4× with orient:
//   frontal (control) | turned-source | turned-prompt | both
// Emits a LOCAL HTML grid (no claude.ai artifact — links 404 for the user)
// showing, per variant, the full input chain: avatar sheets -> figures-on-white
// (pass1Input) -> figures-overlaid-on-plate (pass2Input) -> final render.
require('dotenv').config();
const fs = require('fs');
const { Pool } = require('pg');

const OUT = 'C:/Users/roger/AppData/Local/Temp/oil-experiment';
const GRID = 'C:/Users/roger/AppData/Local/Temp/claude/C--Users-roger-MagicalStory/99bf5cc6-df38-4beb-ba70-f01254443328/scratchpad/cover-orient-grid.html';
const USER_ID = 'b020e093-90d9-431a-acd4-372eb8438cbe';
const SHEETS = { Emma: 'avatar_Emma_oil_FIXED', Noah: 'avatar_Noah_oil', Daniel: 'avatar_Daniel_oil', Sarah: 'avatar_Sarah_oil', Hans: 'avatar_Hans_oil' };
const VARIANTS = [
  { k: 'frontal', v: 'CONTROL', cls: 'ctl', note: 'Squared shoulders, frontal stares — the flat lineup we are beating.' },
  { k: 'turned-source', v: 'REJECTED', cls: 'rej', note: 'Turn barely perceptible, and the 45° source cell drifts clothing (Noah camo). Not worth it.' },
  { k: 'turned-prompt', v: 'WINNER', cls: 'win', note: 'Front cutout (identity locked) + repose turns shoulders inward. Candid depth, all shod, no drift.' },
  { k: 'both', v: 'CAVEAT', cls: 'rej', note: 'Strongest turn, but inherits the turned-source clothing drift (Noah camo). Needs the backlogged avatar L/R-reliability fix.' },
];
const bufUri = b => 'data:image/jpeg;base64,' + Buffer.from(b).toString('base64');
const fileUri = p => 'data:image/jpeg;base64,' + fs.readFileSync(p).toString('base64');
const asBuf = x => Buffer.isBuffer(x) ? x : (typeof x === 'string' && x.startsWith('data:') ? Buffer.from(x.split(',')[1], 'base64') : Buffer.from(x));

(async () => {
  const { loadPromptTemplates } = require('../../server/services/prompts');
  await loadPromptTemplates();
  const { generateCoverViaComposite } = require('../../server/lib/coverComposite');

  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  let cd = (await pool.query('SELECT data FROM characters WHERE user_id=$1', [USER_ID])).rows[0].data;
  if (typeof cd === 'string') cd = JSON.parse(cd);
  await pool.end();
  const characters = (Array.isArray(cd) ? cd : cd.characters || []).filter(c => SHEETS[c.name]);
  for (const c of characters) {
    c.avatars = c.avatars || {};
    c.avatars.styledAvatars = c.avatars.styledAvatars || {};
    c.avatars.styledAvatars.oil = { standard: fileUri(`${OUT}/${SHEETS[c.name]}.jpg`) };
  }
  const landmarkBuf = fs.readFileSync(`${OUT}/bg_p9.jpg`);
  console.log(`${characters.length} oil figures. Running ${VARIANTS.length} variants...`);

  const results = [];
  for (const variant of VARIANTS) {
    const t0 = Date.now();
    try {
      const r = await generateCoverViaComposite({
        coverKey: 'initialPage', characters, coverHint: null, landmarkBuf,
        artStyle: 'oil',
        styleHint: 'oil painting with visible brushwork and rich impasto texture, painterly, soft warm lighting, traditional fine-art oil-on-canvas look',
        title: '', dedication: '',
        sceneDescription: 'the family standing together on the cobblestone path in front of the kindergarten building',
        usageTracker: null, orient: variant.k,
      });
      const secs = Math.round((Date.now() - t0) / 1000);
      if (r.imageData) fs.writeFileSync(`${OUT}/orient_${variant.k}.jpg`, Buffer.from(r.imageData.split(',')[1], 'base64'));
      console.log(`  ${variant.k}: ${secs}s`);
      results.push({ ...variant, secs,
        pass1: r.debug?.pass1Input ? bufUri(asBuf(r.debug.pass1Input)) : null,
        pass2: r.debug?.pass2Input ? bufUri(asBuf(r.debug.pass2Input)) : null,
        final: r.imageData });
    } catch (e) {
      console.error(`  ${variant.k}: ERR ${e.message}`);
      results.push({ ...variant, secs: 0, err: e.message });
    }
  }

  const avatars = characters.map(c => `<figure class="av"><img src="${c.avatars.styledAvatars.oil.standard}" alt="${c.name}"><figcaption>${c.name}</figcaption></figure>`).join('');
  const stage = (label, uri) => uri ? `<div class="stage"><span class="slab">${label}</span><img src="${uri}"></div>` : `<div class="stage"><span class="slab">${label}</span><div class="miss">n/a</div></div>`;
  const rows = results.map(r => `
    <section class="row ${r.cls}">
      <header><span class="name">${r.k}</span><span class="pill ${r.cls}">${r.v}</span><span class="time">${r.secs}s</span><span class="note">${r.note}</span></header>
      <div class="stages">
        ${stage('1 · figures on white (pass-1 input)', r.pass1)}
        ${stage('2 · overlaid on plate (pass-2 input)', r.pass2)}
        ${stage('3 · final render', r.final)}
      </div>
    </section>`).join('');

  const html = `<title>Cover orientation A/B — full input chain</title>
<style>
  :root{--bg:#0e0f12;--panel:#16181d;--line:#262a31;--ink:#ecebe6;--muted:#9aa0ab;--win:#4db6a0;--rej:#cf8478;--ctl:#7f8794}
  @media (prefers-color-scheme:light){:root{--bg:#f3f2ee;--panel:#fff;--line:#e2e0d8;--ink:#1a1c20;--muted:#6a6f78;--win:#2f8f79;--rej:#b85f50}}
  :root[data-theme="dark"]{--bg:#0e0f12;--panel:#16181d;--line:#262a31;--ink:#ecebe6;--muted:#9aa0ab;--win:#4db6a0;--rej:#cf8478}
  :root[data-theme="light"]{--bg:#f3f2ee;--panel:#fff;--line:#e2e0d8;--ink:#1a1c20;--muted:#6a6f78;--win:#2f8f79;--rej:#b85f50}
  *{box-sizing:border-box}
  body{background:var(--bg);color:var(--ink);font-family:ui-sans-serif,system-ui,Segoe UI,Roboto,sans-serif;margin:0;padding:32px 24px 56px;line-height:1.5}
  .wrap{max-width:1120px;margin:0 auto}
  .eyebrow{font-family:ui-monospace,Menlo,monospace;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
  h1{font-size:26px;line-height:1.15;margin:.35em 0 .2em;text-wrap:balance;font-weight:640}
  .sub{color:var(--muted);max-width:70ch;margin:0 0 8px}
  h2{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin:26px 0 10px;font-family:ui-monospace,Menlo,monospace}
  .avatars{display:flex;gap:10px;flex-wrap:wrap}
  .av{margin:0;width:120px}.av img{width:100%;border:1px solid var(--line);border-radius:8px;display:block}
  .av figcaption{font-size:11px;color:var(--muted);text-align:center;padding-top:4px;font-family:ui-monospace,Menlo,monospace}
  .row{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px;margin:16px 0}
  .row.win{border-color:color-mix(in srgb,var(--win) 55%,var(--line))}
  header{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px}
  .name{font-family:ui-monospace,Menlo,monospace;font-size:15px;font-weight:640}
  .time{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--muted)}
  .note{color:var(--muted);font-size:13px;flex:1;min-width:220px}
  .row.win .note{color:var(--ink)}
  .pill{font-family:ui-monospace,Menlo,monospace;font-size:10.5px;letter-spacing:.08em;padding:3px 8px;border-radius:999px;border:1px solid}
  .pill.win{color:var(--win);border-color:color-mix(in srgb,var(--win) 45%,transparent);background:color-mix(in srgb,var(--win) 12%,transparent)}
  .pill.rej{color:var(--rej);border-color:color-mix(in srgb,var(--rej) 45%,transparent);background:color-mix(in srgb,var(--rej) 12%,transparent)}
  .pill.ctl{color:var(--ctl);border-color:color-mix(in srgb,var(--ctl) 45%,transparent);background:color-mix(in srgb,var(--ctl) 12%,transparent)}
  .stages{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
  @media (max-width:760px){.stages{grid-template-columns:1fr}}
  .stage{position:relative}
  .slab{position:absolute;top:8px;left:8px;font-family:ui-monospace,Menlo,monospace;font-size:10px;background:rgba(0,0,0,.62);color:#fff;padding:3px 7px;border-radius:5px}
  .stage img{width:100%;display:block;border-radius:8px;aspect-ratio:3/4;object-fit:cover;background:#000}
  .miss{aspect-ratio:3/4;display:flex;align-items:center;justify-content:center;color:var(--muted);border:1px dashed var(--line);border-radius:8px}
</style>
<div class="wrap">
  <p class="eyebrow">Test Lab · composite cover · full input chain</p>
  <h1>Figure orientation A/B</h1>
  <p class="sub">Same five oil figures + borrowed plate through <code>generateCoverViaComposite</code>. Feet-crop hardened (per-pose full-body clause + hard bottom-margin) and figures now fill ~80% of the canvas for head/foot room. Each row shows the full pipeline: avatar sheet inputs → figures on white → overlaid on the plate → final.</p>
  <h2>Avatar sheet inputs (shared)</h2>
  <div class="avatars">${avatars}</div>
  <h2>Per-variant pipeline</h2>
  ${rows}
</div>`;
  fs.writeFileSync(GRID, html);
  console.log(`\nGrid: ${GRID} (${Math.round(fs.statSync(GRID).size / 1024)} KB)`);
  process.exit(0);
})().catch(e => { console.error('FATAL:', e.message, (e.stack || '').split('\n').slice(1, 3).join(' ')); process.exit(1); });
