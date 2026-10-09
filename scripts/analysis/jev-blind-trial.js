/**
 * Trial pages: blind inventory (several models) + code checks (+ Jev duplicate-figure pairs).
 * Research harness only (docs/decisions.md 2026-10-09 "Trial page check ... NOT built"): nothing here is wired.
 *
 *   node scripts/analysis/jev-blind-trial.js fetch <n_stories>              # DB + image download (free)
 *   node scripts/analysis/jev-blind-trial.js inv <model> [maxPages]         # PAID inventory per page (~$0.0015 qwen3-vl)
 *   node scripts/analysis/jev-blind-trial.js score <model>                  # free: code findings per page from the saved inventories
 *   node scripts/analysis/jev-blind-trial.js jev <model>                    # paid, ~$0.0001/page: Jev same-person pairs on flagged pages
 *
 * Reuses evalPipeline.runVisualInventory / buildExpectedCastBlock / castPeopleCount, letteringCheck and requiredText.
 */
'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const D = 'evals/runs/2026-10-09_jev-blind-eval/trial/';
const IMG = process.env.JEV_TRIAL_IMG_DIR || D + 'img/';
fs.mkdirSync(D, { recursive: true }); fs.mkdirSync(IMG, { recursive: true });

async function fetchAll(nStories) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  // the four stories named in the decisions entry first, then the newest other 6-page stories
  const named = ['j945yhw9a', '6vgktllu5', '3bofwpxh4', 'svf6xj2rd'];
  const ids = (await pool.query("select id from stories where jsonb_array_length(coalesce(data->'sceneImages','[]'::jsonb))=6 and created_at > '2026-10-07' order by created_at desc")).rows.map(r => r.id);
  const pick = [...ids.filter(i => named.some(n => i.endsWith(n))), ...ids.filter(i => !named.some(n => i.endsWith(n)))].slice(0, nStories);
  const pages = [];
  for (const id of pick) {
    const d = (await pool.query('select data from stories where id=$1', [id])).rows[0].data;
    for (const s of d.sceneImages) {
      const q = await pool.query("select image_url, version_index from story_images where story_id=$1 and page_number=$2 and image_type='scene' order by version_index desc limit 1", [id, s.pageNumber]);
      if (!q.rows[0]) continue;
      const file = IMG + id.slice(-9) + '_p' + s.pageNumber + '.jpg';
      if (!fs.existsSync(file)) { const r = await fetch(q.rows[0].image_url); fs.writeFileSync(file, Buffer.from(await r.arrayBuffer())); }
      pages.push({ job: id, page: s.pageNumber, file, text: s.text, desc: s.sceneDescription || s.description, sceneMetadata: s.sceneMetadata, hintNames: s.sceneMetadata?.characters || [] });
    }
    pages.filter(p => p.job === id).forEach(p => { p.characters = d.characters; p.visualBible = d.visualBible; p.language = d.language || 'de'; });
  }
  fs.writeFileSync(D + 'pages.json', JSON.stringify(pages));
  console.log('stories', pick.length, 'pages', pages.length);
  await pool.end();
}

async function inv(model, maxPages) {
  await require('../../server/services/prompts').loadPromptTemplates();
  const { runVisualInventory } = require('../../server/lib/evalPipeline');
  const pages = JSON.parse(fs.readFileSync(D + 'pages.json')).slice(0, maxPages || 1e9);
  const out = fs.existsSync(D + `inv-${model}.json`) ? JSON.parse(fs.readFileSync(D + `inv-${model}.json`)) : {};
  const todo = pages.filter(p => !out[p.job + '#' + p.page]);
  let i = 0; const C = Number(process.env.JEV_TRIAL_CONC || 6);
  await Promise.all(Array.from({ length: C }, async () => {
    while (i < todo.length) {
      const p = todo[i++]; const t0 = Date.now();
      const b64 = fs.readFileSync(p.file).toString('base64');
      const r = await runVisualInventory([{ inline_data: { mime_type: 'image/jpeg', data: b64 } }], model, process.env.GEMINI_API_KEY, p.job.slice(-9) + ' p' + p.page, { pageNumber: p.page });
      out[p.job + '#' + p.page] = { ms: Date.now() - t0, inv: r, served: r && r.servedByModel };
      fs.writeFileSync(D + `inv-${model}.json`, JSON.stringify(out));
    }
  }));
  const ms = Object.values(out).map(x => x.ms).sort((a, b) => a - b);
  const toks = Object.values(out).reduce((a, x) => a + (x.inv ? (x.inv.inputTokens || 0) : 0), 0);
  console.log({ model, pages: ms.length, p50: ms[Math.floor(ms.length / 2)], p90: ms[Math.floor(ms.length * 0.9)], max: ms[ms.length - 1], nullInv: Object.values(out).filter(x => !x.inv).length, inputTokens: toks });
  process.exit(0);
}

