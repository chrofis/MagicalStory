const fs=require('fs'), path=require('path');
const j=require('./_tmp_exp64.json');
const dir='scripts/analysis/_tmp_c64';
const b64=f=>fs.existsSync(path.join(dir,f))?'_tmp_c64/'+f:null;
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const files=fs.readdirSync(dir).sort();
const R=j.results;
const ok=R[4];

const aborts=R.filter(r=>!r.ok).map(r=>{
  const kind=/depth spread/.test(r.error)?'depth-spread':'cast-empty';
  return `<tr><td>…${esc(String(r.storyId).slice(-9))} <b>p${r.pageNumber}</b></td>
   <td><span class="tag ${kind}">${kind}</span></td><td class="err">${esc(r.error)}</td></tr>`;}).join('');

const stepCards=files.filter(f=>!f.startsWith('99')&&!f.startsWith('00')).map(f=>{
  const label=f.replace(/^\d+-/,'').replace(/_/g,' ');
  return `<figure><img src="${b64(f)}"><figcaption>${esc(label)}</figcaption></figure>`;}).join('');

const place=(ok.placements||[]).map(p=>`<tr><td>${esc(p.name)}</td><td>age ${p.age}</td><td>${esc(p.via)}</td>
  <td>head ${p.head}px</td><td>target ${p.targetH}px</td><td>${p.clipped?'clipped':'—'}</td></tr>`).join('');

const html=`<title>Composite Rerun — Exp 64</title>
<style>
 :root{--bg:#fbfbfa;--fg:#1c1b19;--mut:#6d6a65;--line:#e3e0da;--card:#fff;--acc:#b4442e;--ok:#2f6f4e;}
 @media(prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#171614;--fg:#eceae6;--mut:#a09b93;--line:#302d29;--card:#201e1b;--acc:#e07a5f;--ok:#6aa87f;}}
 :root[data-theme="dark"]{--bg:#171614;--fg:#eceae6;--mut:#a09b93;--line:#302d29;--card:#201e1b;--acc:#e07a5f;--ok:#6aa87f;}
 body{background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;padding:32px 24px 80px;}
 .wrap{max-width:1180px;margin:0 auto;} h1{font-size:26px;margin:0 0 6px;letter-spacing:-.02em;}
 .lede{color:var(--mut);max-width:74ch;margin:0 0 26px;}
 .box{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--acc);border-radius:8px;padding:16px 20px;margin:0 0 30px;}
 h2{font-size:15px;text-transform:uppercase;letter-spacing:.08em;color:var(--mut);margin:36px 0 14px;border-bottom:1px solid var(--line);padding-bottom:6px;}
 table{border-collapse:collapse;width:100%;font-size:13.5px;background:var(--card);border:1px solid var(--line);border-radius:8px;overflow:hidden;}
 td,th{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top;}
 .err{color:var(--mut);font-size:12.5px;}
 .tag{padding:2px 9px;border-radius:99px;font-size:11.5px;font-weight:700;color:#fff;}
 .tag.depth-spread{background:#8a4d2b;} .tag.cast-empty{background:var(--acc);}
 .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:16px;}
 figure{margin:0;background:var(--card);border:1px solid var(--line);border-radius:8px;overflow:hidden;}
 figure img{width:100%;display:block;} figcaption{padding:8px 10px;font-size:12.5px;color:var(--mut);}
 .ba{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-bottom:8px;}
 @media(max-width:760px){.ba{grid-template-columns:1fr;}}
 .ba figure{border:2px solid var(--line);} .ba figure.win{border-color:var(--ok);}
 code{background:var(--line);padding:1px 5px;border-radius:3px;font-size:12.5px;}
</style>
<div class="wrap">
<h1>Composite rerun — production experiment 64</h1>
<p class="lede">The five production pages whose outline declared a foreground <em>and</em> a background character. Each was re-run through the real composite stage to answer: what would the page have looked like?</p>
<div class="box"><b>4 of 5 aborted by design. 1 produced a page.</b> The composite was never silently broken — it runs, inspects the plate, and refuses when the premise does not hold. The abort reason was being thrown away before save, which is why the database looked as if nothing ever happened.</div>

<h2>The four aborts</h2>
<table><tr><th>page</th><th>gate</th><th>reason</th></tr>${aborts}</table>

<h2>The one that ran — Das Ei im Wurzelnest, page 17</h2>
<p class="lede">Cast: ${esc((ok.cast||[]).map(c=>c.name+' ('+(c.depth||'?')+')').join(', '))} · detector ${esc(ok.detector)} · ${(ok.placements||[]).length} figures placed · $${ok.cost}</p>
<div class="ba">
 <figure><img src="${b64('00-original.jpg')}"><figcaption><b>What shipped</b> — the original render</figcaption></figure>
 <figure class="win"><img src="${b64('99-final-composited.jpg')}"><figcaption><b>What the composite produced</b></figcaption></figure>
</div>
<table>${place}</table>

<h2>Every intermediate step</h2>
<div class="grid">${stepCards}</div>
</div>`;
fs.writeFileSync('scripts/analysis/_tmp_exp64.html',html);
console.log('written', (html.length/1024/1024).toFixed(1)+'MB');
