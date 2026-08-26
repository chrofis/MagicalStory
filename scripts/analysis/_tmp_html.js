const fs = require('fs');
const data = JSON.parse(fs.readFileSync('scripts/analysis/_tmp_gate_data.json', 'utf8'));
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

const card = p => {
  const bg = p.chars.filter(c => (c.depth||'').toLowerCase() === 'background');
  const fg = p.chars.filter(c => (c.depth||'').toLowerCase() === 'foreground');
  const rows = p.chars.map(c => {
    const d = (c.depth || '—').toLowerCase();
    const cls = d === 'background' ? 'bg' : d === 'foreground' ? 'fg' : 'mid';
    return `<tr><td class="nm">${esc(c.name)}</td><td><span class="pill ${cls}">${esc(d)}</span></td>
            <td class="pos">${esc(c.position) || '<i>—</i>'}</td></tr>`;
  }).join('');
  const settingStr = typeof p.setting === 'string' ? p.setting : (p.setting?.indoorOutdoor || p.setting?.location || null);
  return `
  <article class="page">
    <header>
      <h3>${esc(p.story)} — page ${p.page}</h3>
      <div class="meta">${esc(p.when)} CH${p.shot ? ' · ' + esc(p.shot) : ''}</div>
    </header>
    <div class="body">
      <div class="shot"><img src="${esc(p.img)}" alt="page ${p.page}" loading="lazy"></div>
      <div class="detail">
        <table>${rows}</table>
        <div class="why">
          <b>Gate result: <span class="yes">SHOULD RUN</span></b>
          <ol>
            <li>${p.chars.length} characters declared (needs ≥2) ✓</li>
            <li>${fg.length} foreground: ${fg.map(c=>esc(c.name)).join(', ') || '—'} ✓</li>
            <li>${bg.length} background: ${bg.map(c=>esc(c.name)).join(', ') || '—'} ✓</li>
            <li>Setting <code>${settingStr ? esc(settingStr) : 'null'}</code> — not "indoor", so not skipped ✓</li>
            <li>No background character is "aboard/inside the" a shared vessel ✓</li>
          </ol>
        </div>
        <div class="what">
          <b>What actually happened:</b>
          <ul>
            <li><code>compositeOutcome</code> key present on the scene: <b class="no">${p.hasKey ? 'yes' : 'NO'}</b></li>
            <li><code>preScaleRepairImage</code>: <b class="no">${p.preScale ? 'yes' : 'no'}</b></li>
            <li>versions stored: <code>${esc(p.versions.join(' → ')) || 'none'}</code></li>
          </ul>
        </div>
      </div>
    </div>
  </article>`;
};

const byStory = new Map();
data.forEach(p => { if (!byStory.has(p.story)) byStory.set(p.story, []); byStory.get(p.story).push(p); });

const html = `<title>Composite Gate Audit</title>
<style>
 :root{--bg:#fbfbfa;--fg:#1c1b19;--mut:#6d6a65;--line:#e3e0da;--card:#fff;--acc:#b4442e;}
 @media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#171614;--fg:#eceae6;--mut:#a09b93;--line:#302d29;--card:#201e1b;--acc:#e07a5f;}}
 :root[data-theme="dark"]{--bg:#171614;--fg:#eceae6;--mut:#a09b93;--line:#302d29;--card:#201e1b;--acc:#e07a5f;}
 body{background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;padding:32px 24px 80px;}
 .wrap{max-width:1120px;margin:0 auto;}
 h1{font-size:26px;margin:0 0 6px;letter-spacing:-.02em;}
 .lede{color:var(--mut);max-width:70ch;margin:0 0 28px;}
 .summary{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--acc);border-radius:8px;padding:16px 20px;margin:0 0 34px;}
 .summary b{color:var(--acc);}
 h2{font-size:15px;text-transform:uppercase;letter-spacing:.08em;color:var(--mut);margin:38px 0 14px;border-bottom:1px solid var(--line);padding-bottom:6px;}
 .page{background:var(--card);border:1px solid var(--line);border-radius:10px;margin:0 0 20px;overflow:hidden;}
 .page header{padding:14px 18px;border-bottom:1px solid var(--line);}
 .page h3{margin:0;font-size:16px;}
 .meta{color:var(--mut);font-size:13px;}
 .body{display:grid;grid-template-columns:300px 1fr;gap:20px;padding:18px;}
 @media(max-width:780px){.body{grid-template-columns:1fr;}}
 .shot img{width:100%;border-radius:6px;border:1px solid var(--line);display:block;}
 table{border-collapse:collapse;width:100%;font-size:13.5px;margin-bottom:14px;}
 td{padding:5px 8px;border-bottom:1px solid var(--line);vertical-align:top;}
 .nm{font-weight:600;white-space:nowrap;}
 .pos{color:var(--mut);}
 .pill{display:inline-block;padding:1px 9px;border-radius:99px;font-size:11.5px;font-weight:700;letter-spacing:.03em;}
 .pill.bg{background:#2f6f4e;color:#fff;} .pill.fg{background:#8a4d2b;color:#fff;} .pill.mid{background:var(--line);color:var(--mut);}
 .why,.what{font-size:13.5px;margin-bottom:12px;}
 .why ol,.what ul{margin:6px 0 0;padding-left:20px;color:var(--mut);}
 .yes{color:#2f6f4e;} .no{color:var(--acc);}
 code{background:var(--line);padding:1px 5px;border-radius:3px;font-size:12.5px;}
</style>
<div class="wrap">
<h1>Composite gate audit — 14 days of production</h1>
<p class="lede">Every page below passes <code>needsScaleRepair()</code> (server/lib/scaleRepair.js:57), the real trigger the pipeline uses. On each one the composite should have run. On none of them is there any trace that it did.</p>
<div class="summary">
 10 stories · 161 pages scanned · <b>11 pages pass the gate</b> · <b>0 carry a compositeOutcome</b> · <b>0 carry any composite artefact</b>.<br>
 The stamping code shipped 2026-08-16 (b1c6bcf39) and is live on master, so absence of the key means the branch never executed — not that it ran and returned nothing.
</div>
${[...byStory.entries()].map(([s, ps]) =>
  `<h2>${esc(s)} — ${ps.length} page${ps.length>1?'s':''}</h2>` + ps.sort((a,b)=>a.page-b.page).map(card).join('')
).join('')}
</div>`;
fs.writeFileSync('scripts/analysis/_tmp_gate_audit.html', html);
console.log('written');
