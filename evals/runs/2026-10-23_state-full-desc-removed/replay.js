#!/usr/bin/env node
/**
 * 5-case replay of "full description per state + typed removed list" (STATE_FULL_DESCRIPTION_RULE, sheet cell = state.description + 'Not in this picture' line; follows 2026-10-23_state-replaces-part). Writer step only, on stored inputs, with the REAL builders and the REAL production models:
 *   trial -> buildTrialArcPrompt + MODEL_DEFAULTS.trialArcModel (call A only; call B pages is not run)
 *   full  -> buildVisualBibleCallPrompt (beatsReplayInputs) + MODEL_DEFAULTS.visualBibleModel
 * Then one sheet per case: buildReferenceSheetPrompt over expandElementStateCells(new element) and the production
 * sheet render (callGeminiAPIForImage, model null -> MODEL_DEFAULTS.pageImage), the old stored cells downloaded beside it.
 *
 *   node evals/runs/2026-10-23_state-full-desc-removed/replay.js --phase=dry|writer|sheet [--cap=0.5]
 * Ledger: ledger.jsonl in this folder (real usage). Hard cap over the whole ledger.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../../../.env') });
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const ROOT = path.resolve(__dirname, '../../..');
const OUT = __dirname;
const LEDGER = path.join(OUT, 'ledger.jsonl');
const arg = n => (process.argv.find(a => a.startsWith(`--${n}=`)) || '').split('=')[1];
const phase = arg('phase') || 'dry';
const CAP = Number(arg('cap') || 0.5);
const spent = () => (fs.existsSync(LEDGER) ? fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).reduce((s, l) => s + (JSON.parse(l).cost || 0), 0) : 0);
const book = (o) => fs.appendFileSync(LEDGER, JSON.stringify({ at: new Date().toISOString(), ...o }) + '\n');

const SHEET_CASES = ['job_1792772600127_tv32st82h', 'job_1792041406330_mxoqmhu6k', 'job_1792312615714_wpz3fzwyy', 'job_1790446348343_z3fw660ie', 'job_1791450210539_nwi88y9lr'];
const CASES = [
  { id: 'job_1792772600127_tv32st82h', env: 'prod', kind: 'trial', el: 'VEH001' },
  { id: 'job_1792041406330_mxoqmhu6k', env: 'prod', kind: 'trial', el: 'ART001' },
  { id: 'job_1792312615714_wpz3fzwyy', env: 'prod', kind: 'full', el: 'ART001' },
  // added after the shoebox and birdcage replays came back with no state on that object (writer variance, kept on file)
  { id: 'job_1790446348343_z3fw660ie', env: 'stg', kind: 'full', el: 'ART002' },
  { id: 'job_1791450210539_nwi88y9lr', env: 'stg', kind: 'full', el: 'ART009' },
];
const pools = {};
const pool = env => (pools[env] = pools[env] || new Pool({ connectionString: env === 'prod' ? process.env.DATABASE_URL : process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } }));

/** Trial inputData: the job row when it still exists, else rebuilt from the stored story (as 2026-10-19 did). */
async function trialInput(c) {
  const j = await pool(c.env).query('select input_data from story_jobs where id = $1', [c.id]);
  if (j.rows[0]?.input_data) return { src: 'story_jobs.input_data', inputData: j.rows[0].input_data };
  const r = await pool(c.env).query(`select data->'pages' pages, data->'layout' layout, data->>'artStyle' art, data->>'language' lang, data->'characters' ch,
    data->>'storyTheme' th, data->>'storyTopic' tp, data->>'storyDetails' sd, data->>'languageLevel' ll, data->>'storyCategory' cat, data->'userLocation' loc,
    data->'replayInputs'->'availableLandmarks' lm from stories where id = $1`, [c.id]);
  const x = r.rows[0];
  const strip = ch => ({ id: ch.id, age: ch.age, name: ch.name, gender: ch.gender, physical: ch.physical, referenceOutfit: ch.referenceOutfit || null, generatedOutfits: {}, role: ch.role || (ch.isMainCharacter ? 'main' : undefined), isMainCharacter: !!ch.isMainCharacter });
  const inputData = { pages: Number(x.pages), layout: x.layout, artStyle: x.art, language: x.lang, characters: (x.ch || []).map(strip), storyTheme: x.th || '', storyTopic: x.tp || '', storyDetails: x.sd, languageLevel: x.ll, storyCategory: x.cat, trialMode: true, ...(x.loc ? { userLocation: x.loc } : {}), ...(x.lm ? { availableLandmarks: x.lm } : {}) };
  return { src: 'rebuilt from stories.data', inputData };
}

