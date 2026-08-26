const fs = require('fs');
const ls = d => { try { return fs.readdirSync('scripts/analysis/' + d); } catch { return []; } };
const A = ls('_tmp_c69'), B = ls('_tmp_c824'), D = ls('_tmp_all');
const p = (list, pre, base) => { const h = list.find(x => x.startsWith(pre)); return h ? base + '/' + h : null; };
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const card = o => `
<section class="page">
  <header><h2>${esc(o.title)}</h2><span class="tag ${o.cls}">${esc(o.badge)}</span>
    <div class="sub">${esc(o.sub)}</div></header>
  <div class="row">
   ${o.shots.filter(s => s.src).map(s => `<figure class="${s.cls || ''}"><img src="${s.src}"><figcaption><b>${esc(s.t)}</b>${esc(s.c || '')}</figcaption></figure>`).join('')}
  </div>
  ${o.note ? `<div class="note ${o.noteCls || ''}">${o.note}</div>` : ''}
</section>`;

const pages = [
  {
    title: 'Das Ei im Wurzelnest — page 17', badge: 'COMPOSITED', cls: 'ok',
    sub: 'The dragon page. Levin, Max, Kiaan foreground + Julian background. Creature ANI001 Drachenmutter.',
    shots: [
      { src: p(A, 'p17-00-', '_tmp_c69'), t: 'shipped', c: 'boys turned toward the dragon, Julian at the nest looking at the glowing egg' },
      { src: p(A, 'p17-01-', '_tmp_c69'), t: 'ghost plate', c: 'dragon painted — the fix works — but three identical frontal blobs, and the egg is gone', cls: 'bad' },
      { src: p(A, 'p17-03-', '_tmp_c69'), t: 'pasted, pre-blend', c: 'faithful to the plate' },
      { src: p(A, 'p17-99-', '_tmp_c69'), t: 'final', c: 'rain and wet shirts. Same lineup, nobody watching the dragon', cls: 'bad' }],
    note: '<b>The creature fix works; the staging does not.</b> The plate ignored “watching the dragon” and dropped a required object. The blend then did nothing structural — only weather.', noteCls: 'bad',
  },
  {
    title: 'Kapellbrücke — page 6', badge: 'COMPOSITED', cls: 'ok',
    sub: 'The healthiest case in the set: 2.77× depth spread. Daniel background on the bridge, Sarah foreground, Hans midground.',
    shots: [
      { src: p(B, 'p6-00-', '_tmp_c824'), t: 'shipped', c: 'direct render' },
      { src: p(B, 'p6-01-', '_tmp_c824'), t: 'ghost plate', c: 'real depth AND poses — a raised arm, a hand on the hip', cls: 'good' },
      { src: p(B, 'p6-03-', '_tmp_c824'), t: 'pasted, pre-blend', c: 'depth correct — the man in yellow small, cut off by the parapet', cls: 'good' },
      { src: p(B, 'p6-99-', '_tmp_c824'), t: 'final', c: 'blend enlarged him to near-foreground size and perched him on the railing', cls: 'bad' }],
    note: '<b>This is the page that found the bug.</b> The census told the occluded figure to stand “at full height — never shrunk to a small figure”, while the same prompt said he was “in the background — small and distant”. Fixed in <code>3ad9e1a12</code>; the verification rerun has been killed twice by staging deploys.', noteCls: 'bad',
  },
  {
    title: 'Kapitänin Fiona — page 14', badge: 'REFUSED at 1.43×', cls: 'no',
    sub: 'The VB-character page. Cast built: Fiona, Sarah, Facundo, Lorena + Rossa from her Visual Bible sheet.',
    shots: [
      { src: p(A, 'p14-00-', '_tmp_c69'), t: 'shipped', c: 'direct render' },
      { src: p(A, 'p14-01-', '_tmp_c69'), t: 'ghost plate (aborted after this)', c: 'five silhouettes including Rossa — this run previously produced nothing at all', cls: 'good' },
      { src: p(A, 'p14-02-', '_tmp_c69'), t: 'depopulated', c: 'kept by save-on-abort' }],
    note: '<b>Both fixes visible in one frame.</b> The VB-character fix took it from “cast is empty” to a five-figure plate; save-on-abort kept that plate when the depth gate refused at 1.43×. The refusal itself is correct.', noteCls: 'good',
  },
  {
    title: 'Kapitänin Fiona — page 1', badge: 'REFUSED at 1.56×', cls: 'no',
    sub: 'Fiona foreground, Facundo background (“lower center background”).',
    shots: [{ src: p(D, 'fiona-p1-', '_tmp_all'), t: 'shipped', c: 'no composite frames — this ran before save-on-abort existed, so the plate was discarded' }],
    note: 'Depth was declared, but the plate painted both figures at nearly the same size.',
  },
  {
    title: 'Kapitänin Fiona — page 10', badge: 'REFUSED — cast empty', cls: 'no',
    sub: 'Fiona foreground, “Rossa crew member” background.',
    shots: [{ src: p(D, 'fiona-p10-', '_tmp_all'), t: 'shipped', c: 'nothing was generated — this refusal happens before any Grok call' }],
    note: '<b>Still unfixed, deliberately.</b> CHR002 has <code>referenceImageUrl: null</code> and an empty <code>appearsInPages</code> — no avatar and no VB sheet. The page falls through to the direct render rather than silently dropping a declared figure. Your call on what should happen here.',
  },
  {
    title: 'Das Ei im Wurzelnest — page 1', badge: 'REFUSED at 1.51×', cls: 'no',
    sub: 'Foreground + background declared.',
    shots: [{ src: p(D, 'dasei-p1-', '_tmp_all'), t: 'shipped', c: 'ran before save-on-abort — plate discarded' }],
    note: 'Same pattern as Fiona p1: the outline declares a depth the plate does not paint.',
  },
];

