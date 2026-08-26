const fs = require('fs');
const b64 = f => 'data:image/jpeg;base64,' + fs.readFileSync('scripts/analysis/_tmp_chk/' + f).toString('base64');
const rows = [
  { t: 'STAGING p4 — the boat page', imgs: [
      { f: 'staging-p4-emptyscene.jpg', c: 'stored <code>empty_scene</code> plate — <b>not</b> the composite ghost. This is the whole stage: about four metres of deck.' },
      { f: 'staging-p4-v0.jpg', c: 'what shipped. Four figures at comparable size — which on this deck is <b>correct</b>.' }],
    dec: 'Fiona <b>foreground</b>, bow · Saira midground, deck · Facundo midground, deck · Sarah <b>background</b>, deck',
    cls: 'bad',
    note: 'The gate should never have opened. <code>SHARED_VESSEL_RE</code> in <code>scaleRepair.js:93</code> only matches <i>“aboard the / inside the / in the boat”</i>; the outline wrote <b>“deck”</b> and <b>“bow”</b>, so the vessel guard missed and the composite fired on four people standing on one hull. The picture is fine — the <b>metadata</b> is wrong.' },
  { t: 'PROD p5 — the stream', imgs: [
      { f: 'prod-p5-emptyscene.jpg', c: 'stored <code>empty_scene</code> plate' },
      { f: 'prod-p5-v1.jpg', c: 'what shipped — real depth, hatchling present, but only one of the two declared background boys' }],
    dec: 'Levin <b>foreground</b> · Julian foreground · Max <b>background</b> · Kiaan <b>background</b>',
    cls: 'ok',
    note: 'Gate correctly open — a genuine forest depth band. The direct render got the depth right on its own. The composite still fired and bailed, reason unrecorded.' },
  { t: 'PROD p17 — the ridge', imgs: [
      { f: 'prod-p17-emptyscene.jpg', c: 'stored <code>empty_scene</code> plate' },
      { f: 'prod-p17-v0.jpg', c: 'what shipped — Max and Kiaan at Levin\'s size, flanking him in a line' }],
    dec: 'Levin <b>foreground</b> · Julian foreground · Max <b>background</b> · Kiaan <b>background</b>',
    cls: 'bad',
    note: 'Gate correctly open, and this is the page that needed it. Both background boys are painted at foreground scale. The composite fired and bailed, reason unrecorded.' },
];
const html = `<title>Ghost Plates &amp; The Boat Gate</title>
<style>
:root{--bg:#fbfbfa;--fg:#1c1b19;--mut:#6d6a65;--line:#e3e0da;--card:#fff;--acc:#b4442e;--ok:#2f6f4e;}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#171614;--fg:#eceae6;--mut:#a09b93;--line:#302d29;--card:#201e1b;--acc:#e07a5f;--ok:#6aa87f;}}
:root[data-theme="dark"]{--bg:#171614;--fg:#eceae6;--mut:#a09b93;--line:#302d29;--card:#201e1b;--acc:#e07a5f;--ok:#6aa87f;}
body{background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;padding:32px 24px 80px;}
.wrap{max-width:1180px;margin:0 auto;} h1{font-size:26px;margin:0 0 6px;letter-spacing:-.02em;}
.lede{color:var(--mut);max-width:78ch;margin:0 0 20px;}
.sum{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--acc);border-radius:8px;padding:14px 18px;margin:0 0 30px;font-size:14px;}
section{margin:0 0 34px;padding:0 0 26px;border-bottom:1px solid var(--line);}
h2{font-size:18px;margin:0;} .tag{display:inline-block;padding:2px 10px;border-radius:99px;font-size:11.5px;font-weight:700;color:#fff;margin-left:10px;vertical-align:2px;}
.tag.ok{background:var(--ok);} .tag.bad{background:var(--acc);}
.dec{color:var(--mut);font-size:13px;margin:4px 0 12px;}
.row{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px;}
figure{margin:0;background:var(--card);border:1px solid var(--line);border-radius:9px;overflow:hidden;}
figure img{width:100%;display:block;} figcaption{padding:10px 12px;font-size:12.5px;color:var(--mut);}
.note{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--acc);border-radius:8px;padding:12px 16px;margin-top:14px;font-size:14px;}
.note.ok{border-left-color:var(--ok);}
code{background:var(--line);padding:1px 5px;border-radius:3px;font-size:12.5px;}
</style>
<div class="wrap">
<h1>No ghost plates exist for these pages</h1>
<p class="lede">Save-on-abort is a Test Lab mechanism only — in production the composite's plate and depopulated plate are generated, paid for, and thrown away on abort. What is stored for every page is the <code>empty_scene</code> plate, a different artefact from an earlier pipeline stage. Both are shown below.</p>
<div class="sum"><b>You are right about p4.</b> Four people on one hull cannot have a foreground/background split — and my earlier verdict calling that render defective was wrong. The picture is correct; the outline metadata is not, and the vessel guard that exists to catch precisely this case missed on the word <b>“deck”</b>.</div>
${rows.map(r => `<section><h2>${r.t}<span class="tag ${r.cls}">${r.cls === 'ok' ? 'GATE CORRECT' : r.cls === 'bad' && r.t.includes('p4') ? 'GATE WRONG' : 'NEEDED IT'}</span></h2>
<div class="dec">declared: ${r.dec}</div>
<div class="row">${r.imgs.map(i => `<figure><img src="${b64(i.f)}"><figcaption>${i.c}</figcaption></figure>`).join('')}</div>
<div class="note ${r.cls}">${r.note}</div></section>`).join('')}
</div>`;
fs.writeFileSync('scripts/analysis/_tmp_chk.html', html);
console.log('ok', (html.length / 1e6).toFixed(1), 'MB');