async function storedElement(c) {
  const r = await pool(c.env).query(`select data->'visualBible' vb from stories where id = $1`, [c.id]);
  const vb = r.rows[0].vb;
  for (const p of ['artifacts', 'vehicles', 'animals']) { const e = (vb[p] || []).find(x => x.id === c.el); if (e) return { pool: p, entry: e, vb }; }
  throw new Error(`${c.el} not in ${c.id}`);
}

async function buildPrompt(c) {
  const PB = require(path.join(ROOT, 'server/lib/promptBuilders'));
  if (c.kind === 'trial') {
    const { src, inputData } = await trialInput(c);
    return { src, prompt: PB.buildTrialArcPrompt(inputData, inputData.pages) };
  }
  const { loadStory, rebuildBriefBeats } = require(path.join(ROOT, 'scripts/analysis/ad-stage-model-replay'));
  const { resolveReplayInputData, buildReplaySceneOptions } = require(path.join(ROOT, 'server/lib/beatsReplayInputs'));
  const { buildAvailableAvatarsForPrompt } = require(path.join(ROOT, 'server/lib/clothingResolve'));
  const story = await loadStory(pool(c.env), c.id);
  const input = resolveReplayInputData(story);
  const beats = rebuildBriefBeats(story);
  const opts = buildReplaySceneOptions(story, { availableAvatars: buildAvailableAvatarsForPrompt(story.characters || [], story.clothingRequirements || null), maxCharactersPerScene: 3 });
  return { src: 'stories.data via beatsReplayInputs', prompt: PB.buildVisualBibleCallPrompt(input, beats, opts) };
}

function parseVb(c, text) {
  if (c.kind === 'trial') {
    const { UnifiedStoryParser } = require(path.join(ROOT, 'server/lib/outlineParser'));
    return new UnifiedStoryParser(text, { isTrial: true }).extractVisualBible();
  }
  const { extractBibleSections, AD_BIBLE_MARKERS } = require(path.join(ROOT, 'server/lib/beatsPipeline'));
  const { UnifiedStoryParser } = require(path.join(ROOT, 'server/lib/outlineParser/unified'));
  const sections = extractBibleSections(text || '', AD_BIBLE_MARKERS);
  return sections ? new UnifiedStoryParser(sections.body).extractVisualBible() : null;
}
async function googleDirect(prompt, modelId) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 65536, thinkingConfig: { thinkingLevel: 'low' } } }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`google ${r.status} ${j.error?.status}`);
  const text = (j.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('');
  const m = j.usageMetadata || {};
  const usage = { input_tokens: m.promptTokenCount, output_tokens: (m.candidatesTokenCount || 0) + (m.thoughtsTokenCount || 0), thoughts_included_in_output: m.thoughtsTokenCount };
  return { text, modelId: `google/${modelId}`, usage, finishReason: j.candidates?.[0]?.finishReason };
}
const statefulRows = vb => ['artifacts', 'vehicles', 'animals'].flatMap(p => (vb?.[p] || []).filter(e => Array.isArray(e.states) && e.states.length > 1)
  .map(e => ({ pool: p, id: e.id, name: e.name, description: e.description, states: e.states.map(s => ({ id: s.id, name: s.name, delta: s.delta, description: s.description, removed: s.removed, pages: s.pages })) })));

