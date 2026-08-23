const fs = require('fs');
const path = require('path');
const DIR = process.env.OUT_DIR || process.cwd();
const pages = JSON.parse(fs.readFileSync(path.join(DIR, 'pages.json'), 'utf8'));

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const GC = { HANDS_ON: '#c0392b', GESTURE: '#d68910', GROUP: '#7d3c98', POSTURE: '#2874a6', GAZE: '#1e8449' };

function card(x) {
  const rows = x.rows.map((r) => `
    <div class="row ${r.flagged ? 'bad' : 'ok'}">
      <span class="g" style="background:${GC[r.group] || '#555'}">${r.group}</span>
      <span class="pri ${r.priority}">${r.priority}${r.storyRelevant ? ' · story' : ''}</span>
      <b>${esc(r.who)}</b>: ${esc(r.where)}
      <span class="verdict">${r.flagged ? '✗ not rendered' : '✓'}</span>
    </div>`).join('');
  return `
  <div class="card">
    <div class="img">${x.url ? `<img loading="lazy" src="${x.url}">` : '<div class="noimg">no image</div>'}</div>
    <div class="meta">
      <h3>${x.book} p${x.p}</h3>
      <div class="scores">
        <span class="s ${x.sem <= 50 ? 'red' : x.sem >= 70 ? 'green' : 'amber'}">semantic ${x.sem}</span>
        <span class="s">final ${x.final}</span>
        <span class="s">${x.versions} version${x.versions > 1 ? 's' : ''}</span>
        <span class="s">cast ${x.cast}</span>
        <span class="s">${x.nInt} interaction${x.nInt === 1 ? '' : 's'} · ${x.nTypes} type${x.nTypes === 1 ? '' : 's'}</span>
      </div>
      ${rows || '<div class="row ok"><i>no interactions declared</i></div>'}
    </div>
  </div>`;
}

function section(title, note, list) {
  if (!list.length) return '';
  const sems = list.map((x) => x.sem);
  const a = Math.round(sems.reduce((p, c) => p + c, 0) / sems.length);
  return `<section><h2>${title}</h2><p class="note">${note} — <b>n=${list.length}, avg semantic ${a}</b></p>
    <div class="grid">${list.map(card).join('')}</div></section>`;
}

const withInt = pages.filter((x) => x.nInt > 0);
const soloHands = withInt.filter((x) => x.nInt === 1 && x.nHands === 1);
const multiHands = withInt.filter((x) => x.nHands > 0 && x.nInt >= 2);
const noHands1 = withInt.filter((x) => !x.nHands && x.nInt === 1);
const fused = withInt.filter((x) => x.cast >= 2 && x.nInt === 1 && x.rows.some((r) => r.n_people > 1));
const diffTypes = withInt.filter((x) => x.cast >= 2 && x.nInt >= 2 && x.nTypes >= 2);
const rest = withInt.filter((x) => ![...soloHands, ...multiHands, ...noHands1, ...fused, ...diffTypes].includes(x));
const none = pages.filter((x) => x.nInt === 0);

const html = `<!doctype html><meta charset="utf-8"><title>Interaction shape vs image outcome</title>
<style>
 body{font:14px/1.5 -apple-system,Segoe UI,sans-serif;margin:0;padding:24px;background:#f5f5f7;color:#1d1d1f}
 h1{margin:0 0 4px} h2{margin:34px 0 2px;font-size:19px}
 .lede{color:#555;max-width:80ch;margin-bottom:8px}
 .note{color:#666;margin:0 0 12px}
 .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(430px,1fr));gap:16px}
 .card{background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.12);display:flex;flex-direction:column}
 .img{background:#111;aspect-ratio:4/3;display:flex;align-items:center;justify-content:center}
 .img img{width:100%;height:100%;object-fit:contain}
 .noimg{color:#888}
 .meta{padding:10px 12px 12px}
 h3{margin:0 0 6px;font-size:15px}
 .scores{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
 .s{font-size:11px;background:#eee;border-radius:4px;padding:2px 7px}
 .s.red{background:#fdd;color:#900;font-weight:600}
 .s.amber{background:#fef0d0;color:#8a5300;font-weight:600}
 .s.green{background:#dff5e1;color:#1a6b2c;font-weight:600}
 .row{font-size:12.5px;padding:5px 7px;border-radius:5px;margin-bottom:4px;background:#f7f7f9}
 .row.bad{background:#fdf0ef;border-left:3px solid #c0392b}
 .row.ok{border-left:3px solid #cfd8dc}
 .g{color:#fff;font-size:10px;padding:1px 6px;border-radius:3px;margin-right:5px;letter-spacing:.3px}
 .pri{font-size:10px;color:#666;border:1px solid #ddd;border-radius:3px;padding:1px 5px;margin-right:5px}
 .pri.essential{color:#a33;border-color:#e5b4b4;font-weight:600}
 .pri.low{color:#999}
 .verdict{float:right;font-size:11px;color:#c0392b;font-weight:600}
 .row.ok .verdict{color:#2e7d32}
</style>
<h1>Interaction shape vs image outcome</h1>
<p class="lede">Two production stories, 34 pages, 60 declared interaction rows from <code>sceneMetadata.interactions</code>.
Red row = the semantic evaluator raised an <code>action_interaction</code> / <code>wrong_interaction</code> finding naming that character.
Images are the final chosen version from R2.</p>
${section('A. Only ONE interaction, and it is HANDS-ON', 'The isolated hands-on case', soloHands)}
${section('B. HANDS-ON plus other interactions (2+ rows)', 'Hands-on combined with more load', multiHands)}
${section('C. ONE interaction, no hands-on', 'The cheap baseline', noHands1)}
${section('D. Multi-person, ONE fused row (everyone doing the same thing)', 'Shared single action', fused)}
${section('E. Multi-person, several rows of DIFFERENT types', 'Divergent staging', diffTypes)}
${section('F. Remaining pages', '', rest)}
${section('G. No interactions declared at all', '', none)}
`;
const out = path.join(DIR, 'interaction-gallery.html');
fs.writeFileSync(out, html);
console.log(out);
