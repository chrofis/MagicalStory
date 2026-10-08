#!/usr/bin/env node
/**
 * Haiku 4.5 -> 5.5 replay of the six small Haiku call sites on STORED inputs
 * (docs/decisions.md 2026-10-08). Staging data, real code paths:
 *
 *   node scripts/analysis/haiku55-site-replay.js <site> --arm 45|55 [--effort low] [--rep 1]
 *   sites: translation | dedup | phantom | landmark | witness | trait
 *
 * The arm is applied WITHOUT editing production code, so both arms run against
 * the same checkout: for the callTextModel sites the model KEYS the sites use
 * are re-pointed in-process; for the two raw-fetch sites (identity witness,
 * trait verifier) a fetch shim rewrites the model id and drops `temperature`
 * exactly as the planned edit does. Results land in
 * evals/runs/2026-10-08_haiku55/sites/<site>_<arm>_r<rep>.json.
 */
'use strict';
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
if (!process.env.STAGING_DATABASE_URL) throw new Error('STAGING_DATABASE_URL not set');
process.env.DATABASE_URL = process.env.STAGING_DATABASE_URL;

const argv = process.argv.slice(2);
const site = argv[0];
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const arm = flag('arm', '45');
const effort = flag('effort', 'low');
const rep = Number(flag('rep', '1'));
if (!['45', '55'].includes(arm)) throw new Error('--arm must be 45 or 55');

const { TEXT_MODELS, priceUsage } = require('../../server/config/models');
const NEW_MODEL = 'claude-haiku-5-5';
const OLD_MODEL = 'claude-haiku-4-5-20251001';

// Re-point the keys the call sites use. 'claude-haiku-4-5' is not a TEXT_MODELS
// key in the checkout (callTextModel throws on it); the arm supplies it.
const target0 = TEXT_MODELS['claude-haiku'];
const target = arm === '55' ? TEXT_MODELS[NEW_MODEL] : TEXT_MODELS['claude-haiku'];
const realCallTextModel = require('../../server/lib/textModels');
TEXT_MODELS['claude-haiku-4-5'] = target;
if (arm === '55') {
  TEXT_MODELS['claude-haiku'] = target;
  // maxOutputTokensFor('claude-haiku-4-5-20251001') in the raw-fetch sites must still resolve; the fetch shim swaps the model after.
  TEXT_MODELS['_haiku45_id_stub'] = { provider: 'anthropic', modelId: OLD_MODEL, maxOutputTokens: target0.maxOutputTokens };
}

// Every anthropic call is logged with the model id the API reports.
const seenModelIds = new Set();
let spentUsd = 0;
const realFetch = global.fetch;
global.fetch = async (url, init) => {
  if (String(url).includes('api.anthropic.com') && init && typeof init.body === 'string') {
    const body = JSON.parse(init.body);
    if (arm === '55' && body.model === OLD_MODEL) {
      body.model = NEW_MODEL;
      delete body.temperature;
      if (effort) body.output_config = { ...(body.output_config || {}), effort };
    }
    if (effort && arm === '55' && body.model === NEW_MODEL && !body.output_config) body.output_config = { effort };
    seenModelIds.add(body.model);
    init = { ...init, body: JSON.stringify(body) };
    const res = await realFetch(url, init);
    const clone = res.clone();
    clone.json().then(j => {
      if (j?.model) seenModelIds.add('api:' + j.model);
      if (j?.usage) spentUsd += priceUsage(j.model || body.model, { input_tokens: j.usage.input_tokens + (j.usage.cache_read_input_tokens || 0) + (j.usage.cache_creation_input_tokens || 0), output_tokens: j.usage.output_tokens });
      if (j?.stop_reason === 'refusal') seenModelIds.add('REFUSAL');
    }).catch(() => {});
    return res;
  }
  return realFetch(url, init);
};
// callTextModel* with the 5.5 key and an effort: wrap so the sites (which pass no effort) run at the chosen one.
const wrap = (name) => {
  const orig = realCallTextModel[name];
  realCallTextModel[name] = (...args) => {
    const optIdx = name === 'callTextModelStreaming' ? 4 : 3;
    const key = args[name === 'callTextModelStreaming' ? 3 : 2];
    if (arm === '55' && TEXT_MODELS[key] === TEXT_MODELS[NEW_MODEL]) {
      args[optIdx] = { ...(args[optIdx] || {}), effort };
    }
    return orig(...args);
  };
};
// NOTE: sites destructure at call time (require inside the function), so patching the exports object is enough.
wrap('callTextModel'); wrap('callTextModelStreaming');
realCallTextModel.callClaudeAPI = (p, m, k, o) => realCallTextModel.callTextModel(p, m, k, o);

