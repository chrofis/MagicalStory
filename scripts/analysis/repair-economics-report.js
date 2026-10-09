// Builds the phone-width HTML report for the repair-economics analysis from result JSONs + visual verdicts.
// Usage: node repair-economics-report.js result.json result_C.json samples.json out.html
const fs = require('fs');
const [, , allF, cF, sampF, outF] = process.argv;
const A = JSON.parse(fs.readFileSync(allF)), C = JSON.parse(fs.readFileSync(cF)), S = JSON.parse(fs.readFileSync(sampF));
// Reviewer verdicts from LOOKING at the original image next to the finding text (single reviewer, prompt not visible).
// T = finding is a real defect a reader would see; N = nit / judge noise (laterality, tiny detail, wrong person); B = borderline.
const V = {
  '25b31uqlp_p9': ['N', 'two toddlers cross a log; gaze direction is ambiguous, nothing a reader would notice'],
  '622wecmhj_p18': ['T', 'four boys all smile at the viewer; nobody grips the dragon ridges'],
  'xqmtk2gcs_p6': ['T', 'girl stands with hands at her sides, the turnip is held by the boy'],
  '2ir6nl5kw_p12': ['N', 'Max looks down at the egg; the judge says he looks at the dragon'],
  '9erw6xc01_p4': ['T', 'holds a coiled rope, nobody points at a hat'],
  'zly5rcdej_p15': ['N', 'girl is reaching for the cap with both hands; "gripping vs reaching" is a nit'],
  '311ykfmin_p14': ['T', 'map is held, not tucked under the arm (minor)'],
  '2ir6nl5kw_p15': ['N', 'egg is against the dragon already; "pressing" is a nit'],
  'fedxinwqd_p14': ['N', 'mouth is slightly open; "surprised" is the same expression'],
  'l43qgl34w_p9': ['N', 'lantern hangs next to the chest lock; shoulder strap vs lock is not readable'],
  'vxnu60yjg_p14': ['N', 'the OTHER arm is raised (left/right mirror); the picture reads correctly'],
  'dka3jpog9_p11': ['T', 'the scale is held in view, the brief says out of view'],
  'xqmtk2gcs_p10': ['N', 'pale carved turnip with a candle; the judge calls it a pumpkin'],
  '70901tfsn_p16': ['T', 'chest open and full of coins, brief says closed'],
  '9erw6xc01_p13': ['T', 'rope hangs intact, brief says severed'],
  '9mr11xszu_p12': ['T', 'blue cloth in the chest, logbook is in her hands (minor)'],
  'kc2joi4ax_p11': ['T', 'cat sits inside a cracked shell, brief says on top of an intact egg'],
  'apslnsq1z_p18': ['N', 'yellow hoodie and jeans is the child\'s own outfit; judge calls it off-style'],
  '622wecmhj_p18c': ['N', 'four boys, "lead boy" cannot be identified; nothing visibly wrong'],
  'wkt20ckod_p18': ['N', 'quilted gilet is there; puffer vs gilet is a nit'],
  'vu132n7je_p3': ['N', 'dark boots with cuffs; black vs dark brown is a nit'],
  'p08djwhbl_p8': ['B', 'mottled green jacket, watercolour texture reads slightly camouflage'],
  'z9bwoo3yp_p3': ['T', 'adult looks 35-40 not 25 (age drift; also reference thumbnails painted at bottom right)'],
  'wkt20ckod_p11': ['N', 'toddler, 2 vs 3 years is not judgeable'],
  '9mr11xszu_p2': ['T', 'adult looks about 40 (and a white band on the left edge, not flagged)'],
  '622wecmhj_p13': ['N', 'the image is a raven and one hand; there is no character to age'],
  'rts4wqupm_p9': ['N', 'curly light-brown vs blonde wavy is not distinguishable'],
  'i9ah2221i_p10': ['N', 'davit arm and stern rail are in the frame'],
  'fedxinwqd_p16': ['N', 'picture is a steep grassy hillside, which is what the brief asks'],
  'csjcyp1q9_p16': ['T', 'plain cream wall, no window or skyline'],
  'atbttop6w_p9': ['T', 'no staircase at the end of the path'],
  '6ew0y1kae_p16': ['T', 'landmark fountain is not identifiable'],
  'l5dyf4k8g_p3': ['T', 'hook is there, telescope is not'],
  '70901tfsn_p3': ['N', 'red hull stripe is visible (reference thumbnails painted at the bottom, not flagged)'],
  'zly5rcdej_p10': ['T', 'close-up of the girl, no crowd'],
  '9oxos7dwv_p8': ['T', 'a hatched dragon where the brief shows the egg'],
  'iqvhj4l8m_p6': ['T', 'signpost is blank (required lettering the model cannot spell)'],
};
// key clash: 622wecmhj p18 appears for gaze and clothing; the second gets the "c" suffix
const seen = {};
const rows = S.map(c => {
  let k = c.story.slice(-9) + '_p' + c.pn; if (seen[k]) k += 'c'; seen[k] = 1;
  return { ...c, k, v: V[k] || ['?', ''] };
});
const typeKey = r => r.key;
const byType = {};
for (const r of rows) { const t = byType[typeKey(r)] = byType[typeKey(r)] || { n: 0, N: 0, T: 0, B: 0 }; t.n++; t[r.v[0]]++; }
const fp = (a, b) => (b ? Math.round(100 * a / b) + '%' : '-');
const esc = s => String(s).replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
const usd = x => '$' + (+x).toFixed(2);
const pct = (a, b) => (100 * a / b).toFixed(1) + '%';