function pageFindings(p, inventory) {
  const { buildExpectedCastBlock, castPeopleCount } = require('../../server/lib/evalPipeline'); const { unionPageCast } = require('../../server/lib/sceneMetadata');
  const requiredText = require('../../server/lib/requiredText');
  const { checkUndeclaredLettering } = require('../../server/lib/letteringCheck');
  const sceneCharacters = unionPageCast(`${p.desc || ''}\n${p.text || ''}`, p.hintNames, p.characters);
  const objectIds = Array.isArray(p.sceneMetadata?.objects) ? p.sceneMetadata.objects : [];
  const declared = requiredText.collectImageRequiredTexts({ objectIds, visualBible: p.visualBible || null, language: p.language }).map(r => r.text).filter(Boolean);
  const cast = buildExpectedCastBlock({ sceneCharacters, sceneMetadata: p.sceneMetadata, visualBible: p.visualBible || null, pageNumber: p.page, pageLabel: p.job.slice(-9) + ' p' + p.page, storyData: { characters: p.characters || [] } });
  const expectedPeople = castPeopleCount(cast);
  const f = [];
  for (const x of checkUndeclaredLettering({ lettering: inventory.lettering, declared })) if (x.severity === 'CRITICAL') f.push({ type: 'rendered_text', d: x.description });
  const drawn = (inventory.figures || []).filter(g => !/background$/.test(String(g.zone || ''))).length;
  if (cast.population === 'cast_only' && Number.isFinite(expectedPeople) && drawn > expectedPeople) f.push({ type: 'extra_people', d: `${drawn} drawn, ${expectedPeople} expected`, drawn, expectedPeople });
  return { findings: f, drawn, expectedPeople, population: cast.population, lettering: (inventory.lettering || []).map(l => `${l.text}|${l.placement}|${l.spelling}`) };
}

async function score(model) {
  await require('../../server/services/prompts').loadPromptTemplates();
  const pages = JSON.parse(fs.readFileSync(D + 'pages.json')); const inv = JSON.parse(fs.readFileSync(D + `inv-${model}.json`));
  const res = {};
  for (const p of pages) { const x = inv[p.job + '#' + p.page]; if (!x || !x.inv) continue; res[p.job.slice(-9) + ' p' + p.page] = { ms: x.ms, ...pageFindings(p, x.inv) }; }
  fs.writeFileSync(D + `findings-${model}.json`, JSON.stringify(res));
  const flagged = Object.entries(res).filter(([, v]) => v.findings.length);
  console.log(model, 'pages', Object.keys(res).length, 'flagged', flagged.length);
  for (const [k, v] of flagged) console.log(' ', k, v.findings.map(f => f.type + ': ' + f.d).join(' | '), '| lettering', JSON.stringify(v.lettering).slice(0, 160));
  process.exit(0);
}

async function jev(model) {
  const { callJev } = require('../../server/lib/jevAudit');
  const pages = JSON.parse(fs.readFileSync(D + 'pages.json')); const inv = JSON.parse(fs.readFileSync(D + `inv-${model}.json`)); const f = JSON.parse(fs.readFileSync(D + `findings-${model}.json`));
  let cost = 0, calls = 0; const out = {};
  for (const p of pages) {
    const key = p.job.slice(-9) + ' p' + p.page; const x = inv[p.job + '#' + p.page]; if (!f[key] || !f[key].findings.some(z => z.type === 'extra_people')) continue;
    const figs = (x.inv.figures || []).filter(g => !/background$/.test(String(g.zone || '')));
    const desc = g => `${g.age_group}, about ${g.apparent_age}; hair ${g.hair}; wearing ${g.clothing}`;
    const questions = {};
    for (let a = 0; a < figs.length; a++) for (let b = a + 1; b < figs.length; b++) questions[`P${a}_${b}`] = { type: 'noul', instructions: `FIGURE ${a} and FIGURE ${b} are the same person drawn twice: the same age, the same hair and the same clothes.` };
    if (!Object.keys(questions).length) continue;
    const state = figs.map((g, i) => `FIGURE ${i}: ${desc(g)}`).join('\n');
    const a = await callJev({ state, questions }); cost += a.cost; calls++;
    out[key] = { expected: f[key].expectedPeople, figs: figs.map(desc), pairs: Object.fromEntries(Object.entries(a.answers).map(([k, v]) => [k, +v.noul.toFixed(2)])) };
  }
  fs.writeFileSync(D + `jev-dup-${model}.json`, JSON.stringify(out)); console.log({ calls, cost }); console.log(JSON.stringify(out, null, 1).slice(0, 3000)); process.exit(0);
}
const [cmd, a1, a2] = process.argv.slice(2);
({ fetch: () => fetchAll(Number(a1 || 12)), inv: () => inv(a1, Number(a2 || 0)), score: () => score(a1), jev: () => jev(a1) })[cmd]?.() || console.log('usage: fetch|inv|score|jev');
