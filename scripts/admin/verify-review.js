#!/usr/bin/env node
/**
 * One local HTML page per story run for the verification registry's HUMAN
 * checks (owner, 2026-09-27): every pending entry the run exercises whose
 * verdict needs eyes, with the images to look at next to the claim and the
 * check text, and a verdict control (confirmed / failed / not decided + note).
 *
 * Flow after every verification run (running-validation-stories skill):
 *   1. node scripts/admin/verify-review.js <storyId> [--env=prod]
 *        -> writes <tmp>/verify-review-<storyId>.html and prints the path
 *   2. Claude looks at every item (pixels, prompts, reports), writes its
 *      verdicts to a JSON file (format below) and re-renders the page with
 *      --verdicts=<file> so the owner sees Claude's verdict pre-filled.
 *   3. The owner opens the page, changes any verdict he disagrees with, and
 *      clicks "Download verdicts" (verify-verdicts-<storyId>.json).
 *   4. node scripts/admin/verify-run.js <storyId> --apply=<file> records every
 *      confirmed / failed verdict as HUMAN-<VERDICT> evidence with who decided.
 *
 * Verdicts file: { "storyId": "...", "env": "staging",
 *   "verdicts": [ { "id": "<entry>", "verdict": "confirmed|failed|undecided", "note": "...", "by": "claude|owner" } ] }
 *
 * A local file, not an admin page and not a claude.ai artifact: artifact links
 * 404 for the owner, and a file needs no deploy, no auth and no route.
 * Images come from the check's own instruction (URLs it names) plus the kinds
 * the entry lists in check.images (verify-core IMAGE_KINDS).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const { ch } = require('../lib/chTime');
const core = require('./verify-core');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** The review items for one judged run: HUMAN verdicts of pending entries, with their images. */
function reviewItems(entries, ctx, contains, prior = {}) {
  return core.judgeAll(entries.filter(e => e.status === 'pending'), ctx, contains)
    .filter(({ j }) => j.result === 'HUMAN')
    .map(({ e, j }) => {
      const human = j.r?.human || e.check?.what || '';
      const seen = new Set();
      const images = [
        ...core.urlsIn(human).map(url => ({ label: url.split('/').slice(-3).join('/'), url })),
        ...core.imagesFor(e.check?.images || [], ctx),
      ].filter(im => (seen.has(im.url) ? false : (seen.add(im.url), true)));
      return {
        id: e.id, title: e.title, claim: e.claim, what: human,
        detail: j.r?.detail && j.r.detail !== 'human check' ? j.r.detail : null,
        imageKinds: e.check?.images || [], images, prior: prior[e.id] || null,
      };
    });
}

