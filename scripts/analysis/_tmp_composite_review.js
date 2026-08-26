const fs = require('fs');
const b64 = f => 'data:image/jpeg;base64,' + fs.readFileSync(f).toString('base64');

const ledger = [
  // layer, issue, fix, state: done | partial | open, verification
  ['Gate', 'Fired on four people on one boat — the outline declared `background` on a 4-metre deck; the picture was right, the metadata wrong', 'scene-review 6c: one shared surface = one depth (`cd7de874f`)', 'done', 'Next pirate story declared zero mixed-depth boat pages — right shape, one story'],
  ['Gate', '`SHARED_VESSEL_RE` misses "deck"/"bow"', 'Left alone — owner chose the writer layer; SETTLED says don\'t grow the trigger', 'done', 'By decision, not omission'],
  ['Gate', 'Push gate reads a cancelled-but-still-executing experiment as idle — a deploy can kill live work (plausible mechanism for exps 824/832)', 'None — needs owner sign-off, it changes what blocks a production push', 'open', 'Measured 2026-08-25: exp 847 cancelled, heartbeat 0m, gate said idle, POST 409\'d (#29)'],
  ['Evidence', 'An abort discarded the plates it had already paid for (Lab)', 'save-on-abort (`01f280789`)', 'done', 'Fiona p14: refused run kept its 5-silhouette plate'],
  ['Evidence', 'Production stored ZERO composite_* rows ever — on success as well as abort; the writer existed and was never called', 'attach debug on both branches (`14bcc6330`)', 'partial', 'Offline spy-test ✓; end-to-end proof = next gate-true production page'],
  ['Evidence', '`compositeOutcome` (the "why") dropped by the save whitelist — cost three stories\' forensics', 'restored at both rebuild sites (`c083dd396`); `preScaleRepairImage` deliberately NOT restored (base64→JSONB, already a version)', 'partial', 'Offline ✓; live proof = next story'],
  ['Cast', 'A VB secondary character aborted the whole cast ("cast empty" killed the page)', 'VB sheet fallback + token-subset name match (`e0ecca065`)', 'done', 'Exp 69: Rossa in the plate; exp 851 cast built clean'],
  ['Cast', 'Walk-on with no avatar AND no VB sheet (crew member)', 'Falls through to the direct render — deliberate', 'open', 'Sub-case, owner\'s call'],
  ['Cast', 'Pose read from `sc.pose`, which beats never writes → every figure threeQuarter', 'shared `resolveCellPose` (`143ed6f05`) — front/side/back only, no facing derived', 'done', 'Offline 8 perspectives ✓; exp 848 confirmed correct fallback (p6 has no perspective at all)'],
  ['Cast', 'Compound interaction key ("A + B + C") fed nobody — the group lost its action', 'split on +, &, comma, and/und/et (`143ed6f05`)', 'done', 'Offline 7 cases incl. Alexander/Sandy non-splits'],
  ['Cast', 'Fabricated "facing left" from a flip flag nothing sets', 'direction removed everywhere; flip stays gone (owner directive)', 'done', 'Exp 851 prompt carries no direction'],
  ['Plate', 'VB creatures never reached the plate — the dragon vanished', '`resolveSceneCreatures` → plate creature block (`00d05532c`)', 'done', 'Exp 69: dragon painted in the plate'],
  ['Plate', '`objects[]` never reaches the plate prompt — PRIORITY 1 promises "every required object" with no source; the egg was lost', 'None — needs its own section inside the 8000-char budget', 'open', 'Backlog; the one remaining build item'],
  ['Plate', 'Flat frontal lineup ignoring the brief', 'Causes were the three cast bugs above', 'partial', 'Root causes fixed + offline-verified; no paid plate re-run on a page with perspectives and a group action yet'],
  ['Blend', 'Occlusion clause demanded "full height" while the same prompt said "small and distant"', 'size-neutral clause (`3ad9e1a12`)', 'done', 'Exp 848: no enlargement onto the occluder — the fix held'],
  ['Blend', 'Duplicated the occluded figure AND re-framed — both explicitly forbidden in the prompt that did it (#30)', 'v2: one positive description, 1635 chars, no DO-NOT block (`8c1baa515`)', 'done', 'Exp 851: ONE Daniel, framing held, depth held. One run, one page'],
  ['Blend', 'THE SCENE cut mid-word by a blind `.slice(0,900)` with 2549 chars of headroom', 'overview dropped entirely — removed by construction', 'done', 'v2 prompt complete at 1635 chars'],
  ['Blend', 'Prompt cited a "labelled portrait grid" never attached on that page', 'DO-NOT block dropped — reference removed by construction', 'done', 'Exp 851 prompt clean'],
  ['Blend', '"cinematic composition" (generation style paragraph) inside a prompt that must not re-frame', '`_blendStyleLine` prefers the short blend map + `realistic` entry added', 'done', 'Exp 851 prompt: photograph line, no composition language'],
];