const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
const outDir = path.resolve(__dirname, '..', '..', 'evals', 'runs', '2026-10-08_haiku55', 'sites');
fs.mkdirSync(outDir, { recursive: true });
const save = (obj) => {
  const f = path.join(outDir, `${site}_${arm}${arm === '55' ? '-' + effort : ''}_r${rep}.json`);
  fs.writeFileSync(f, JSON.stringify({ site, arm, effort: arm === '55' ? effort : null, rep, modelIdsSeen: [...seenModelIds], usdAnthropicFetch: spentUsd, ...obj }, null, 1));
  console.log('wrote', f);
};
const story = async (id) => (await pool.query('select data from stories where id=$1', [id])).rows[0].data;

const SITES = {
  // The whole-story summary translation, as the pipeline sends it.
  async translation() {
    const { buildSceneTranslationPrompt } = require('../../server/lib/promptBuilders');
    const { extractSceneMetadata } = require('../../server/lib/storyHelpers');
    const ids = ['job_1791450210539_nwi88y9lr', 'job_1791315635053_t0t8qpebu', 'job_1791267520938_essbvehs8'];
    const results = [];
    for (const id of ids) {
      const d = await story(id);
      const scenes = (d.sceneImages || []).map(s => ({ pageNumber: s.pageNumber, imageSummary: extractSceneMetadata(s.sceneDescription || s.description)?.imageSummary || '' }));
      const built = buildSceneTranslationPrompt(scenes, d.language || 'de');
      const r = await realCallTextModel.callTextModelStreaming(built.prompt, null, null, 'claude-haiku', { usageLabel: 'scene_translation' });
      const lines = r.text.trim().split('\n').filter(l => l.trim());
      results.push({ id, language: d.language, expectedLines: built.count, gotLines: lines.length, modelId: r.modelId, usage: r.usage, lines });
    }
    return { results };
  },
  // CHR id collision: real secondary characters of one stored story, forced to share an id.
  async dedup() {
    const { dedupeSecondaryCharacterIds } = require('../../server/lib/visualBible');
    const ids = ['job_1791450210539_nwi88y9lr', 'job_1791315635053_t0t8qpebu', 'job_1791267520938_essbvehs8', 'job_1791222889407_ypl33vk8u', 'job_1791145238223_50osg2osm', 'job_1791040103540_atbttop6w'];
    const results = [];
    for (const id of ids) {
      const d = await story(id);
      const sec = (d.visualBible?.secondaryCharacters || []).filter(c => c.name && c.description);
      // all unordered pairs of DIFFERENT stored characters (ground truth: DIFFERENT)
      for (let i = 0; i < sec.length; i++) for (let j = i + 1; j < sec.length; j++) {
        const vb = { secondaryCharacters: [{ ...sec[i], id: 'CHR001' }, { ...sec[j], id: 'CHR001' }] };
        let usage = null;
        const out = await dedupeSecondaryCharacterIds(vb, (_p, u) => { usage = u; });
        const merged = out.secondaryCharacters.length === 1;
        results.push({ id, a: sec[i].name, b: sec[j].name, truth: 'DIFFERENT', answered: merged ? 'SAME' : 'DIFFERENT', usage });
      }
    }
    // SAME pairs: a main character's input description vs. its own Visual Bible entry (one person, two wordings)
    for (const id of ids) {
      const d = await story(id);
      const mains = d.visualBible?.mainCharacters || [];
      for (const m of mains.slice(0, 2)) {
        const input = (d.characters || []).find(c => c.name === m.name);
        const desc = input?.description || input?.physical?.description;
        if (!desc || !m.description) continue;
        const vb = { secondaryCharacters: [{ id: 'CHR001', name: null, description: desc, appearsInPages: [1] }, { id: 'CHR001', name: m.name, description: m.description, appearsInPages: [2] }] };
        const out = await dedupeSecondaryCharacterIds(vb, () => {});
        results.push({ id, a: '(input description)', b: m.name, truth: 'SAME', answered: out.secondaryCharacters.length === 1 ? 'SAME' : 'DIFFERENT' });
      }
    }
    return { results, correct: results.filter(r => r.truth === r.answered).length, n: results.length };
  },
  // No stored story has a phantom (the patch is a rare repair), so the case is made from real data:
  // one secondary character the pages name is removed from its stored Visual Bible, and the patch
  // has to write it back. The removed entry is the answer key.
  async phantom() {
    const P = require('../../server/lib/phantomCharacters');
    const rows = (await pool.query("select id from stories where data->>'trialMode' is distinct from 'true' order by created_at desc limit 30")).rows;
    const results = [];
    for (const { id } of rows) {
      if (results.length >= 8) break;
      const d = await story(id);
      const pages = (d.sceneImages || []).map(s => ({ pageNumber: s.pageNumber, text: s.text || '', characterClothing: s.sceneCharacterClothing || {} }));
      const named = new Set(pages.flatMap(p => Object.keys(p.characterClothing)).map(P.normalizeName));
      const sec = (d.visualBible?.secondaryCharacters || []).filter(c => c.name && c.description && named.has(P.normalizeName(c.name)));
      if (!sec.length) continue;
      const victim = sec[0];
      const vb = JSON.parse(JSON.stringify(d.visualBible));
      vb.secondaryCharacters = vb.secondaryCharacters.filter(c => c.name !== victim.name);
      const names = P.findPhantomNames(pages, vb, d.characters || []);
      if (!names.includes(victim.name) && !names.length) continue;
      const out = await P.detectAndPatchPhantomCharacters({ storyPages: pages, visualBible: vb, inputCharacters: d.characters || [], modelId: 'claude-haiku-4-5' });
      const patched = (vb.secondaryCharacters || []).find(c => P.normalizeName(c.name || '') === P.normalizeName(victim.name));
      results.push({ id, phantoms: names, victim: victim.name, victimDescription: victim.description, patchedDescription: patched?.description || null, returned: out ? 'patched' : null });
    }
    return { cases: results.length, patched: results.filter(r => r.patchedDescription).length, results };
  },
  async landmark() {
    const { selectDiversePhotosWithAI } = require('../../server/lib/landmarkPhotos');
    const rows = (await pool.query(`select name, photo_description d1, photo_description_2 d2, photo_description_3 d3, photo_description_4 d4, photo_description_5 d5, photo_description_6 d6
      from landmark_index where photo_description_6 is not null and length(photo_description_6) > 20 and story_score is not null order by story_score desc, id limit 14`)).rows;
    const results = [];
    for (const r of rows) {
      const images = [r.d1, r.d2, r.d3, r.d4, r.d5, r.d6].map(d => ({ description: d }));
      const picked = await selectDiversePhotosWithAI(images, 3);
      results.push({ name: r.name, picked, descriptions: images.map(i => (i.description || '').slice(0, 90)) });
    }
    return { results };
  },
  async witness() {
    const { secondOpinionIdentity } = require('../../server/lib/figureDetection');
    const { loadActivePageImage } = require('../../server/lib/testlab');
    const d = await story('job_1791450210539_nwi88y9lr');
    const results = [];
    for (const s of d.sceneImages || []) {
      if (results.length >= 10) break;
      const vi = (s.imageVersions || []).findIndex(v => (v.bboxDetection?.figures || []).length >= 2 && (v.bboxDetection?.expectedCharacters || []).length >= 2 && v.bboxDetection?.gdinoDiag?.identity?.answers);
      if (vi < 0) continue;
      const v = s.imageVersions[vi];
      const img = await loadActivePageImage('job_1791450210539_nwi88y9lr', s.pageNumber, vi);
      const figs = JSON.parse(JSON.stringify(v.bboxDetection.figures));
      const stored = figs.map(f => f.name || null);
      const op = await secondOpinionIdentity(img, figs, v.bboxDetection.expectedCharacters, `p${s.pageNumber}v${vi} `, { excludeModel: 'qwen-vl-full' });
      const named = op ? Object.fromEntries([...op.nameByFigure.entries()]) : null;
      const agree = named ? Object.entries(named).filter(([i, n]) => stored[i] === n).length : 0;
      results.push({ page: s.pageNumber, version: vi, model: op?.model || null, stored, named, agree, asked: named ? Object.keys(named).length : 0 });
    }
    return { results };
  },
  async trait() {
    const { _traitProbe, _traitBucket } = require('../../server/lib/traitPanel');
    const rows = (await pool.query("select id, data from characters order by created_at desc limit 12")).rows;
    const results = [];
    for (const r of rows) {
      for (const c of (r.data.characters || []).slice(0, 1)) {
        const url = c.photos?.face || c.photos?.body || c.photoUrl;
        if (!url) continue;
        const res = await realFetch(url);
        if (!res.ok) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        const mime = res.headers.get('content-type') || 'image/jpeg';
        const probe = await _traitProbe('haiku', buf.toString('base64'), mime);
        const fields = ['hairColor', 'eyeColor', 'hairStyle', 'hairLength', 'skinTone', 'facialHair'];
        const buckets = Object.fromEntries(fields.map(f => [f, probe ? _traitBucket(f, probe[f]) : null]));
        const storedBuckets = Object.fromEntries(fields.map(f => [f, _traitBucket(f, c.physical?.[f])]));
        results.push({ id: r.id, name: c.name, raw: probe, buckets, storedBuckets });
      }
    }
    return { results };
  },
};

(async () => {
  require('../../server/services/database').initializePool();
  if (!SITES[site]) throw new Error('site must be one of ' + Object.keys(SITES).join(' | '));
  const out = await SITES[site]();
  await new Promise(r => setTimeout(r, 1500)); // let the response-clone usage tally settle
  save(out);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
