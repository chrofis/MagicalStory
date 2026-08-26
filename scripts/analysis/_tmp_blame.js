const fs=require('fs');
const A='_tmp_c824/', B='_tmp_c69/';
const fa=fs.readdirSync('scripts/analysis/_tmp_c824'), fb=fs.readdirSync('scripts/analysis/_tmp_c69');
const pick=(list,pre,base)=>{const h=list.find(x=>x.startsWith(pre));return h?base+h:null;};
const html=`<title>Where the Composite Breaks</title>
<style>
 :root{--bg:#fbfbfa;--fg:#1c1b19;--mut:#6d6a65;--line:#e3e0da;--card:#fff;--acc:#b4442e;--ok:#2f6f4e;}
 @media(prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#171614;--fg:#eceae6;--mut:#a09b93;--line:#302d29;--card:#201e1b;--acc:#e07a5f;--ok:#6aa87f;}}
 :root[data-theme="dark"]{--bg:#171614;--fg:#eceae6;--mut:#a09b93;--line:#302d29;--card:#201e1b;--acc:#e07a5f;--ok:#6aa87f;}
 body{background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;padding:32px 24px 80px;}
 .wrap{max-width:1240px;margin:0 auto;} h1{font-size:27px;margin:0 0 6px;letter-spacing:-.02em;}
 .lede{color:var(--mut);max-width:76ch;margin:0 0 24px;}
 .verdict{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--acc);border-radius:8px;padding:15px 19px;margin:0 0 32px;}
 h2{font-size:17px;margin:38px 0 4px;} .sub{color:var(--mut);font-size:13.5px;margin:0 0 14px;}
 .chain{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;}
 .chain.three{grid-template-columns:repeat(3,1fr);}
 @media(max-width:900px){.chain,.chain.three{grid-template-columns:1fr 1fr;}}
 figure{margin:0;background:var(--card);border:1px solid var(--line);border-radius:9px;overflow:hidden;}
 figure.good{border:2px solid var(--ok);} figure.bad{border:2px solid var(--acc);}
 figure img{width:100%;display:block;background:#8f8f8f;}
 figcaption{padding:9px 11px;font-size:12.5px;color:var(--mut);} figcaption b{color:var(--fg);display:block;}
 .note{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:13px 17px;margin:14px 0 0;font-size:14px;}
 .note.bad{border-left:3px solid var(--acc);} .note.good{border-left:3px solid var(--ok);}
 table{border-collapse:collapse;width:100%;margin-top:26px;background:var(--card);border:1px solid var(--line);border-radius:8px;overflow:hidden;font-size:14px;}
 td,th{padding:9px 12px;border-bottom:1px solid var(--line);text-align:left;} th{color:var(--mut);font-weight:600;}
</style>
<div class="wrap">
<h1>Where the composite actually breaks</h1>
<p class="lede">Two pages, every stage side by side. The failure is not where I said it was.</p>
<div class="verdict"><b>The paste step is good. The blend destroys it.</b> On the reference page the paste produced correct depth — and the blend then enlarged the background figure to foreground size and moved another. On the dragon page the blend did the opposite: it changed nothing but the weather.</div>

<h2>Kapellbrücke p6 — the page that is supposed to work</h2>
<p class="sub">Depth spread 2.77×, the healthiest case in the set. Read left to right.</p>
<div class="chain">
 <figure><img src="${pick(fa,'p6-00-',A)}"><figcaption><b>0 · shipped</b>direct render</figcaption></figure>
 <figure class="good"><img src="${pick(fa,'p6-01-',A)}"><figcaption><b>1 · ghost plate</b>real depth: red tiny on the bridge, green + blue large on the promenade. Poses too — a raised arm, a hand on the hip.</figcaption></figure>
 <figure class="good"><img src="${pick(fa,'p6-03-',A)}"><figcaption><b>3 · pasted, pre-blend</b>depth still correct. The man in yellow is small and cut off by the parapet — genuinely behind it.</figcaption></figure>
 <figure class="bad"><img src="${pick(fa,'p6-99-',A)}"><figcaption><b>final, after blend</b>the man in yellow is now nearly foreground-sized and crouching on the railing. The older man has been moved right and enlarged. Depth gone.</figcaption></figure>
</div>
<div class="note bad"><b>The blend resized and relocated figures</b> — precisely what its prompt forbids. It is not a cosmetic pass here; it re-staged the scene and undid the composite's only job.</div>

<h2>Das Ei im Wurzelnest p17 — the dragon page</h2>
<p class="sub">Same pipeline, opposite failure.</p>
<div class="chain three">
 <figure class="good"><img src="${pick(fb,'p17-00-',B)}"><figcaption><b>shipped</b>boys turned toward the dragon, Julian sitting at the nest looking at the glowing egg. Tells the story.</figcaption></figure>
 <figure class="bad"><img src="${pick(fb,'p17-01-',B)}"><figcaption><b>ghost plate</b>dragon painted (the fix works) — but three identical frontal blobs in a row, and the egg is gone.</figcaption></figure>
 <figure class="bad"><img src="${pick(fb,'p17-99-',B)}"><figcaption><b>final, after blend</b>rain, wet shirts, splashes. Same lineup, same camera-facing smiles. Nobody watches the dragon.</figcaption></figure>
</div>
<div class="note bad"><b>Here the blend did nothing structural at all</b> — only weather. The lineup was baked in by the plate and nothing downstream could repair it.</div>

<table>
<tr><th>stage</th><th>p6 (good depth)</th><th>p17 (no depth)</th></tr>
<tr><td>ghost plate</td><td>correct — depth and poses</td><td>bad — flat lineup, required object lost</td></tr>
<tr><td>paste</td><td>correct — depth preserved</td><td>faithful to a bad plate</td></tr>
<tr><td>blend</td><td><b>wrecks it</b> — resizes + moves</td><td><b>inert</b> — cosmetics only</td></tr>
<tr><td>vs shipped</td><td>worse</td><td>worse</td></tr>
</table>
</div>`;
fs.writeFileSync('scripts/analysis/_tmp_blame.html',html);
console.log('written');