(async () => {
  await require(path.join(ROOT, 'server/services/prompts')).loadPromptTemplates();
  const { MODEL_DEFAULTS, TEXT_MODELS, priceUsage } = require(path.join(ROOT, 'server/config/models'));
  if (phase === 'dry' || phase === 'writer') {
    const textModels = require(path.join(ROOT, 'server/lib/textModels'));
    for (const c of CASES.filter(x => !arg('only') || arg('only').split(',').includes(x.kind))) {
      const outFile = path.join(OUT, `${c.id}__writer.json`);
      if (fs.existsSync(outFile)) { console.log(c.id, 'done already'); continue; }
      const { src, prompt } = await buildPrompt(c);
      const old = await storedElement(c);
      const hasRule = prompt.includes('complete standalone description of the object in that state');
      if (phase === 'dry') { console.log(c.id, c.kind, src, 'chars', prompt.length, 'rule in prompt', hasRule, 'unfilled', (prompt.match(/\{[A-Z_]{4,}\}/g) || []).join(',') || '-'); continue; }
      if (!hasRule) throw new Error(`${c.id}: STATE_FULL_DESCRIPTION_RULE missing from the built prompt`);
      if (spent() + 0.05 > CAP) { console.log('CAP stop before', c.id, spent()); break; }
      const model = c.kind === 'trial' ? MODEL_DEFAULTS.trialArcModel : MODEL_DEFAULTS.visualBibleModel;
      const opts = c.kind === 'trial' ? { usageLabel: 'unified_story', reasoning: { effort: MODEL_DEFAULTS.trialArcEffort } }
        : { usageLabel: 'beats_visual_bible', ...(MODEL_DEFAULTS.visualBibleEffort ? { effort: MODEL_DEFAULTS.visualBibleEffort } : {}) };
      const t0 = Date.now();
      // The local OPENROUTER key is revoked (rotated 2026-10-23), so the trial planner's model is called on Google
      // directly: same model id, reasoning low as thinkingLevel low. Not the production route; said so in the notes.
      const res = c.kind === 'trial' ? await googleDirect(prompt, 'gemini-3.7-flash') : await textModels.callTextModelStreaming(prompt, null, () => {}, model, opts);
      const cost = res.usage?.direct_cost ?? priceUsage(res.modelId || TEXT_MODELS[model].modelId, res.usage || {});
      book({ story: c.id, step: 'writer', model, modelId: res.modelId, cost, in: res.usage?.input_tokens, out: res.usage?.output_tokens, ms: Date.now() - t0 });
      let vb = null, err = null;
      try { vb = parseVb(c, res.text); } catch (e) { err = e.message; }
      fs.writeFileSync(outFile, JSON.stringify({ case: c, src, model, modelId: res.modelId, cost, old: { pool: old.pool, id: old.entry.id, name: old.entry.name, description: old.entry.description, states: old.entry.states.map(s => ({ id: s.id, name: s.name, delta: s.delta, pages: s.pages, referenceImageUrl: s.referenceImageUrl })) }, new: vb ? statefulRows(vb) : null, parseError: err, prompt, reply: res.text }, null, 1));
      console.log(`${c.id} $${cost.toFixed(4)} running $${spent().toFixed(4)} new stateful: ${vb ? statefulRows(vb).map(r => r.id + ' ' + r.name).join('; ') : 'PARSE FAIL ' + err}`);
    }
  }
  if (phase === 'sheet') {
    // --pick=<storyId>:<newElementId>,...  which new element is the case's element (chosen by hand from the writer dump)
    const picks = Object.fromEntries(String(arg('pick') || '').split(',').filter(Boolean).map(p => p.split(':')));
    const refSheets = require(path.join(ROOT, 'server/lib/referenceSheets'));
    const { resolveArtStyle } = require(path.join(ROOT, 'server/lib/promptBuilders'));
    const { IMAGE_MODELS } = require(path.join(ROOT, 'server/config/models'));
    const { callGeminiAPIForImage } = require(path.join(ROOT, 'server/lib/images'));
    const POOL_TYPE = { artifacts: 'artifact', vehicles: 'vehicle', animals: 'animal' };
    for (const c of CASES.filter(x => SHEET_CASES.includes(x.id))) {
      const dir = path.join(OUT, c.id); fs.mkdirSync(dir, { recursive: true });
      if (fs.existsSync(path.join(dir, 'new-sheet.jpg'))) { console.log(c.id, 'sheet done already'); continue; }
      const w = JSON.parse(fs.readFileSync(path.join(OUT, `${c.id}__writer.json`), 'utf8'));
      // old stored cells, for the side-by-side
      for (const s of w.old.states) if (s.referenceImageUrl) {
        const r = await fetch(s.referenceImageUrl); if (r.ok) fs.writeFileSync(path.join(dir, `old-${s.id.replace('.', '_')}.jpg`), Buffer.from(await r.arrayBuffer()));
      }
      const pid = picks[c.id]; const row = (w.new || []).find(r => r.id === pid);
      if (!row) { console.log(c.id, 'no pick / not found:', pid); continue; }
      const { vb: oldVb } = await storedElement(c);
      const sr = await pool(c.env).query(`select data->>'artStyle' a, data->'layout' l from stories where id = $1`, [c.id]);
      const el = { id: row.id, name: row.name, description: row.description, states: row.states, type: POOL_TYPE[row.pool], kind: null, pageCount: 2 };
      const cells = refSheets.expandElementStateCells(el);
      const styleDescription = resolveArtStyle(sr.rows[0].a, IMAGE_MODELS[MODEL_DEFAULTS.pageImage].backend) || resolveArtStyle('pixar');
      // the sheet prompt reads the bible only for lettering names; the stored bible stands in for the new one's other entries
      const prompt = refSheets.buildReferenceSheetPrompt(cells, styleDescription, oldVb);
      if (!prompt.includes(require(path.join(ROOT, 'server/lib/promptBuilders')).STATE_WINS_RULE)) throw new Error('STATE_WINS_RULE missing from sheet prompt');
      if (spent() + 0.03 > CAP) { console.log('CAP stop before sheet', c.id, spent()); break; }
      const aspect = sr.rows[0].l?.imageAspect || MODEL_DEFAULTS.pageAspect;
      const t0 = Date.now();
      const result = await callGeminiAPIForImage(prompt, [], null, 'avatar', null, null, null, '', null, [], 0, null, null, null, null, aspect);
      const u = result?.usage || {};
      const cost = Number(u.direct_cost ?? u.cost ?? (IMAGE_MODELS[result?.modelId]?.costPerImage ?? IMAGE_MODELS[MODEL_DEFAULTS.pageImage]?.costPerImage ?? 0.02));
      book({ story: c.id, step: 'sheet', modelId: result?.modelId, cost, usage: u, ms: Date.now() - t0 });
      if (!result?.imageData) { console.log(c.id, 'NO IMAGE'); continue; }
      const b64 = require(path.join(ROOT, 'server/lib/r2')).stripDataUriPrefix(result.imageData);
      fs.writeFileSync(path.join(dir, 'new-sheet.jpg'), Buffer.from(b64, 'base64'));
      const parts = await refSheets.splitGridIntoReferences(b64, cells.length, cells);
      parts.forEach((p, i) => p && fs.writeFileSync(path.join(dir, `new-${cells[i].id.replace('.', '_')}.png`), Buffer.from(p, 'base64')));
      fs.writeFileSync(path.join(dir, 'sheet.json'), JSON.stringify({ element: row, cells, prompt, modelId: result.modelId, cost }, null, 1));
      console.log(`${c.id} sheet ${result.modelId} $${cost} running $${spent().toFixed(4)}`);
    }
  }
  console.log('SPENT', spent().toFixed(4), 'of', CAP);
  for (const p of Object.values(pools)) await p.end();
})().then(() => process.exit(0)).catch(e => { console.error('FAILED', e); process.exit(1); });
