#!/usr/bin/env node
/**
 * Dump the FILLED beats-stage prompt for one story, as an HTML page.
 *
 * The beats prompt is not persisted anywhere, so this rebuilds it by calling
 * the real builder (buildBeatsPrompt) with the story's own stored inputData.
 * Builder options (promptBuilders.js buildBeatsPrompt):
 *   - finalArc:  the arc machine's approved arc. Persisted — recovered from
 *     stories.data.arcReviewReport.finalArc, falling back to the outline's
 *     ---ARC--- section (the pipeline writes the same text there).
 *   - arcHints:  the hint pass on the final arc. Persisted in
 *     arcReviewReport.arcHints; empty when the pass produced none.
 *   - replan:    the one re-divide request the plan check may issue. Always ''
 *     here — this reconstructs the FIRST planning prompt, not the re-plan.
 *
 * The template is read at HEAD; if the story ran before a template change, the
 * reconstruction shows today's template with the story's data (the page header
 * carries the HEAD SHA and the story's run date so you can tell).
 *
 * Usage: node scripts/analysis/dump-beats-prompt.js <storyId> [--env=staging|prod]
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { Pool } = require('pg');
const { ch, fromPgNaive } = require('../lib/chTime');

const storyId = process.argv[2];
const envArg = (process.argv.find(a => a.startsWith('--env=')) || '--env=staging').split('=')[1];
if (!storyId) {
  console.error('usage: node scripts/analysis/dump-beats-prompt.js <storyId> [--env=staging|prod]');
  process.exit(1);
}
const conn = envArg === 'prod' ? process.env.DATABASE_URL : process.env.STAGING_DATABASE_URL;

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

(async () => {
  const pool = new Pool({ connectionString: conn, ssl: { rejectUnauthorized: false } });
  const r = await pool.query('select data, created_at from stories where id=$1', [storyId]);
  await pool.end();
  if (!r.rows.length) { console.error('story not found'); process.exit(1); }
  const d = r.rows[0].data;
  // node-pg parses the naive TIMESTAMP column as local — rehome before formatting.
  const runDate = r.rows[0].created_at ? ch(fromPgNaive(r.rows[0].created_at)) : '(unknown)';

  let headSha = '(unknown)';
  try { headSha = execSync('git rev-parse --short HEAD', { cwd: path.join(__dirname, '../..') }).toString().trim(); } catch { /* not a repo */ }

  // Templates are loaded lazily by the server at boot; a standalone script must
  // load them itself or every builder returns null.
  await require('../../server/services/prompts').loadPromptTemplates();

  const SH = require('../../server/lib/storyHelpers');
  const pageCount = parseInt(d.pages, 10) || (d.sceneImages || []).length || 10;

  const o = d.outline || '';
  const sect = (name) => {
    const s = o.indexOf(`---${name}---`);
    if (s < 0) return '';
    const n = o.indexOf('\n---', s + 5);
    return o.slice(s, n < 0 ? o.length : n);
  };
  // Section body without the ---NAME--- header line, for feeding back into the builder.
  const sectBody = (name) => sect(name).replace(`---${name}---`, '').trim();

  // FINAL_ARC: the arc machine's approved arc, persisted verbatim in
  // arcReviewReport.finalArc (same lookup the Test Lab uses); the outline's
  // ---ARC--- section carries the same text and is the fallback.
  const finalArc = d.arcReviewReport?.finalArc || sectBody('ARC');
  // ARC_HINTS: persisted alongside the arc; empty = the hint pass found nothing
  // (or the story predates the hint pass).
  const arcHints = d.arcReviewReport?.arcHints || '';

  const filled = SH.buildBeatsPrompt(d, pageCount, { finalArc, arcHints, replan: '' });
  if (!filled) { console.error('builder returned null — template not loaded'); process.exit(1); }

  const tplPath = path.join(__dirname, '../../prompts/story-beats.txt');
  const tpl = fs.readFileSync(tplPath, 'utf8');

  const leftovers = [...filled.matchAll(/\{[A-Z_]+\}/g)].map(m => m[0]);

  const panel = (id, t, sub, body) =>
    `<h2 id="${id}">${t}</h2><div class="sub">${sub}</div><pre>${esc(body)}</pre>`;

  const html = `<title>FILLED beats prompt — ${esc(d.title || storyId)}</title>
<style>
:root{--bg:#12141a;--panel:#1b1e26;--line:#2c303b;--txt:#e6e8ee;--dim:#9aa1b1;--acc:#7aa2f7}
*{box-sizing:border-box}
body{margin:0;padding:28px;background:var(--bg);color:var(--txt);font:16px/1.7 -apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:1020px;margin:0 auto}
h1{font-size:24px;margin:0 0 6px}
h2{font-size:18px;margin:34px 0 4px;color:var(--acc);border-bottom:1px solid var(--line);padding-bottom:6px}
.sub{color:var(--dim);font-size:13px;margin-bottom:12px}
pre{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:18px;
    white-space:pre-wrap;font:14px/1.65 ui-monospace,Consolas,monospace;overflow-x:auto}
.toc{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 18px;margin:18px 0}
.toc a{color:var(--acc);text-decoration:none;margin-right:18px}
.note{background:#2a2118;border:1px solid #5a4326;border-radius:10px;padding:14px 18px;
      margin:18px 0;color:#ffd9a8;font-size:14px}
.ok{background:#16241b;border-color:#2c5138;color:#b8e6c4}
</style>
<div class="wrap">
<h1>FILLED beats prompt — <em>${esc(d.title || '')}</em></h1>
<div class="sub"><code>${esc(storyId)}</code> · ${esc(envArg)} · ${pageCount} pages ·
${esc(d.language || '')} · languageLevel <b>${esc(d.languageLevel || '')}</b> ·
storyType ${esc(d.storyType || '')} · run ${esc(runDate)} · rebuilt at HEAD <code>${esc(headSha)}</code></div>

<div class="note ok"><b>This is the real prompt text, every placeholder resolved</b>
(${filled.length.toLocaleString()} chars). Rebuilt by calling the production builder
<code>buildBeatsPrompt(inputData, ${pageCount}, { finalArc, arcHints, replan: '' })</code>
with this story's own stored data — the prompt itself is never persisted, so this is a
faithful reconstruction, not a capture.
<br><br>
<b>FINAL_ARC</b>: ${finalArc ? (d.arcReviewReport?.finalArc
  ? 'recovered from stored <code>arcReviewReport.finalArc</code>.'
  : 'recovered from the outline’s <code>---ARC---</code> section (no arcReviewReport stored).')
  : '<b>not recoverable</b> — no stored arc found; the builder fell back to its no-arc line.'}
<br>
<b>ARC_HINTS</b>: ${arcHints ? 'recovered from stored <code>arcReviewReport.arcHints</code>.'
  : 'empty — the hint pass recorded none (the normal case), so the fix-while-dividing block is absent.'}
<br>
<b>REPLAN_SECTION</b>: always empty here — this is the first planning prompt, not the
optional re-divide.
<br><br>
Unresolved placeholders remaining: ${leftovers.length ? '<b>' + esc(leftovers.join(', ')) + '</b>' : '<b>none</b>'}.
</div>

<div class="note"><b>Template drift warning:</b> the template and builder are read at
HEAD <code>${esc(headSha)}</code>, but this story ran on <b>${esc(runDate)}</b> — if
<code>prompts/story-beats.txt</code> or <code>buildBeatsPrompt</code> changed since, this page
shows today's template filled with the story's data, not the exact prompt the model received.</div>

<div class="toc"><b>Jump:</b>
<a href="#filled">Filled prompt</a>
<a href="#tpl">Raw template</a>
<a href="#arc">Arc (input)</a>
<a href="#beats">Beats (output)</a>
<a href="#rev">Beats review</a></div>

${panel('filled', '1 · THE FILLED PROMPT (what the model actually received)',
  `Rebuilt via buildBeatsPrompt() — ${filled.length.toLocaleString()} chars`, filled)}
${panel('tpl', '2 · Raw template for comparison', esc(tplPath) + ` — ${tpl.length.toLocaleString()} chars`, tpl)}
${panel('arc', '3 · ARC — the input to this stage', 'arcReviewReport.finalArc (fallback: stories.data.outline → ---ARC---)', finalArc)}
${panel('beats', '4 · BEATS — what the stage produced', 'stories.data.outline → ---BEATS---', sect('BEATS'))}
${panel('rev', '5 · BEATS REVIEW', 'stories.data.outline → ---BEATS REVIEW---', sect('BEATS REVIEW'))}
</div>`;

  const out = process.env.BEATS_PROMPT_OUT ||
    path.join(process.cwd(), `beats-prompt-${storyId}.html`);
  fs.writeFileSync(out, html);
  console.log(`filled prompt: ${filled.length} chars`);
  console.log(`unresolved placeholders: ${leftovers.length ? leftovers.join(', ') : 'none'}`);
  console.log(`finalArc: ${finalArc ? (d.arcReviewReport?.finalArc ? 'from arcReviewReport.finalArc' : 'from outline ---ARC---') : 'NOT FOUND (builder fallback used)'}`);
  console.log(`arcHints: ${arcHints ? 'recovered' : 'empty (none recorded)'}`);
  console.log(`written: ${out}`);
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
