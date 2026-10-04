#!/usr/bin/env node
/**
 * text_refine repair-model A/B — page-level blind ranking (2026-10-04).
 *
 *   node scripts/analysis/eval-refine-model-ab.js --arms=sonnet55:1592,opus5:1593 [--judges=gpt-5.6-sol,gemini-3.1-pro] [--stories=id,id] [--dry]
 *
 * Every arm is a Test Lab text_refine experiment run with
 * {fromWriterText, auditsFromStory}, so all arms repaired the SAME writer text
 * against the SAME stored audit findings. The story's stored refine result
 * (textRefineReport.pages[].after, what shipped) is a further arm, "stored".
 *
 * For each page any arm changed, each judge sees the page's findings, the
 * writer's original and every arm's repair under shuffled labels (seeded per
 * page and judge), and ranks them (prompts/eval-refine-rank-v1.txt). Judges
 * are non-Anthropic on purpose: two of the arms are Claude models.
 *
 * Output: evals/runs/<date>_refine-model-ab/ (raw judge replies + summary),
 * one line appended to evals/results/results.jsonl. Reads the STAGING DB.
 */
'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { Pool } = require('pg');

const ROOT = path.resolve(__dirname, '..', '..');
const PROMPT_FILE = 'prompts/eval-refine-rank-v1.txt';
const arg = (k, d) => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1] || d;
const ARMS = arg('arms', '').split(',').filter(Boolean).map(s => { const [name, id] = s.split(':'); return { name, expId: Number(id) }; });
const JUDGES = arg('judges', 'gpt-5.6-sol,gemini-3.1-pro').split(',').filter(Boolean);
const DRY = process.argv.includes('--dry');
// --stories=id1,id2 limits the run to those stories (cost bound).
const ONLY = arg('stories', '').split(',').filter(Boolean);
if (!ARMS.length || ARMS.some(a => !a.name || !a.expId)) {
  console.error('usage: --arms=name:expId,name:expId [--judges=a,b] [--dry]');
  process.exit(1);
}

// Deterministic shuffle so a rerun shows each judge the same order.
function shuffled(items, seed) {
  const out = items.slice();
  let h = crypto.createHash('sha256').update(seed).digest();
  for (let i = out.length - 1; i > 0; i--) {
    const j = h[i % h.length] % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
    if (i % 16 === 0) h = crypto.createHash('sha256').update(h).digest();
  }
  return out;
}

