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

// The rubric: artifact -> ordered dimension keys. Save-time validation and the
// report both read this, so the rubric has exactly one definition.
const RUBRIC = {
  beats:       ['arc', 'pacing', 'emotion', 'causality', 'themeFit'],
  scene:       ['clarity', 'variety', 'grounding', 'setting', 'composition'],
  storyText:   ['language', 'readability', 'voice', 'alignment', 'dialogue'],
  visualBible: ['completeness', 'wardrobe', 'world', 'anchors', 'consistency'],
};

const mean = (nums) => nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10 : 0;

function getPool(prod) {
  const cs = prod ? process.env.DATABASE_URL : process.env.STAGING_DATABASE_URL;
  if (!cs) throw new Error(`No connection string (${prod ? 'DATABASE_URL' : 'STAGING_DATABASE_URL'})`);
  return new Pool({ connectionString: cs, ssl: { rejectUnauthorized: false } });
}

function provenanceOf(d) {
  return {
    writer: d.outlineModelId || null,
    beatsReview: d.beatsReviewReport?.model || null,
    sceneReview: d.sceneReviewReport?.model || null,
    textRefine: d.textRefineReport?.model || null,
  };
}

// Final beats = the per-page outlineExtract that actually fed scene expansion
// (this is the complete, post-review set). beatsReviewReport only stores the
// pages the reviewer CHANGED, so it is not the full artifact. Falls back to the
// ---BEATS--- section of the raw outline.
function finalBeats(d) {
  const scenes = (d.sceneDescriptions || []).filter(s => s && s.outlineExtract);
  if (scenes.length) {
    return scenes
      .sort((a, b) => (a.pageNumber || 0) - (b.pageNumber || 0))
      .map(s => `--- Page ${s.pageNumber} ---\n${String(s.outlineExtract).trim()}`)
      .join('\n\n');
  }
  const m = (d.outline || '').match(/---\s*BEATS\s*---([\s\S]*?)(?:\n---|$)/i);
  return m ? m[1].trim() : (d.outline || '(no beats found)');
}

function finalScenes(d) {
  return (d.sceneDescriptions || [])
    .map(s => `--- Page ${s.pageNumber} ---\n${s.description || s.scenePrompt || ''}`)
    .join('\n\n');
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

  const artifacts = {};
  const artScores = [];
  for (const [artifact, dims] of Object.entries(RUBRIC)) {
    const given = input[artifact];
    if (!given || !given.dims) throw new Error(`missing scores for artifact "${artifact}"`);
    const vals = [];
    for (const dim of dims) {
      const v = given.dims[dim];
      if (typeof v !== 'number' || v < 1 || v > 10) throw new Error(`${artifact}.${dim} must be 1-10, got ${v}`);
      vals.push(v);
    }
    const extra = Object.keys(given.dims).filter(k => !dims.includes(k));
    if (extra.length) throw new Error(`${artifact} has unknown dims: ${extra.join(', ')}`);
    const score = mean(vals);
    artScores.push(score);
    artifacts[artifact] = { dims: given.dims, score, notes: given.notes || '' };
  }
  const record = {
    storyId,
    title: d.title || null,
    language: d.language || null,
    artStyle: d.artStyle || null,
    storyTopic: d.storyTopic || null,
    pipelineMode: d.layout?.pipelineMode || process.env.PIPELINE_MODE || 'beats',
    reviewedAt: new Date().toISOString().slice(0, 10),
    reviewer: REVIEWER,
    models: provenanceOf(d),
    artifacts,
    overall: mean(artScores),
  };
  fs.mkdirSync(path.dirname(STORE), { recursive: true });
  fs.appendFileSync(STORE, JSON.stringify(record) + '\n');
  console.log(`Saved record for ${storyId} → ${path.relative(process.cwd(), STORE)}`);
  console.log(`  beats=${artifacts.beats.score}  scene=${artifacts.scene.score}  storyText=${artifacts.storyText.score}  visualBible=${artifacts.visualBible.score}  → overall=${record.overall}`);
}

function cmdReport() {
  if (!fs.existsSync(STORE)) { console.log('No records yet.'); return; }
  const recs = fs.readFileSync(STORE, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  const H = ['story / model', 'beats', 'scene', 'text', 'VB', 'OVERALL'];
  console.log(H[0].padEnd(42) + H.slice(1).map(h => h.padStart(9)).join(''));
  console.log('-'.repeat(42 + 9 * 5));
  for (const r of recs) {
    const label = `${(r.title || r.storyId).slice(0, 26)} [${r.models?.writer || '?'}]`.slice(0, 41);
    const a = r.artifacts;
    console.log(label.padEnd(42)
      + String(a.beats.score).padStart(9) + String(a.scene.score).padStart(9)
      + String(a.storyText.score).padStart(9) + String(a.visualBible.score).padStart(9)
      + String(r.overall).padStart(9));
  }
  console.log(`\n${recs.length} record(s). Writer model in [brackets]; dimension detail in ${path.relative(process.cwd(), STORE)}.`);
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
