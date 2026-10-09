/**
 * Trial writer effort A/B (medium vs low) on stored trial stories.
 *
 *   node scripts/analysis/eval-trial-writer-effort.js --phase=inputs   # build + store the real prompts (free)
 *   node scripts/analysis/eval-trial-writer-effort.js --phase=run [--cap=3.0]
 *
 * The prompt is built by buildTrialStoryPrompt (what storyJobPipeline.js:693 calls) from the stored
 * inputs; the call is callTextModelStreaming with the pipeline's exact options (default model,
 * usageLabel unified_story, effort = arm). Streamed chunks feed the real ProgressiveUnifiedParser.
 * Output dir: evals/runs/2026-10-09_trial-writer-effort/. Arm labels are hidden in files (A/B);
 * the mapping lives in arms-key.json. Paid: ~USD 0.23 per call. Stops before the cap.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '../..');
const arg = n => (process.argv.find(a => a.startsWith(`--${n}=`)) || '').split('=')[1];
const phase = arg('phase') || 'inputs';
const CAP = Number(arg('cap') || 3.0);
const OUT = path.join(ROOT, 'evals/runs/2026-10-09_trial-writer-effort');
const IDS = [
  'job_1791579344291_rk2bno6av', // de-ch life-challenge cleaning-up, age 8, Zuerich landmarks (owner's trial today)
  'job_1791496820206_qwcnrq30r', // de life-challenge reading-alone, age 4, Baden landmarks
  'job_1791391658361_4eylyr1w4', // fr life-challenge, age 6, no landmarks
  'job_1791554548909_kl0phznw2', // de adventure, age 5, Wettingen landmarks
  'job_1791551298726_19tfcxccl', // de adventure, age 8, Wettingen landmarks
];

async function loadInputs() {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const res = {};
  for (const id of IDS) {
    const st = (await pool.query('select data from stories where id=$1', [id])).rows[0]?.data;
    const job = (await pool.query('select input_data from story_jobs where id=$1', [id])).rows[0]?.input_data;
    if (!st && !job) throw new Error(`no stored row for ${id}`);
    let input;
    if (job) {
      input = { ...job };
    } else {
      // The job row is purged; the story row keeps the same inputs under the same keys.
      input = {};
      for (const k of ['pages', 'layout', 'artStyle', 'ideaKind', 'ideaPick', 'language', 'trialMode', 'characters', 'storyTheme', 'storyTopic', 'storyDetails', 'userLocation', 'languageLevel', 'storyCategory', 'mainCharacters']) {
        if (st[k] !== undefined) input[k] = st[k];
      }
    }
    // availableLandmarks is set by selectStoryLandmarks inside the pipeline; the story keeps the ordered result.
    if (st?.replayInputs?.availableLandmarks) input.availableLandmarks = st.replayInputs.availableLandmarks;
    input.trialMode = true;
    // photos are URLs/base64 the text prompt never reads
    input.characters = (input.characters || []).map(c => { const { photos, avatars, ...rest } = c; return rest; });
    delete input.mainCharacters;
    res[id] = input;
  }
  await pool.end();
  return res;
}

(async () => {
  const { loadPromptTemplates } = require(path.join(ROOT, 'server/services/prompts'));
  await loadPromptTemplates();
  const { buildTrialStoryPrompt } = require(path.join(ROOT, 'server/lib/promptBuilders'));
  fs.mkdirSync(OUT, { recursive: true });

  if (phase === 'inputs') {
    const inputs = await loadInputs();
    for (const id of IDS) {
      const d = path.join(OUT, id); fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'inputData.json'), JSON.stringify(inputs[id], null, 2));
      const p = buildTrialStoryPrompt(inputs[id], inputs[id].pages);
      fs.writeFileSync(path.join(d, 'prompt.txt'), p);
      console.log(id, inputs[id].language, inputs[id].storyCategory, inputs[id].characters.map(c => c.age).join(','), 'landmarks=' + (inputs[id].availableLandmarks || []).length, 'promptChars=' + p.length);
    }
    return;
  }

  const { callTextModelStreaming } = require(path.join(ROOT, 'server/lib/textModels'));
  const { ProgressiveUnifiedParser } = require(path.join(ROOT, 'server/lib/outlineParser'));
  const { MODEL_DEFAULTS, priceUsage } = require(path.join(ROOT, 'server/config/models'));
  const keyFile = path.join(OUT, 'arms-key.json');
  const key = fs.existsSync(keyFile) ? JSON.parse(fs.readFileSync(keyFile, 'utf8')) : {};
  const metricsFile = path.join(OUT, 'metrics.json');
  const metrics = fs.existsSync(metricsFile) ? JSON.parse(fs.readFileSync(metricsFile, 'utf8')) : [];
  let spend = metrics.reduce((n, m) => n + (m.costUsd || 0), 0);

  async function countTokens(text) {
    const r = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: text }] }),
    });
    if (!r.ok) throw new Error('count_tokens ' + r.status + ' ' + await r.text());
    return (await r.json()).input_tokens;
  }

  for (const id of IDS) {
    const prompt = fs.readFileSync(path.join(OUT, id, 'prompt.txt'), 'utf8');
    if (!key[id]) {
      // blind assignment: which arm is "A" is random per story; the order of the two calls is random too
      const aIsLow = Math.random() < 0.5;
      key[id] = { A: aIsLow ? 'low' : 'medium', B: aIsLow ? 'medium' : 'low', order: Math.random() < 0.5 ? ['A', 'B'] : ['B', 'A'] };
      fs.writeFileSync(keyFile, JSON.stringify(key, null, 2));
    }
    for (const label of key[id].order) {
      if (metrics.find(m => m.id === id && m.label === label)) continue;
      if (spend + 0.30 > CAP) { console.log(`STOP: spend ${spend.toFixed(3)} + est 0.30 would pass cap ${CAP}`); process.exit(0); }
      const effort = key[id][label];
      const t0 = Date.now();
      const ev = { firstToken: null, title: null, vb: null, cover: null, pages: {}, headings: {} };
      const since = () => Date.now() - t0;
      const parser = new ProgressiveUnifiedParser({
        onTitle: () => { ev.title = ev.title ?? since(); },
        onVisualBible: () => { ev.vb = ev.vb ?? since(); },
        onCoverScene: () => { ev.cover = ev.cover ?? since(); },
        onPageComplete: p => { ev.pages[p.pageNumber] = since(); },
      }, { isTrial: true });
      const r = await callTextModelStreaming(prompt, null, (chunk, fullText) => {
        if (ev.firstToken === null) ev.firstToken = since();
        for (const m of fullText.matchAll(/---\s*Page\s+(\d+)\s*---/g)) if (ev.headings[m[1]] === undefined) ev.headings[m[1]] = since();
        parser.processChunk(chunk, fullText);
      }, null, { usageLabel: 'unified_story', effort });
      const total = since();
      parser.finalize();
      const text = r.text;
      const u = r.usage || {};
      const cost = priceUsage(r.modelId || 'claude-sonnet-5-5', u);
      spend += cost;
      const visibleTokens = await countTokens(text);
      const dir = path.join(OUT, id);
      fs.writeFileSync(path.join(dir, `output-${label}.txt`), text);
      metrics.push({
        id, label, effort_hidden_in_report: undefined, effort, modelId: r.modelId, stop_reason: r.stop_reason,
        ttftApiMs: r.ttft, firstVisibleTokenMs: ev.firstToken, titleMs: ev.title, vbCompleteMs: ev.vb, coverMs: ev.cover,
        pageHeadingMs: ev.headings, pageCompleteMs: ev.pages, totalMs: total,
        inputTokens: u.input_tokens, outputTokens: u.output_tokens, visibleTokensEst: visibleTokens,
        thinkingTokensEst: Math.max(0, (u.output_tokens || 0) - visibleTokens), chars: text.length, costUsd: cost,
      });
      delete metrics[metrics.length - 1].effort_hidden_in_report;
      fs.writeFileSync(metricsFile, JSON.stringify(metrics, null, 2));
      console.log(`${id} ${label}(${effort}) total=${(total / 1000).toFixed(1)}s vb=${((ev.vb || 0) / 1000).toFixed(1)}s out=${u.output_tokens} vis=${visibleTokens} cost=$${cost.toFixed(3)} spend=$${spend.toFixed(3)}`);
    }
  }
  console.log('DONE spend', spend.toFixed(3), 'defaultEffort', MODEL_DEFAULTS.trialStoryEffort);
})().catch(e => { console.error('ERR', e); process.exit(1); });