const html = `<title>Composite — Six Pages</title>
<style>
 :root{--bg:#fbfbfa;--fg:#1c1b19;--mut:#6d6a65;--line:#e3e0da;--card:#fff;--acc:#b4442e;--ok:#2f6f4e;}
 @media(prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#171614;--fg:#eceae6;--mut:#a09b93;--line:#302d29;--card:#201e1b;--acc:#e07a5f;--ok:#6aa87f;}}
 :root[data-theme="dark"]{--bg:#171614;--fg:#eceae6;--mut:#a09b93;--line:#302d29;--card:#201e1b;--acc:#e07a5f;--ok:#6aa87f;}
 body{background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;padding:32px 24px 80px;}
 .wrap{max-width:1280px;margin:0 auto;} h1{font-size:27px;margin:0 0 6px;letter-spacing:-.02em;}
 .lede{color:var(--mut);max-width:76ch;margin:0 0 22px;}
 .summary{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--acc);border-radius:8px;padding:14px 18px;margin:0 0 30px;font-size:14px;}
 .page{margin:0 0 34px;padding:0 0 26px;border-bottom:1px solid var(--line);}
 .page header{margin-bottom:12px;} h2{font-size:18px;margin:0;display:inline-block;}
 .sub{color:var(--mut);font-size:13.5px;}
 .tag{display:inline-block;padding:2px 10px;border-radius:99px;font-size:11.5px;font-weight:700;color:#fff;margin-left:10px;vertical-align:2px;}
 .tag.ok{background:var(--ok);} .tag.no{background:var(--acc);}
 .row{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:14px;}
 figure{margin:0;background:var(--card);border:1px solid var(--line);border-radius:9px;overflow:hidden;}
 figure.good{border:2px solid var(--ok);} figure.bad{border:2px solid var(--acc);}
 figure img{width:100%;display:block;background:#8f8f8f;}
 figcaption{padding:9px 11px;font-size:12.5px;color:var(--mut);} figcaption b{color:var(--fg);display:block;}
 .note{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 16px;margin-top:14px;font-size:14px;}
 .note.bad{border-left:3px solid var(--acc);} .note.good{border-left:3px solid var(--ok);}
 code{background:var(--line);padding:1px 5px;border-radius:3px;font-size:12.5px;}
</style>
<div class="wrap">
<h1>Every page put through the composite</h1>
<p class="lede">Six pages across four Lab experiments. Two produced a finished composite; four were refused. Where frames exist they run left to right in pipeline order.</p>
<div class="summary"><b>2 composited, 4 refused.</b> Both composites are worse than the page that shipped — one because the plate staged a flat lineup, the other because the blend undid the depth the paste had got right. Three of the four refusals are the depth gate correctly saying the declared foreground/background split is not real.</div>
${pages.map(card).join('')}
</div>`;
fs.writeFileSync('scripts/analysis/_tmp_all.html', html);
console.log('written');