const counts = { done: 0, partial: 0, open: 0 };
ledger.forEach(l => counts[l[3]]++);

const stateTag = { done: ['FIXED', 'ok'], partial: ['FIXED, PROOF PENDING', 'mid'], open: ['OPEN', 'no'] };

const rows = ledger.map(l => `<tr class="${l[3]}">
  <td class="layer">${l[0]}</td>
  <td>${l[1]}</td>
  <td>${l[2]}</td>
  <td><span class="tag ${stateTag[l[3]][1]}">${stateTag[l[3]][0]}</span><div class="ver">${l[4]}</div></td>
</tr>`).join('');

const html = `<title>Composite Pipeline Review</title>
<style>
:root{--bg:#fbfbfa;--fg:#1c1b19;--mut:#6d6a65;--line:#e3e0da;--card:#fff;--acc:#b4442e;--ok:#2f6f4e;--warn:#8a6d1f;}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#171614;--fg:#eceae6;--mut:#a09b93;--line:#302d29;--card:#201e1b;--acc:#e07a5f;--ok:#6aa87f;--warn:#c9a227;}}
:root[data-theme="dark"]{--bg:#171614;--fg:#eceae6;--mut:#a09b93;--line:#302d29;--card:#201e1b;--acc:#e07a5f;--ok:#6aa87f;--warn:#c9a227;}
body{background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;padding:34px 24px 90px;}
.wrap{max-width:1240px;margin:0 auto;} h1{font-size:27px;margin:0 0 6px;letter-spacing:-.02em;}
h2{font-size:19px;margin:36px 0 12px;padding-top:16px;border-top:1px solid var(--line);}
.lede{color:var(--mut);max-width:80ch;margin:0 0 18px;}
.verdict{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--ok);border-radius:8px;padding:16px 20px;margin:0 0 10px;font-size:14.5px;}
.verdict.warn{border-left-color:var(--warn);}
.tally{display:flex;gap:12px;margin:14px 0 24px;}
.tally div{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 18px;font-size:13px;color:var(--mut);}
.tally b{display:block;font-size:22px;color:var(--fg);}
table{border-collapse:collapse;width:100%;font-size:13px;}
th{text-align:left;color:var(--mut);font-weight:600;padding:6px 10px;border-bottom:2px solid var(--line);}
td{padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top;}
td.layer{font-weight:700;white-space:nowrap;}
.tag{display:inline-block;font-size:10px;font-weight:700;letter-spacing:.04em;padding:2px 7px;border-radius:99px;color:#fff;}
.tag.ok{background:var(--ok);} .tag.mid{background:var(--warn);} .tag.no{background:var(--acc);}
.ver{color:var(--mut);font-size:12px;margin-top:4px;}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px;margin:14px 0;}
figure{margin:0;background:var(--card);border:1px solid var(--line);border-radius:9px;overflow:hidden;}
figure.good{border:2px solid var(--ok);} figure.bad{border:2px solid var(--acc);}
figure img{width:100%;display:block;} figcaption{padding:10px 12px;font-size:12.5px;color:var(--mut);}
figcaption b{color:var(--fg);display:block;}
code{background:var(--line);padding:1px 5px;border-radius:3px;font-size:12px;}
ul{margin:8px 0;padding-left:22px;} li{margin:5px 0;}
</style>
<div class="wrap">
<h1>The composite, reviewed end to end</h1>
<p class="lede">Every issue logged across the composite work, its fix, and what actually proves it — closing with exp 851, the first run in the pipeline's history where the blend improved the paste without destroying anything.</p>

<div class="tally">
  <div><b>${counts.done}</b>fixed &amp; verified</div>
  <div><b>${counts.partial}</b>fixed, final proof pending</div>
  <div><b>${counts.open}</b>open</div>
  <div><b>0</b>composited pages ever shipped to a user</div>
</div>

<h2>Exp 851 — the decisive run ($0.06, no restart)</h2>
<div class="grid">
  <figure class="bad"><img src="${b64('scripts/analysis/_tmp_848/v99-FINAL-blended.jpg')}"><figcaption><b>exp 848 — old prompt, 5451 chars</b>Two Daniels, camera pulled in, bridge and tower cropped away. Both failures explicitly forbidden in the prompt that produced them.</figcaption></figure>
  <figure><img src="${b64('scripts/analysis/_tmp_e851/3_avatar_cut_outs_pasted_raw_pre_blend_.jpg')}"><figcaption><b>exp 851 — paste, pre-blend</b>Daniel 117px of a 176px figure, <code>head+occluded</code>, behind the parapet. The blend's job: bring this to life without touching it.</figcaption></figure>
  <figure class="good"><img src="${b64('scripts/analysis/_tmp_e851/FINAL.jpg')}"><figcaption><b>exp 851 — new prompt, 1635 chars</b>ONE Daniel, engaged with the railing at background size. Framing, cast and depth all held. Gaze targets only partially landed (Sarah not clearly on the water, Hans not clearly on Sarah).</figcaption></figure>
</div>

<h2>The ledger</h2>
<table>
<tr><th>layer</th><th>issue</th><th>fix</th><th>state</th></tr>
${rows}
</table>

<h2>Is it good enough?</h2>
<div class="verdict"><b>As the insurance SETTLED says it is: yes.</b> The bar on record is "better than scale repair" — which fired 42 times in 30 days and left nothing — not "better than the direct render". The pipeline now works end to end in the Lab, refuses correctly when the declared depth is not real, keeps its evidence when it refuses, records its outcome in production, and the blend no longer destroys what the paste got right. The gate fires rarely by design, and the one systematic false trigger (shared vessels) is fixed at its source.</div>
<div class="verdict warn"><b>As a proven feature: not yet — three gaps, all cheap to close.</b>
<ul>
<li><b>Blend v2 is one clean run on one page.</b> The two regression pages the plan names (<code>job_1786567053374</code> p4, <code>job_1786571353564</code> p10 — good pages under the old prompt) have not been re-run. ~$0.12 settles whether v2 regresses them.</li>
<li><b>The <code>objects[]</code> gap is the last real build item.</b> A prop-bearing depth page still loses its required objects — the plate prompt promises them with no source. Until then, composited pages are only safe when the props live in the empty-scene prose.</li>
<li><b>No production page has ever gone through end to end.</b> Every fix is Lab-proven; the next gate-true story page is the real test, and since <code>14bcc6330</code> + <code>c083dd396</code> it will document itself either way.</li>
</ul></div>
<p class="lede">Open decisions for the owner: the push-gate blind spot (#29 — a cancelled-but-executing experiment reads idle, changing it changes what blocks prod pushes), and whether the no-avatar-no-VB walk-on should keep falling through to the direct render.</p>
</div>`;

fs.writeFileSync('scripts/analysis/_tmp_composite_review.html', html);
console.log('written', (html.length / 1e6).toFixed(1), 'MB');
