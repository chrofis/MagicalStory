const fs = require('fs');
const b64 = f => 'data:image/jpeg;base64,' + fs.readFileSync(f).toString('base64');
const pick = (d, pre) => { const f = fs.readdirSync(d).find(x => x.startsWith(pre)); return f ? d + '/' + f : null; };

const html = `<title>Composite Proof Suite</title>
<style>
:root{--bg:#fbfbfa;--fg:#1c1b19;--mut:#6d6a65;--line:#e3e0da;--card:#fff;--acc:#b4442e;--ok:#2f6f4e;--warn:#8a6d1f;}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#171614;--fg:#eceae6;--mut:#a09b93;--line:#302d29;--card:#201e1b;--acc:#e07a5f;--ok:#6aa87f;--warn:#c9a227;}}
:root[data-theme="dark"]{--bg:#171614;--fg:#eceae6;--mut:#a09b93;--line:#302d29;--card:#201e1b;--acc:#e07a5f;--ok:#6aa87f;--warn:#c9a227;}
body{background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;padding:34px 24px 90px;}
.wrap{max-width:1240px;margin:0 auto;} h1{font-size:27px;margin:0 0 6px;letter-spacing:-.02em;}
h2{font-size:19px;margin:36px 0 12px;padding-top:16px;border-top:1px solid var(--line);}
.lede{color:var(--mut);max-width:80ch;margin:0 0 18px;}
.verdict{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--ok);border-radius:8px;padding:15px 20px;margin:0 0 12px;font-size:14.5px;}
.verdict.warn{border-left-color:var(--warn);}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(290px,1fr));gap:16px;margin:14px 0;}
figure{margin:0;background:var(--card);border:1px solid var(--line);border-radius:9px;overflow:hidden;}
figure.good{border:2px solid var(--ok);} figure.bad{border:2px solid var(--acc);} figure.warn{border:2px solid var(--warn);}
figure img{width:100%;display:block;} figcaption{padding:10px 12px;font-size:12.5px;color:var(--mut);}
figcaption b{color:var(--fg);display:block;}
table{border-collapse:collapse;width:100%;font-size:13.5px;margin:12px 0;}
th{text-align:left;color:var(--mut);font-weight:600;padding:6px 10px;border-bottom:2px solid var(--line);}
td{padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top;}
code{background:var(--line);padding:1px 5px;border-radius:3px;font-size:12px;}
.p{color:var(--ok);font-weight:700;} .f{color:var(--acc);font-weight:700;}
</style>
<div class="wrap">
<h1>Proof: the composite can work — and where it still stops</h1>
<p class="lede">Five paid runs on the rewritten pipeline (exps 848, 851, 853, 854, 855 — ~$0.24 total, all on staging commit <code>8c1baa51</code>, none interrupted). Every stage is now proven individually in paid runs; the full chain is proven once, end to end.</p>

<div class="verdict"><b>Proven end to end (exp 851):</b> plate with 3.83× real depth → refusal gates passed → paste at measured heights with occlusion clipping → blend v2 brought the figures to life while holding framing, cast and depth. The finished frame is the first in the composite's history that improves the paste without destroying anything.</div>
<div class="verdict warn"><b>The remaining bottleneck is a single number.</b> Three of today's five runs refused because the plate painted depth spread of 1.48× / 1.68× / <b>1.96×</b> against the 2.0× gate (<code>MIN_DEPTH_SPREAD</code>). The plates DO paint depth — B's background figures are visibly smaller and deeper — just not 2× on flat-ground scenes. 1.96× is four hundredths short. Whether that gate is calibrated right is now the composite's whole story.</div>

<h2>1 · The full chain works — exp 851 (Kapellbrücke, realistic)</h2>
<div class="grid">
  <figure class="bad"><img src="${b64('scripts/analysis/_tmp_848/v99-FINAL-blended.jpg')}"><figcaption><b>before: exp 848, old blend prompt</b>duplicate figure + re-framed shot</figcaption></figure>
  <figure><img src="${b64('scripts/analysis/_tmp_e851/3_avatar_cut_outs_pasted_raw_pre_blend_.jpg')}"><figcaption><b>paste (pre-blend)</b>Daniel 117px of 176px, behind the parapet</figcaption></figure>
  <figure class="good"><img src="${b64('scripts/analysis/_tmp_e851/FINAL.jpg')}"><figcaption><b>after: blend v2, 1635 chars</b>one Daniel, framing + depth held, figures alive</figcaption></figure>
</div>

<h2>2 · The plate now stages what the page wrote — exp 855 (dragon page)</h2>
<div class="grid">
  <figure class="bad"><img src="${b64('scripts/analysis/_tmp_c69/p17-01-1_plate_with_colour_silhouette.jpg')}"><figcaption><b>before: exp 69</b>three identical frontal blobs ignoring the dragon; action never reached the prompt (compound key bug), pose always threeQuarter (dead field)</figcaption></figure>
  <figure class="good"><img src="${b64('scripts/analysis/_tmp_e855/1_plate_with_colour_silhouettes_run_abor.jpg')}"><figcaption><b>after: exp 855</b>the three boys in profile, clustered, WATCHING the dragon — "watching the dragon" reached the prompt 3/3, eye dots on the dragon-side of each head. Refused later at 1.68× spread (Julian painted near the boys' size), so the direct render shipped — correctly.</figcaption></figure>
</div>

<h2>3 · Back views resolve and render — exp 854 (pixar page)</h2>
<div class="grid">
  <figure class="good"><img src="${b64('scripts/analysis/_tmp_e854/1_plate_with_colour_silhouettes_run_abor.jpg')}"><figcaption><b>exp 854 plate</b>three declared back-view background characters painted as backs of heads (no eye dots), smaller and deeper in the river; two foreground kids face the camera with two dots each. Refused at 1.96× — four hundredths under the 2.0× gate.</figcaption></figure>
</div>

<h2>4 · The scorecard</h2>
<table>
<tr><th>run</th><th>page</th><th>outcome</th><th>what it proved</th></tr>
<tr><td>848</td><td>Kapellbrücke p6, realistic</td><td><span class="f">blend FAIL</span> (old prompt)</td><td>3ad9e1a12 held; 5451-char prompt duplicated + re-framed through its own prohibitions</td></tr>
<tr><td>851</td><td>same page</td><td><span class="p">PASS end to end</span></td><td>blend v2 (1635 chars): framing, cast, depth all held</td></tr>
<tr><td>853</td><td>watercolor 5-char</td><td>refused 1.48×</td><td>refusal evidence kept (plates + spread + reason); no fabricated direction</td></tr>
<tr><td>854</td><td>pixar back-view</td><td>refused 1.96×</td><td>pose resolver live: back → back-of-head in pixels; near-threshold refusal</td></tr>
<tr><td>855</td><td>dragon p17</td><td>refused 1.68×</td><td>compound action + creature + profile poses all in the plate, visibly</td></tr>
</table>

<h2>5 · What this adds up to</h2>
<div class="verdict"><b>Yes — the composite can work.</b> Every fix logged this week is now proven in paid runs: the cast resolves poses from real metadata, group actions reach every member, creatures enter through the plate, refusals keep their evidence, and the blend no longer destroys the paste. The chain has produced one finished frame that is better than its input.</div>
<div class="verdict warn"><b>What decides whether it ever ships a page: the 2.0× depth gate.</b> Plates on flat-ground scenes paint real but moderate depth (1.5–2×), and the gate refuses them all — including a 1.96×. That threshold was set to only correct DRAMATIC depth failures, and refusing is safe (the direct render ships). But at 2.0× the composite will fire on architectural-depth pages almost exclusively. Calibrating it is an owner decision, not a bug fix.</div>
</div>`;
fs.writeFileSync('scripts/analysis/_tmp_proof_report.html', html);
console.log('written', (html.length / 1e6).toFixed(1), 'MB');
