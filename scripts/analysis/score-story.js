#!/usr/bin/env node
/**
 * Story-quality scorecard for MODEL COMPARISON. See docs/model-comparison/README.md.
 *
 * Reviewer-judged (not an in-pipeline eval): scores the four FINAL text artifacts
 * — beats, scene briefs, story text, visual bible — on 1-10 dimensions, and
 * persists one record per story to docs/model-comparison/scores.jsonl so runs
 * from different generation models are directly comparable.
 *
 *   node scripts/analysis/score-story.js <storyId>            # fetch artifacts for review
 *   node scripts/analysis/score-story.js <storyId> --save '<json>'  # persist scored record
 *   node scripts/analysis/score-story.js --report             # comparison table of all records
 *
 * Reads STAGING by default; --prod uses DATABASE_URL.
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { Pool } = require('pg');

const STORE = path.join(__dirname, '..', '..', 'docs', 'model-comparison', 'scores.jsonl');
const REVIEWER = 'claude-opus-4-8';

// Rubric, artifact extraction, and dim→score math come from the shared lib so
// this CLI and the Test Lab `story_scorecard` stage never diverge.
const { RUBRIC, finalBeats, finalScenes, provenanceOf, scoreFromDims, evaluatorStamp } = require('../../server/lib/storyScorecard');
// Every record is stamped with the evaluator identity (version + hash of
// rubric + judge prompt) so scores are only ever compared within one evaluator.
const JUDGE_PROMPT = (() => {
  try { return fs.readFileSync(path.join(__dirname, '..', '..', 'prompts', 'story-scorecard-judge.txt'), 'utf8'); }
  catch { return ''; }
})();

function getPool(prod) {
  const cs = prod ? process.env.DATABASE_URL : process.env.STAGING_DATABASE_URL;
  if (!cs) throw new Error(`No connection string (${prod ? 'DATABASE_URL' : 'STAGING_DATABASE_URL'})`);
  return new Pool({ connectionString: cs, ssl: { rejectUnauthorized: false } });
}

async function fetchStory(pool, storyId) {
  const { rows } = await pool.query('SELECT data FROM stories WHERE id=$1', [storyId]);
  if (!rows[0]) throw new Error(`story ${storyId} not found`);
  return rows[0].data || {};
}

async function cmdFetch(storyId, prod) {
  const pool = getPool(prod);
  const d = await fetchStory(pool, storyId);
  await pool.end();
  const outDir = path.join(require('os').tmpdir(), 'story-score', storyId);
  fs.mkdirSync(outDir, { recursive: true });
  const write = (name, content) => { const f = path.join(outDir, name); fs.writeFileSync(f, content); return f; };
  const files = {
    beats: write('beats.txt', finalBeats(d)),
    scene: write('scene.txt', finalScenes(d)),
    storyText: write('storyText.txt', d.storyText || '(none)'),
    visualBible: write('visualBible.json', JSON.stringify(d.visualBible || {}, null, 2)),
  };
  console.log(`Story: ${d.title} | ${d.language} | ${d.artStyle} | topic=${d.storyTopic} | mode=${d.layout?.pipelineMode || process.env.PIPELINE_MODE || 'beats'}`);
  console.log('Provenance:', JSON.stringify(provenanceOf(d)));
  console.log('\nFinal artifacts written for review:');
  for (const [k, f] of Object.entries(files)) console.log(`  ${k.padEnd(12)} → ${f}`);
  console.log('\nRubric dimensions (score each 1-10):');
  for (const [a, dims] of Object.entries(RUBRIC)) console.log(`  ${a.padEnd(12)} ${dims.join(', ')}`);
  console.log(`\nThen: node scripts/analysis/score-story.js ${storyId} --save '<json>'`);
}

async function cmdSave(storyId, scoresJson, prod) {
  let input;
  try { input = JSON.parse(scoresJson); } catch (e) { throw new Error(`--save JSON parse failed: ${e.message}`); }
  const pool = getPool(prod);
  const d = await fetchStory(pool, storyId);
  await pool.end();

  const { artifacts, overall } = scoreFromDims(input); // shared validation + math
  const record = {
    storyId,
    title: d.title || null,
    language: d.language || null,
    artStyle: d.artStyle || null,
    storyTopic: d.storyTopic || null,
    pipelineMode: d.layout?.pipelineMode || process.env.PIPELINE_MODE || 'beats',
    reviewedAt: new Date().toISOString().slice(0, 10),
    reviewer: REVIEWER,
    ...evaluatorStamp(JUDGE_PROMPT),
    models: provenanceOf(d),
    artifacts,
    overall,
  };
  fs.mkdirSync(path.dirname(STORE), { recursive: true });
  fs.appendFileSync(STORE, JSON.stringify(record) + '\n');
  console.log(`Saved record for ${storyId} → ${path.relative(process.cwd(), STORE)}`);
  console.log(`  beats=${artifacts.beats.score}  scene=${artifacts.scene.score}  storyText=${artifacts.storyText.score}  visualBible=${artifacts.visualBible.score}  → overall=${overall}`);
}

function cmdReport() {
  if (!fs.existsSync(STORE)) { console.log('No records yet.'); return; }
  const recs = fs.readFileSync(STORE, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  // Group by evaluator version — scores are only comparable within one.
  const byVer = new Map();
  for (const r of recs) { const v = r.evaluatorVersion || '(unversioned)'; (byVer.get(v) || byVer.set(v, []).get(v)).push(r); }
  const H = ['story / model', 'beats', 'scene', 'text', 'VB', 'OVERALL'];
  for (const [ver, group] of byVer) {
    const hash = group[0].evaluatorHash ? ` hash ${group[0].evaluatorHash}` : '';
    console.log(`\n=== evaluator ${ver}${hash} — ${group.length} record(s) ===`);
    console.log(H[0].padEnd(42) + H.slice(1).map(h => h.padStart(9)).join(''));
    console.log('-'.repeat(42 + 9 * 5));
    for (const r of group) {
      const label = `${(r.title || r.storyId).slice(0, 26)} [${r.models?.writer || '?'}]`.slice(0, 41);
      const a = r.artifacts;
      console.log(label.padEnd(42)
        + String(a.beats.score).padStart(9) + String(a.scene.score).padStart(9)
        + String(a.storyText.score).padStart(9) + String(a.visualBible.score).padStart(9)
        + String(r.overall).padStart(9));
    }
  }
  if (byVer.size > 1) console.log('\n⚠️  Multiple evaluator versions present — scores across versions are NOT comparable.');
  console.log(`\n${recs.length} record(s). Writer in [brackets]; grouped by evaluator version; detail in ${path.relative(process.cwd(), STORE)}.`);
}

(async () => {
  const args = process.argv.slice(2);
  const prod = args.includes('--prod');
  const rest = args.filter(a => a !== '--prod');
  if (rest[0] === '--report') return cmdReport();
  const storyId = rest[0];
  if (!storyId) { console.error('usage: score-story.js <storyId> [--save \'<json>\'] | --report'); process.exit(1); }
  const saveIdx = rest.indexOf('--save');
  if (saveIdx >= 0) return cmdSave(storyId, rest[saveIdx + 1], prod);
  const saveFileIdx = rest.indexOf('--save-file');
  if (saveFileIdx >= 0) return cmdSave(storyId, fs.readFileSync(rest[saveFileIdx + 1], 'utf8'), prod);
  return cmdFetch(storyId, prod);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
