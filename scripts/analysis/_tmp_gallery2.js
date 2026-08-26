const fs=require('fs'); const SP=process.env.SP;
const { extractSceneMetadata } = require('../../server/lib/sceneMetadata');
const VERDICT={
 'staging-1':['BAD','map face-on to camera; gibberish lettering on the crates; both women standing in the river'],
 'staging-3':['MIXED','notebook staged correctly (eyes down, angled); the map beside it is flat to camera'],
 'staging-4':['BAD','"Goldene Möwe" lettered on the hull; map face-on; 3 of 4 wave/smile at camera, only one flinches; boat too small for its crew'],
 'staging-5':['BAD','map fills the frame face-on with a painted legible title "Fiona\u2019s Schatzkarte" + gibberish script'],
 'staging-6':['BAD','map flat to camera plus a second sheet of dense fake handwriting with a heading; two documents presented at once'],
 'staging-11':['BAD','one declared rope rendered three times; a woman stands waist-deep in water; the removed second action left the scene without a subject'],
 'staging-13':['BAD','brief said "angled toward herself" — rendered flat to the viewer anyway'],
 'staging-14':['BAD','notebook face-on with fake script; declared action was "reading the notebook" and neither woman reads it'],
 'staging-16':['BAD','hand-off is a shapeless slab with merged hands; 3 figures drawn, 2 declared; all smiling at camera'],
 'prod-3':['BAD','one declared book rendered as two, both face-on to the viewer'],
 'prod-7':['BAD','2 of 4 boys drawn; the dragon-actor row was dropped by the sanitizer so the page had no action left; reaching arm goes nowhere'],
 'prod-9':['BAD','both boys grin at the camera with the book face-out — the brief correctly staged them reading it'],
 'prod-13':['MIXED','boy reads his page correctly; the museum panel behind is covered in fake paragraph text'],
 'prod-15':['GOOD','backs turned, one action, no camera address — but only 3 of 4 boys'],
 'prod-18':['MIXED','strong image; the "holding hands" row was dropped so nobody holds hands; 3 of 4 boys; 3 dragons'],
};
let rows='';
for (const [f,title] of [['staging','Kapitänin Fiona und die Karte ohne Küste (staging, 16pp)'],['prod','Levin und der Drache vom Berg (prod, 18pp)']]) {
  const j=JSON.parse(fs.readFileSync(`${SP}/${f}.json`,'utf8'));
  rows+=`<h2>${title}</h2><div class=grid>`;
  for (const p of (j.data.sceneImages||[])) {
    const md=p.sceneMetadata||extractSceneMetadata(p.sceneDescription||'');
    const ints=(md&&md.interactions)||[];
    const acts=[...new Set(ints.map(i=>String(i.action||'').trim().toLowerCase()).filter(a=>a&&!['watching','standing'].includes(a)))];
    const hands=ints.filter(i=>i.hands===true).length;
    const v=VERDICT[`${f}-${p.pageNumber}`];
    const file=`img/${f}-p${String(p.pageNumber).padStart(2,'0')}.jpg`;
    rows+=`<figure class="${v?v[0]:'NR'}"><img src="${file}" loading=lazy>
      <figcaption><b>p${p.pageNumber}</b> <span class=tag>${v?v[0]:'not inspected'}</span>
      <div class=act>action: <i>${acts.join(' + ')||'(none declared)'}</i> &middot; ${ints.length} rows &middot; ${hands} hands-on &middot; score ${p.finalScore}</div>
      ${v?`<div class=note>${v[1]}</div>`:''}
      <details><summary>page text</summary><p>${String(p.text||'').replace(/</g,'&lt;').slice(0,400)}</p></details>
      </figcaption></figure>`;
  }
  rows+='</div>';
}
fs.writeFileSync(`${SP}/gallery.html`, `<!doctype html><meta charset=utf-8><title>Two books, 2026-08-23</title>
<style>body{font:15px/1.5 system-ui;margin:24px;background:#faf9f7;color:#222}h1{margin:0 0 4px}
.lead{background:#fff3cd;border-left:4px solid #e0a800;padding:12px 16px;margin:16px 0;border-radius:4px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:18px}
figure{margin:0;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px #0002;border-top:5px solid #ccc}
figure.BAD{border-top-color:#d33}figure.MIXED{border-top-color:#e0a800}figure.GOOD{border-top-color:#2a2}
img{width:100%;display:block}figcaption{padding:10px 12px}
.tag{font-size:11px;padding:2px 7px;border-radius:10px;background:#eee}
.BAD .tag{background:#fdd}.MIXED .tag{background:#fef0c8}.GOOD .tag{background:#dfd}
.act{font-size:12px;color:#666;margin:5px 0}.note{font-size:13px;color:#900;margin-top:5px}
details{margin-top:7px;font-size:12px;color:#555}</style>
<h1>Two books generated 2026-08-23 evening</h1>
<div class=lead><b>Every score in both books is meaningless.</b> <code>evaluateImageQuality</code> threw on entry
for this whole window (TDZ bug, fixed in <code>ddbfcf173</code>), so no page was ever scored or repaired.
The verdicts below are my own inspection, not the pipeline's.</div>
${rows}`);
console.log('written');