/** Pure: the page. `run` = { storyId, env, build, runDate }. */
function renderReviewPage(run, items) {
  const cards = items.map((it, i) => {
    const p = it.prior || {};
    const radio = (val, label) => `<label><input type="radio" name="v${i}" value="${val}"${(p.verdict || 'undecided') === val ? ' checked' : ''}> ${label}</label>`;
    const imgs = it.images.length
      ? `<div class="imgs">${it.images.map(im => `<figure><a href="${esc(im.url)}" target="_blank" rel="noopener"><img loading="lazy" src="${esc(im.url)}" alt="${esc(im.label)}"></a><figcaption>${esc(im.label)}</figcaption></figure>`).join('')}</div>`
      : `<p class="none">No images for this entry${it.imageKinds.length ? '' : ' (its check names none — add check.images to the entry)'}: judge from the data the check names.</p>`;
    return `<section class="item" data-id="${esc(it.id)}" data-by="${esc(p.by || '')}">
  <h2><code>${esc(it.id)}</code> ${esc(it.title)}</h2>
  <p class="claim"><b>Expected:</b> ${esc(it.claim)}</p>
  <p class="what"><b>Look at:</b> ${esc(it.what)}</p>
  ${it.detail ? `<p class="detail"><b>Checker measured:</b> ${esc(it.detail)}</p>` : ''}
  ${imgs}
  <div class="verdict">${radio('confirmed', 'confirmed')} ${radio('failed', 'failed')} ${radio('undecided', 'not decided')}
    <span class="by">${p.by ? `verdict by ${esc(p.by)}` : ''}</span></div>
  <textarea rows="2" placeholder="What you looked at and saw (required for a verdict)">${esc(p.note || '')}</textarea>
</section>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Verify review ${esc(run.storyId)}</title>
<style>
:root { --bg:#fafaf9; --fg:#1c1917; --muted:#57534e; --card:#fff; --line:#e7e5e4; --accent:#4f46e5; }
@media (prefers-color-scheme: dark) { :root { --bg:#1c1917; --fg:#f5f5f4; --muted:#a8a29e; --card:#292524; --line:#44403c; --accent:#818cf8; } }
* { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 system-ui, sans-serif; }
header, main { max-width:1100px; margin:0 auto; padding:16px; }
header p { color:var(--muted); margin:4px 0; }
.item { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px; margin:0 0 16px; }
.item h2 { font-size:16px; margin:0 0 8px; } .item p { margin:6px 0; overflow-wrap:anywhere; }
.detail, .none, .by { color:var(--muted); }
.imgs { display:grid; grid-template-columns:repeat(auto-fill, minmax(220px, 1fr)); gap:10px; margin:10px 0; }
figure { margin:0; } figure img { width:100%; border-radius:6px; border:1px solid var(--line); display:block; }
figcaption { font-size:12px; color:var(--muted); overflow-wrap:anywhere; }
.verdict { display:flex; gap:16px; flex-wrap:wrap; align-items:center; margin:8px 0; }
textarea { width:100%; font:inherit; background:var(--bg); color:var(--fg); border:1px solid var(--line); border-radius:6px; padding:6px; }
.bar { position:sticky; top:0; background:var(--bg); border-bottom:1px solid var(--line); padding:10px 16px; display:flex; gap:12px; align-items:center; flex-wrap:wrap; z-index:1; }
button { background:var(--accent); color:#fff; border:0; border-radius:6px; padding:8px 14px; font:inherit; cursor:pointer; }
#status { color:var(--muted); }
</style></head>
<body>
<div class="bar"><button id="dl">Download verdicts</button><button id="cp">Copy verdicts JSON</button><span id="status"></span></div>
<header>
  <h1>Verification review — ${esc(run.storyId)}</h1>
  <p>${esc(run.env)} run ${esc(run.runDate)}, build ${esc(String(run.build || 'unrecorded').slice(0, 9))} — ${items.length} pending HUMAN entr${items.length === 1 ? 'y' : 'ies'} this run exercises.</p>
  <p>Set a verdict and a note per item, then Download (or Copy) and apply: <code>node scripts/admin/verify-run.js ${esc(run.storyId)}${run.env === 'prod' ? ' --env=prod' : ''} --apply=&lt;file&gt;</code></p>
</header>
<main>
${cards || '<p>No pending HUMAN entry is exercised by this run.</p>'}
</main>
<script>
const RUN = ${JSON.stringify({ storyId: run.storyId, env: run.env })};
const items = [...document.querySelectorAll('.item')];
items.forEach(el => el.addEventListener('change', () => { el.dataset.by = 'owner'; el.querySelector('.by').textContent = 'verdict by owner'; }));
items.forEach(el => el.querySelector('textarea').addEventListener('input', () => { el.dataset.by = 'owner'; el.querySelector('.by').textContent = 'verdict by owner'; }));
function collect() {
  return { ...RUN, verdicts: items.map(el => ({
    id: el.dataset.id,
    verdict: (el.querySelector('input[type=radio]:checked') || {}).value || 'undecided',
    note: el.querySelector('textarea').value.trim(),
    by: el.dataset.by || 'owner',
  })) };
}
function problems(v) { return v.verdicts.filter(x => x.verdict !== 'undecided' && !x.note).map(x => x.id); }
document.getElementById('dl').onclick = () => {
  const v = collect(); const bad = problems(v);
  if (bad.length) { document.getElementById('status').textContent = 'A verdict needs a note: ' + bad.join(', '); return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(v, null, 2)], { type: 'application/json' }));
  a.download = 'verify-verdicts-' + RUN.storyId + '.json'; a.click();
  document.getElementById('status').textContent = 'Downloaded ' + a.download;
};
document.getElementById('cp').onclick = async () => {
  const v = collect(); const bad = problems(v);
  if (bad.length) { document.getElementById('status').textContent = 'A verdict needs a note: ' + bad.join(', '); return; }
  try { await navigator.clipboard.writeText(JSON.stringify(v, null, 2)); document.getElementById('status').textContent = 'Copied'; }
  catch (e) { document.getElementById('status').textContent = 'Copy failed: ' + e.message; }
};
</script>
</body></html>
`;
}

function arg(name) {
  const hit = process.argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return null;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : true;
}

function buildContains(commit, build) {
  try { execFileSync('git', ['merge-base', '--is-ancestor', commit, build], { cwd: ROOT, stdio: 'ignore' }); return true; } catch (e) {
    return e.status === 1 ? false : null;
  }
}

async function main() {
  const storyId = process.argv.slice(2).find(a => !a.startsWith('--'));
  if (!storyId) { console.error('Usage: node scripts/admin/verify-review.js <storyId> [--env=staging|prod] [--verdicts=<file>] [--out=<file.html>]'); process.exit(2); }
  const env = arg('env') || 'staging';
  require('dotenv').config({ path: path.join(ROOT, '.env') });
  const url = env === 'prod' ? (process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL) : process.env.STAGING_DATABASE_URL;
  if (!url) throw new Error(`no database url for ${env}`);
  const reg = JSON.parse(fs.readFileSync(path.join(ROOT, 'tasks', 'verify.json'), 'utf8'));
  const prior = {};
  if (arg('verdicts')) {
    const v = JSON.parse(fs.readFileSync(arg('verdicts'), 'utf8'));
    if (v.storyId !== storyId) throw new Error(`verdicts file is for ${v.storyId}, not ${storyId}`);
    for (const x of v.verdicts || []) prior[x.id] = x;
  }
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 2 });
  let ctx;
  try { ctx = await core.loadRun(pool, storyId, env); } finally { await pool.end(); }
  const run = { storyId, env, build: ctx.build, runDate: ch(ctx.job?.createdAt || ctx.createdAt) };
  const items = reviewItems(reg.entries, ctx, buildContains, prior);
  const out = arg('out') || path.join(os.tmpdir(), `verify-review-${storyId}.html`);
  fs.writeFileSync(out, renderReviewPage(run, items));
  console.log(`${items.length} HUMAN item(s) for ${storyId} (${env}): ${items.map(i => i.id).join(', ') || 'none'}`);
  console.log(`page: ${out}`);
}

module.exports = { reviewItems, renderReviewPage };

if (require.main === module) {
  main().catch(e => { console.error(`verify-review: ${e.message}`); process.exit(1); });
}