const t = (head, body, cls = '') => `<div class="tw"><table class="${cls}"><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${body.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;

// ---- tables
const q1all = A.q1.filter(x => x.s === 'major+').sort((a, b) => b.spend - a.spend).slice(0, 12);
const q1C = C.q1.filter(x => x.s === 'major+').sort((a, b) => b.spend - a.spend).slice(0, 8);
const pers = A.persist;
const q1Rows = q1all.map(x => [esc(x.k), x.pagePct + '%', x.trigPages + ' (' + x.trigShareOfRepaired + '%)', usd(x.spend), pers[x.k] ? Math.round(100 * pers[x.k].gone / pers[x.k].n) + '% (n=' + pers[x.k].n + ')' : '-']);
const sevRows = A.q1.filter(x => x.s !== 'major+' && x.s !== '-').sort((a, b) => b.n - a.n).slice(0, 14).map(x => [esc(x.k), x.s, x.n, x.pages + ' (' + x.pagePct + '%)', x.perStory]);
const periodRows = Object.entries(A.q1ByPeriod).map(([k, v]) => [esc(k), v.stories, v.pages, v.majorPlusPct + '%', v.critPct + '%', v.repairedPct + '%', usd(v.repairUsdPerStory), usd(v.storyUsd)]);
const mTop = A.matrix.filter(c => c.findings >= 8 && ['inpaint', 'iterate', 'char-fix'].includes(c.m)).sort((a, b) => b.findings - a.findings).slice(0, 30);
const mRows = mTop.map(c => [esc(c.k), c.m, c.attempts, c.findings, c.gonePct + '%', c.meanDelta, c.shipPct + '%', c.newMajPerAttempt, c.costPerFix == null ? '-' : '$' + c.costPerFix.toFixed(3), c.costPerShippedFix == null ? '-' : '$' + c.costPerShippedFix.toFixed(3), c.critN ? c.critFix + '/' + c.critN : '-']);
const mCRows = C.matrix.filter(c => c.findings >= 6 && ['inpaint', 'iterate', 'char-fix'].includes(c.m)).sort((a, b) => b.findings - a.findings).slice(0, 14).map(c => [esc(c.k), c.m, c.attempts, c.findings, c.gonePct + '%', c.meanDelta, c.shipPct + '%', c.newMajPerAttempt, c.costPerFix == null ? '-' : '$' + c.costPerFix.toFixed(3), c.costPerShippedFix == null ? '-' : '$' + c.costPerShippedFix.toFixed(3)]);
const methRows = (R) => R.methods.filter(m => ['inpaint', 'iterate', 'char-fix', 'garment-recolour', 'scale-repair', 'style-repair', 'text-space'].includes(m.method)).map(m => [m.method, m.att, m.shipPct + '%', m.improvedPct + '%', m.worsePct + '%', m.meanDelta, m.fixGonePct + '%', m.critBefore ? m.critGone + '/' + m.critBefore : '-', (m.newMaj / m.att).toFixed(2), usd(m.cost), usd(m.wasteCost), m.costPerShippedFix ? '$' + m.costPerShippedFix.toFixed(3) : '-']);
const wasteRows = (R, S_) => { const w = R.waste, n = R.meta.stories, T = R.meta.totalCost; return [
  ['All repair attempts (pages)', w.attempts, usd(w.totalRepairCost), usd(w.totalRepairCost / n), pct(w.totalRepairCost, T)],
  ['Attempts that never shipped', w.neverShipN, usd(w.neverShipCost), usd(w.neverShipCost / n), pct(w.neverShipCost, T)],
  ['Pages repaired where the ORIGINAL shipped anyway', w.repairedBestOrig + ' of ' + w.repairedPages + ' pages', usd(w.repairedBestOrigCost), usd(w.repairedBestOrigCost / n), pct(w.repairedBestOrigCost, T)],
  ['Attempts that fixed none of its targets AND did not raise the score', w.noFixNoGainN, usd(w.noFixNoGainCost), usd(w.noFixNoGainCost / n), pct(w.noFixNoGainCost, T)],
  ['Round 2+ attempts (' + w.round2plusShipN + ' of ' + w.round2plusN + ' shipped)', w.round2plusN, usd(w.round2plus), usd(w.round2plus / n), pct(w.round2plus, T)],
]; };
const sampleRows = rows.map(r => [esc(r.key.replace('|', ' / ')), r.sev, esc(r.d), r.v[0] === 'T' ? '<b class="ok">real</b>' : r.v[0] === 'N' ? '<b class="no">nit / noise</b>' : '<b>borderline</b>', esc(r.v[1]), r.url ? `<a href="${r.url}">${r.story.slice(-9)} p${r.pn}</a>` : '-']);
const typeRows = Object.entries(byType).map(([k, v]) => [esc(k.replace('|', ' / ')), v.n, v.T, v.B, v.N, fp(v.N, v.n)]);
const totN = rows.filter(r => r.v[0] === 'N').length, totT = rows.filter(r => r.v[0] === 'T').length, totB = rows.filter(r => r.v[0] === 'B').length;

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Repair economics</title>
<style>
:root{--bg:#fff;--fg:#1c1e21;--mu:#5b6270;--ln:#dfe3ea;--ac:#4f46e5;--ok:#0a7d3b;--no:#b42318;--card:#f6f7fb}
@media(prefers-color-scheme:dark){:root{--bg:#14161a;--fg:#e8eaee;--mu:#9aa3b2;--ln:#2a2f39;--ac:#8b86ff;--ok:#4ade80;--no:#f87171;--card:#1b1f27}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,Segoe UI,Roboto,sans-serif;padding:0 16px 48px}
main{max-width:980px;margin:0 auto}h1{font-size:1.5rem;margin:24px 0 4px}h2{font-size:1.2rem;margin:32px 0 8px;border-top:1px solid var(--ln);padding-top:20px}h3{font-size:1rem;margin:20px 0 6px}
p,li{margin:6px 0}.mu{color:var(--mu);font-size:.9rem}.card{background:var(--card);border:1px solid var(--ln);border-radius:10px;padding:12px 14px;margin:12px 0}
.tw{overflow-x:auto;margin:8px 0;border:1px solid var(--ln);border-radius:8px}table{border-collapse:collapse;width:100%;font-size:.82rem}th,td{padding:6px 8px;border-bottom:1px solid var(--ln);text-align:left;vertical-align:top}th{background:var(--card);position:sticky;top:0;white-space:nowrap}td:nth-child(n+2){white-space:nowrap}table.wrap td{white-space:normal!important}
.ok{color:var(--ok)}.no{color:var(--no)}a{color:var(--ac)}.big{font-size:1.5rem;font-weight:700}.kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}.kv div{background:var(--card);border:1px solid var(--ln);border-radius:10px;padding:10px}
</style></head><body><main>
<h1>Why images fail first, and which repair earns its cost</h1>
<p class="mu">${A.meta.stories} full stories (${A.meta.first.slice(0, 10)} to ${A.meta.last.slice(0, 10)}): ${A.meta.byEnv.stg} staging, ${A.meta.byEnv.prod} production-only. ${A.meta.evaluatedPages} pages, ${A.waste.attempts} page repair attempts. Read-only analysis, no paid calls.</p>

<div class="kv">
<div><div class="mu">First renders with a MAJOR or worse finding</div><div class="big">${pct(A.meta.pagesWithMajorPlus, A.meta.evaluatedPages)}</div></div>
<div><div class="mu">First renders with a CRITICAL</div><div class="big">${pct(A.meta.pagesWithCritical, A.meta.evaluatedPages)}</div></div>
<div><div class="mu">Pages sent to repair</div><div class="big">${pct(A.meta.pagesRepaired, A.meta.evaluatedPages)}</div></div>
<div><div class="mu">Repair cost per story</div><div class="big">${usd(A.waste.perStoryRepairCost)}</div><div class="mu">${pct(A.waste.totalRepairCost, A.meta.totalCost)} of ${usd(A.waste.perStoryTotal)}</div></div>
<div><div class="mu">Of that, never shipped</div><div class="big">${usd(A.waste.perStoryWaste)}</div><div class="mu">${pct(A.waste.neverShipCost, A.meta.totalCost)} of story cost</div></div>
</div>

<div class="card"><b>Answer to the premise.</b> The classification data exists and is good enough: every version stores its findings (type, severity, source), its parent, its method and its score. But repair is only about ${pct(A.waste.totalRepairCost, A.meta.totalCost)} of a story's cost, so even a perfect repair policy saves cents, not dollars. Biggest line items are the text and planning calls (about 57%), page and cover generation (18%) and first-render judging (11%). What the data does show clearly: about half of the top failure reasons are judge noise, and one finding type (action_interaction) is 39 to 74% of all repair spend.</div>

<h2>1. Why first renders fail</h2>
<p>Findings on the ORIGINAL version, page judges plus the entity judge ("E:" prefix). "Trigger" = the page went into repair and carried a MAJOR+ finding of this type; spend is the page's repair cost split evenly across its trigger types.</p>
<h3>By trigger type, all builds, ranked by repair spend</h3>
${t(['type (MAJOR+)', 'pages with it', 'repaired pages triggered', 'repair spend', 'gone after full regenerate'], q1Rows)}
<p class="mu">"Gone after full regenerate" = how often an iterate (fresh render from the same brief) removes the finding. Low values mean the failure repeats from the same brief: a generator limit or a judge that always fires.</p>
<h3>Frequency by type and severity (original version)</h3>
${t(['type', 'severity', 'findings', 'pages (share)', 'per story'], sevRows)}
<h3>The build matters: the compliance judge went off on 2026-09-19</h3>
${t(['build', 'stories', 'pages', 'pages MAJOR+', 'pages CRITICAL', 'pages repaired', 'repair $/story', 'story $'], periodRows)}
<p>Switching the blind compliance judge off (docs/SETTLED.md) cut pages with a MAJOR+ from 83% to 66%, pages repaired from 49% to 36% and repair spend from ${usd(A.q1ByPeriod['B 09-06..09-18'].repairUsdPerStory)} to ${usd(A.q1ByPeriod['C 09-19+ (compliance judge off)'].repairUsdPerStory)} per story. Clothing as a MAJOR+ page finding fell from 30% to 7% of pages and character_identity from 25% to 3.6%. That is already a realised saving of about $0.28 per story and is the best evidence that judge noise, not the generator, drove repair volume. Staging also runs repairMaxPasses=1 and prod 3, so staging understates later rounds.</p>
<h3>Current build only (09-19 on), same view</h3>
${t(['type (MAJOR+)', 'pages with it', 'repaired pages triggered', 'repair spend'], q1C.map(x => [esc(x.k), x.pagePct + '%', x.trigPages + ' (' + x.trigShareOfRepaired + '%)', usd(x.spend)]))}

<h3>Generator or judge? I looked at ${rows.length} originals</h3>
<p>Per top type, 4 to 5 pages (12 for action_interaction, split gaze, hands, posture), drawn at random with a fixed seed from pages that went into repair, one per story. I judged each by looking at the original next to the judge's sentence, without seeing the prompt. <b>${totN} of ${rows.length} (${Math.round(100 * totN / rows.length)}%) were nits or noise</b>, ${totT} real, ${totB} borderline. This is one reviewer, n=4 to 12 per type, so treat each rate as plus or minus 25 points.</p>
${t(['type', 'sampled', 'real', 'borderline', 'nit / noise', 'noise share'], typeRows)}
<p>The noise is of a few repeating kinds: left/right mirror (the other arm is raised), gaze or "gripping vs reaching" detail, an age gap of one year on a toddler, colour or cut of a garment that reads fine, a "character" that is only a hand. The real action_interaction cases are all the generator ignoring an exact hand or object state (holding the wrong thing, empty hands, the object shown in view or out of view) and they repeat on regenerate (28% gone), which fits a brief-level cause. Two images carried reference thumbnails painted into the frame and one a white edge band; none of these were flagged.</p>
<div class="tw"><table class="wrap"><thead><tr><th>type</th><th>sev</th><th>judge said</th><th>my read</th><th>why</th><th>image</th></tr></thead><tbody>${sampleRows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>

<h2>2. Which repair works when</h2>
<p>Per repair attempt: the parent is the best version going into the round. "Gone" = the targeted MAJOR+ finding (same type and name) is absent in the repaired version. Delta = score change vs parent (raw, before the best-version pick). Shipped = that version is the page's bestSource. New MAJOR+ = findings the repair introduced. Costs come from the stories' per-function ledger (see caveats), $ per fix = attempt cost split across its targets / fixes.</p>
<h3>Per method, all builds</h3>
${t(['method', 'attempts', 'shipped', 'score up', 'score down', 'mean delta', 'target gone', 'CRITICAL cleared', 'new MAJOR+ per attempt', 'cost', 'never shipped', '$ per shipped fix'], methRows(A))}
<h3>Per method, current build only (09-19 on)</h3>
${t(['method', 'attempts', 'shipped', 'score up', 'score down', 'mean delta', 'target gone', 'CRITICAL cleared', 'new MAJOR+ per attempt', 'cost', 'never shipped', '$ per shipped fix'], methRows(C))}
<h3>Matrix: trigger type x method, all builds (at least 8 targeted findings)</h3>
${t(['type', 'method', 'attempts', 'findings', 'gone', 'delta', 'shipped', 'new MAJOR+/att', '$ per fix', '$ per shipped fix', 'CRITICAL cleared'], mRows)}
<h3>Matrix, current build only (at least 6 findings)</h3>
${t(['type', 'method', 'attempts', 'findings', 'gone', 'delta', 'shipped', 'new MAJOR+/att', '$ per fix', '$ per shipped fix'], mCRows)}
<ul>
<li><b>action_interaction</b> is never fixed more than 28% of the time over all builds (inpaint 27%, iterate 28%, char-fix 24%). In the current build inpaint does better (42% gone, delta +9.5, 60% shipped, 0.39 new MAJOR+) than iterate (37%, +0.6, 42%, 1.15 new). Only 31 and 62 attempts, selection by the consolidator not randomised.</li>
<li><b>char-fix</b> removes its target 47% of the time but regresses the page score in 55% of attempts (all builds), and introduces 2.4 new MAJOR+ per attempt, mostly identity, hair and face drift. It ships 45%. In the current build it does better (75% shipped, 68% target gone, n=12).</li>
<li><b>iterate</b> introduces the most new findings (2.7 per attempt, 2.5 current build) because the whole page is redrawn; it has the best fix rate on clothing (42%, delta +11.5), setting, missing_element and extra_character (87%).</li>
<li><b>scale-repair</b> (5 attempts, composite): all five lost, mean delta -72, none shipped. <b>style-repair</b> (46) and <b>text-space</b> (8) rarely or never ship, but style-repair versions carry no new score so the data cannot say whether they work.</li>
<li>CRITICAL findings are fully cleared in only 32% of attempts on pages that had one; repairs of pages with parent score below 60 and a CRITICAL ship 55% with a mean gain of +32 (best value); non-critical pages at 60 or above ship 29% (+15).</li>
</ul>

<h2>3. Wasted spend</h2>
<h3>All builds</h3>
${t(['what', 'count', 'cost', 'per story', 'share of story cost'], wasteRows(A))}
<h3>Current build only</h3>
${t(['what', 'count', 'cost', 'per story', 'share of story cost'], wasteRows(C))}
<ul>
<li>Types with no working method (at least 8 findings, gone 30% or less in every method tried): action_interaction (above), style_consistency via inpaint (27%).</li>
<li>Repairs triggered by judge noise: applying the sampled noise share per type (action_interaction 58%, clothing 80%, identity 60%, setting 40%, object_presence 20%, missing_element 20%) to the allocated spend gives about $11 of $32 over 68 stories, roughly $0.16 per story (2.9%). It overlaps with the never-shipped line, so the two are not additive.</li>
<li>Re-judging is a third of each attempt: ${usd(A.meta.reEvalPerVer)} per repaired version against ${usd(A.meta.UNIT.inpaint - A.meta.reEvalPerVer)} for the inpaint image itself.</li>
<li>CRITICAL left on the shipped version: ${A.shipped.withCritShipped} of ${A.shipped.pages} pages (all builds), 59 of 308 in the current build, 34 of those 59 are action_interaction.</li>
</ul>

<h2>4. Recommendations</h2>
<p>Savings are per story, current build, with the story at about ${usd(C.waste.perStoryTotal)}. They do not add up cleanly (overlap).</p>
<div class="card"><b>1. Calibrate action_interaction in the semantic/quality judge prompt. About $0.11 per story (1.8%). NEEDS JUDGE-PROMPT CHANGE, owner sign-off.</b><br>Evidence: it is on 40.6% of current-build pages (MAJOR 27.6%, CRITICAL 17.9%), triggers 72.7% of repaired pages and $3.79 of $9.79 repair spend ($0.19 per story); I read 7 of 12 sampled as noise (mirror, gaze, hand detail); 34 of 308 shipped pages (11%) still carry one as a CRITICAL. Ask for a type ceiling or a "what the reader sees" test for gaze, laterality and hand-grip nuance, as a type plus ceiling in scoring.js per the eval rule. Saving = 58% of $0.19.</div>
<div class="card"><b>2. Re-judge only what the repair targeted. About $0.08 per story (1.3%). Code change to eval scope, owner sign-off advisable.</b><br>Evidence: ${usd(C.meta.reEvalPerVer)} re-eval per repaired version is a third to 40% of an attempt, current build ${C.waste.attempts} attempts x ${usd(C.meta.reEvalPerVer)} = ${usd(C.waste.attempts * C.meta.reEvalPerVer)} or $${(C.waste.attempts * C.meta.reEvalPerVer / C.meta.stories).toFixed(2)} per story; halve it by judging the cited types and the figures touched. Risk: the pick-best compares versions on the full finding list, so a partial re-judge needs the parent's untouched findings carried over.</div>
<div class="card"><b>3. Prevent action_interaction at generation: one exact hand/object state per figure in the brief. About $0.08 per story if the real half is halved. Prompt change in Art Director/image prompt, sign-off.</b><br>Evidence: a regenerate from the same brief removes it only 28% of the time (all builds), so it is the brief, not seed luck. The real cases are hands/objects (holding the wrong thing, empty hands, in view vs out of view). Test in the Lab on the stored pages before shipping; I have not measured it.</div>
<div class="card"><b>4. Route action_interaction to inpaint, never to iterate or char-fix. About $0.02 per story, small quality gain. PURE ROUTING (consolidator's requires_regeneration → iterate; or a type rule in decideRepairMethod).</b><br>Evidence: current build inpaint 42% gone, +9.5, 0.39 new MAJOR+ per attempt vs iterate 37%, +0.6, 1.15 (62 vs 31 attempts); char-fix on this type 24% gone over 47 attempts. Low confidence: the consolidator chose the method.</div>
<div class="card"><b>5. Stop repairing CRITICAL-only pages that score 70 or more, unless the CRITICAL type has a proven fix rate. About $0.03 per story. Reverses the settled 2026-09-04 "CRITICAL forces a redo" ruling: needs the reversal protocol.</b><br>Evidence: 90 attempts on parents scoring 70+ cost $5.51 over 68 stories, shipped 30% with +11 mean gain; the 27 action_interaction CRITICAL attempts among them cleared it 7 times. Moot if recommendation 1 lands. Pure config alternative: raise issueThreshold from 5 (non-critical pages at 60+ ship 29%, $0.05 per story wasted).</div>
<p class="mu">Not recommended: cutting later rounds (round 2+ ships 30% but 35 of its 37 shipped versions improved the page, mean +20); dropping char-fix (settled, and current-build results are good); removing style-repair (cannot be scored from stored data).</p>

<h2>Caveats</h2>
<ul>
<li>Data: 62 staging and 6 prod-only stories, 8+ pages each; 10 prod stories are copies of staging ones and were counted once. Current-build subset is 20 stories and 308 pages, so per-type cells there are 5 to 60 findings.</li>
<li>Staging repairs for one round (prod three), the compliance judge changed on 2026-09-19 and several routing fixes landed between (09-06, 09-24, 09-27, 10-04, 10-07); periods A/B/C are shown, not modelled.</li>
<li>"Gone" is a type and name match against the judge's own next verdict; a repair that makes the judge stop mentioning something counts as success, and a re-worded finding counts as new. Judges are non-deterministic.</li>
<li>Costs: the stories carry per-function totals, not per-attempt prices. Per-method unit costs are the story-ledger totals divided by version counts, plus the average re-judge cost; iterate images are priced at $0.02. Repair cost here is about $0.48 per story, the ledger's repair functions alone total $0.40.</li>
<li>Noise labels are one reviewer without the prompt. Sample is repaired pages only, from all builds.</li>
<li>Covers were not analysed per finding (${A.cover.repairVersions} repair versions in total). style-repair and text-space versions have no new score, so their rows are incomplete.</li>
</ul>
</main></body></html>`;
fs.writeFileSync(outF, html);
console.log('wrote', outF, html.length, 'bytes; noise', totN, '/', rows.length, 'real', totT, 'border', totB, 'unlabelled', rows.filter(r => r.v[0] === '?').length);
