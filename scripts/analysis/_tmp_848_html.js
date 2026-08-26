const fs = require('fs');
const D = 'scripts/analysis/_tmp_848/';
const b64 = f => 'data:image/jpeg;base64,' + fs.readFileSync(D + f).toString('base64');
const pick = pre => fs.readdirSync(D).find(f => f.startsWith(pre));

const frames = [
  { f: pick('v68'), t: '1 · plate with colour silhouettes',
    c: 'Depth spread <b>3.97×</b> — tallest 480px, Daniel 121px. Comfortably past the 2.0× gate.', cls: 'good' },
  { f: pick('v69'), t: '2 · depopulated', c: 'The world plate, people removed.' },
  { f: pick('v70'), t: '3 · avatar cut-outs pasted (pre-blend)',
    c: 'Daniel placed <code>via: head+occluded</code> — 121px of a 235px figure, small, up on the bridge, cut off by the parapet. <b>Exactly right.</b>', cls: 'good' },
  { f: 'v99-FINAL-blended.jpg', t: '4 · after the blend',
    c: '<b>Two Daniels.</b> One still kneeling on the parapet, one full-size in the right foreground. The camera has also been pulled in — the bridge and tower are cropped away.', cls: 'bad' },
];

const html = `<title>Exp 848 — Blend Depth Check</title>
<style>
:root{--bg:#fbfbfa;--fg:#1c1b19;--mut:#6d6a65;--line:#e3e0da;--card:#fff;--acc:#b4442e;--ok:#2f6f4e;}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#171614;--fg:#eceae6;--mut:#a09b93;--line:#302d29;--card:#201e1b;--acc:#e07a5f;--ok:#6aa87f;}}
:root[data-theme="dark"]{--bg:#171614;--fg:#eceae6;--mut:#a09b93;--line:#302d29;--card:#201e1b;--acc:#e07a5f;--ok:#6aa87f;}
body{background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;padding:32px 24px 80px;}
.wrap{max-width:1200px;margin:0 auto;} h1{font-size:26px;margin:0 0 6px;letter-spacing:-.02em;}
.lede{color:var(--mut);max-width:78ch;margin:0 0 20px;}
.sum{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--acc);border-radius:8px;padding:14px 18px;margin:0 0 28px;font-size:14px;}
table{border-collapse:collapse;margin:0 0 26px;font-size:13.5px;}
th,td{text-align:left;padding:6px 14px 6px 0;border-bottom:1px solid var(--line);} th{color:var(--mut);font-weight:600;}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;}
figure{margin:0;background:var(--card);border:1px solid var(--line);border-radius:9px;overflow:hidden;}
figure.good{border:2px solid var(--ok);} figure.bad{border:2px solid var(--acc);}
figure img{width:100%;display:block;} figcaption{padding:10px 12px;font-size:12.5px;color:var(--mut);}
figcaption b.h{color:var(--fg);display:block;font-size:13.5px;margin-bottom:3px;}
code{background:var(--line);padding:1px 5px;border-radius:3px;font-size:12.5px;}
</style>
<div class="wrap">
<h1>Exp 848 — the blend fix did not hold</h1>
<p class="lede">One <code>scene_composite</code> run on the Kapellbrücke page, uniform strategy, 3 Grok calls, $0.06. The run completed cleanly — no restart, unlike exp 824 and exp 832. The size-neutral occlusion clause from <code>3ad9e1a12</code> is present in the prompt and no longer contradicts the depth line.</p>
<div class="sum"><b>Verdict: FAIL — and a different, worse failure than the one being fixed.</b> The blend no longer enlarges the occluded figure onto the railing. Instead it <b>duplicated him</b>: Daniel appears twice, once still on the bridge and once at full height in the foreground, and the whole shot was re-framed closer. Everything upstream of the blend was correct.</div>
<table>
<tr><th>plate depth spread</th><td>3.97× (gate needs 2.0×)</td></tr>
<tr><th>Daniel, painted</th><td>121px visible of a 235px figure — <code>via: head+occluded</code></td></tr>
<tr><th>Sarah / Hans</th><td>480px / 378px, both <code>as-painted</code></td></tr>
<tr><th>blend prompt source</th><td><code>census+emotions</code>, detector <code>dino</code>, 3 model calls, 113s</td></tr>
</table>
<div class="grid">
${frames.filter(x => x.f).map(x => `<figure class="${x.cls || ''}"><img src="${b64(x.f)}"><figcaption><b class="h">${x.t}</b>${x.c}</figcaption></figure>`).join('')}
</div>
</div>`;
fs.writeFileSync('scripts/analysis/_tmp_848.html', html);
console.log('ok', (html.length / 1e6).toFixed(1), 'MB');