function parseJson(text) {
  const s = String(text || '');
  const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

(async () => {
  const { callTextModelStreaming } = require(path.join(ROOT, 'server/lib/textModels'));
  const { TEXT_MODELS, calculateTextCost } = require(path.join(ROOT, 'server/config/models'));
  for (const j of JUDGES) if (!TEXT_MODELS[j]) throw new Error(`unknown judge ${j}`);
  const template = fs.readFileSync(path.join(ROOT, PROMPT_FILE), 'utf8');
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });

  // arm name -> storyId -> pageNumber -> text
  const armText = {};
  const armMeta = {};
  for (const arm of ARMS) {
    const { rows } = await pool.query('SELECT stage, status, params, results FROM testlab_experiments WHERE id = $1', [arm.expId]);
    if (!rows.length) throw new Error(`experiment ${arm.expId} not found`);
    const r = rows[0];
    if (r.stage !== 'text_refine') throw new Error(`experiment ${arm.expId} is ${r.stage}, not text_refine`);
    const p = r.params || {};
    if (!(p.auditsFromStory === true || p.auditsFromStory === 'true')) throw new Error(`experiment ${arm.expId} did not replay stored audits`);
    armMeta[arm.name] = { expId: arm.expId, model: p.model, status: r.status };
    armText[arm.name] = {};
    for (const e of r.results || []) {
      if (!e.storyId || !Array.isArray(e.finalPages)) continue;
      armText[arm.name][e.storyId] = Object.fromEntries(e.finalPages.map(fp => [fp.pageNumber, fp.final]));
    }
  }
  const storyIds = [...new Set(Object.values(armText).flatMap(m => Object.keys(m)))]
    .filter(id => ARMS.every(a => armText[a.name][id]))
    .filter(id => !ONLY.length || ONLY.includes(id));
  if (!storyIds.length) throw new Error('no story has a result in every arm yet');

  const { rows: stories } = await pool.query(
    `SELECT id, data->>'language' AS language, data->>'languageLevel' AS level, data->'textRefineReport' AS rep
       FROM stories WHERE id = ANY($1)`, [storyIds]);
  await pool.end();

  const date = new Date().toISOString().slice(0, 10);
  const runDir = path.join(ROOT, 'evals', 'runs', `${date}_refine-model-ab`);
  fs.mkdirSync(runDir, { recursive: true });

  const jobs = [];
  for (const s of stories) {
    const rep = s.rep || {};
    const before = Object.fromEntries((rep.pages || []).map(p => [p.pageNumber, p.before]));
    const stored = Object.fromEntries((rep.pages || []).map(p => [p.pageNumber, p.after]));
    const faults = {};
    for (const f of rep.mergedFindings || []) (faults[f.pageNumber] ||= []).push(`- [${f.category}] ${f.text}`);
    armText.stored = armText.stored || {};
    armText.stored[s.id] = stored;
    const names = ['stored', ...ARMS.map(a => a.name)];
    for (const pn of Object.keys(before).map(Number).sort((a, b) => a - b)) {
      const original = before[pn];
      const versions = names.map(n => ({ arm: n, text: armText[n][s.id]?.[pn] ?? original }));
      if (!original || versions.every(v => v.text === original)) continue;
      for (const judge of JUDGES) {
        const order = shuffled(versions, `${s.id}:${pn}:${judge}`);
        const labels = ['A', 'B', 'C', 'D', 'E'].slice(0, order.length);
        let prompt = template
          .replace('{LANGUAGE}', s.language || 'de')
          .replace('{READING_LEVEL}', s.level || 'standard')
          .replace('{FAULTS}', (faults[pn] || ['- (no finding was listed for this page; it was changed by a story-wide pass)']).join('\n'))
          .replace('{ORIGINAL}', original);
        order.forEach((v, i) => { prompt = prompt.replace(`{${labels[i]}}`, v.text); });
        if (labels.length !== 3) throw new Error('the v1 rank prompt takes exactly three repairs');
        jobs.push({ storyId: s.id, page: pn, judge, prompt, labelToArm: Object.fromEntries(order.map((v, i) => [labels[i], v.arm])) });
      }
    }
  }
  console.log(`${storyIds.length} stories, ${jobs.length} judge calls (${JUDGES.join(', ')})`);
  if (DRY) { console.log(jobs[0]?.prompt.slice(0, 1500)); return; }

  let cost = 0;
  const results = [];
  const LIMIT = 6;
  for (let i = 0; i < jobs.length; i += LIMIT) {
    const batch = jobs.slice(i, i + LIMIT);
    results.push(...await Promise.all(batch.map(async (j) => {
      try {
        const r = await callTextModelStreaming(j.prompt, null, null, j.judge, { usageLabel: 'eval_refine_rank' });
        const c = r.usage?.direct_cost ?? calculateTextCost(r.modelId || TEXT_MODELS[j.judge].modelId, r.usage || {});
        cost += c || 0;
        return { ...j, prompt: undefined, raw: r.text, parsed: parseJson(r.text), cost: c };
      } catch (e) { return { ...j, prompt: undefined, error: String(e.message || e) }; }
    })));
    process.stdout.write(`\r${results.length}/${jobs.length} judged, $${cost.toFixed(2)}`);
    // Saved after every batch: a stopped run keeps what it paid for.
    fs.writeFileSync(path.join(runDir, 'judgements.json'), JSON.stringify(results, null, 2));
  }
  console.log();
  fs.writeFileSync(path.join(runDir, 'judgements.json'), JSON.stringify(results, null, 2));

  // Rank points: best = 2, middle = 1, worst = 0 (ties share the higher place).
  const arms = ['stored', ...ARMS.map(a => a.name)];
  const agg = Object.fromEntries(arms.map(a => [a, { points: 0, firsts: 0, n: 0, fixed: 0, newProblems: 0 }]));
  const pairwise = {};
  let valid = 0;
  for (const r of results) {
    const rk = r.parsed?.ranking;
    if (!Array.isArray(rk) || rk.length !== 3 || !rk.every(l => r.labelToArm[l])) continue;
    valid++;
    const tied = new Set((r.parsed.ties || []).flat());
    rk.forEach((label, idx) => {
      const arm = r.labelToArm[label];
      let place = idx;
      if (idx > 0 && tied.has(label) && tied.has(rk[idx - 1])) place = idx - 1;
      agg[arm].points += 2 - place; agg[arm].n++;
      if (place === 0) agg[arm].firsts++;
      agg[arm].fixed += Number(r.parsed.faultsFixed?.[label]) || 0;
      agg[arm].newProblems += Number(r.parsed.newProblems?.[label]) || 0;
    });
    for (let a = 0; a < 3; a++) for (let b = a + 1; b < 3; b++) {
      const key = [r.labelToArm[rk[a]], r.labelToArm[rk[b]]].sort().join(' vs ');
      const winner = r.labelToArm[rk[a]];
      pairwise[key] ||= {};
      pairwise[key][winner] = (pairwise[key][winner] || 0) + 1;
    }
  }
  const summary = {
    stories: storyIds, judges: JUDGES, calls: jobs.length, valid, judgeCost: Number(cost.toFixed(4)),
    arms: armMeta,
    byArm: Object.fromEntries(arms.map(a => [a, {
      meanPoints: agg[a].n ? Number((agg[a].points / agg[a].n).toFixed(3)) : null,
      firstShare: agg[a].n ? Number((agg[a].firsts / agg[a].n).toFixed(3)) : null,
      faultsFixedPerPage: agg[a].n ? Number((agg[a].fixed / agg[a].n).toFixed(3)) : null,
      newProblemsPerPage: agg[a].n ? Number((agg[a].newProblems / agg[a].n).toFixed(3)) : null,
    }])),
    pairwise,
  };
  fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));

  let gitCommit = null;
  try { gitCommit = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim(); } catch { /* not fatal */ }
  const line = {
    date, git_commit: gitCommit, model_id: JUDGES.join(','), prompt_file: PROMPT_FILE,
    prompt_sha256: crypto.createHash('sha256').update(template).digest('hex'),
    dataset: `staging text_refine replays exp ${ARMS.map(a => a.expId).join(',')} (${storyIds.length} stories)`,
    params: { arms: armMeta, judges: JUDGES },
    metrics: summary.byArm, notes: `pairwise ${JSON.stringify(pairwise)}; raw in evals/runs/${date}_refine-model-ab/`,
  };
  fs.appendFileSync(path.join(ROOT, 'evals', 'results', 'results.jsonl'), JSON.stringify(line) + '\n');
})().catch(e => { console.error(e); process.exit(1); });
