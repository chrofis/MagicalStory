// Offline A/B: replay the eval CONSOLIDATION of recent stories through several
// models (Sonnet vs Qwen vs DeepSeek) using the SAME stored inputs — so we can
// compare fix-plan quality + cost WITHOUT running a paid showcase.
//
// Usage:
//   node scripts/analysis/qwen-eval-ab.js [storyId ...]     (defaults to last 3)
//   MODELS="claude-sonnet,qwen-plus,deepseek-v3" node ... (override model set)
//
// Requires OPENROUTER_API_KEY in .env for the Qwen/DeepSeek runs.
require('dotenv').config();
const path = require('path');
const { Pool } = require('pg');

const MODELS = (process.env.MODELS || 'claude-sonnet,qwen-plus,deepseek-v3').split(',').map(s => s.trim());
const MAX_PAGES_PER_STORY = parseInt(process.env.MAX_PAGES || '2', 10);

function costOf(model, inTok, outTok) {
  const { MODEL_PRICING, TEXT_MODELS } = require(path.resolve(__dirname, '..', '..', 'server', 'config', 'models'));
  const id = TEXT_MODELS[model]?.modelId || model;
  const p = MODEL_PRICING[id] || MODEL_PRICING[model] || { input: 0, output: 0 };
  return (inTok / 1e6) * p.input + (outTok / 1e6) * p.output;
}

(async () => {
  const env = process.env;
  const conn = env.STAGING_DATABASE_URL || env.DATABASE_URL;
  const pool = new Pool({ connectionString: conn, ssl: { rejectUnauthorized: false } });

  let storyIds = process.argv.slice(2);
  if (storyIds.length === 0) {
    const r = await pool.query("SELECT id FROM stories ORDER BY created_at DESC LIMIT 3");
    storyIds = r.rows.map(x => x.id);
  }
  console.log('Stories:', storyIds.join(', '));
  console.log('Models:', MODELS.join(', '), '\n');

  const { loadPromptTemplates } = require(path.resolve(__dirname, '..', '..', 'server', 'services', 'prompts'));
  await loadPromptTemplates();
  const { consolidateFeedback } = require(path.resolve(__dirname, '..', '..', 'server', 'lib', 'feedbackConsolidator'));

  const totals = Object.fromEntries(MODELS.map(m => [m, { cost: 0, inTok: 0, outTok: 0, runs: 0, ms: 0 }]));

  for (const storyId of storyIds) {
    // Pages with real issues (where consolidation actually ran).
    const pr = await pool.query(
      `SELECT (scene->>'pageNumber')::int AS pn,
              scene->>'sceneDescription' AS sd,
              scene->'fixableIssues' AS fi,
              scene->'semanticResult' AS sr,
              scene->'bboxDetection' AS bd,
              scene->'entityReport' AS er,
              (SELECT jsonb_agg(jsonb_build_object('name', c->>'name',
                 'physicalDescription', COALESCE(c->'physical'->>'description', c->>'description','')))
                 FROM jsonb_array_elements(data->'characters') c) AS chars
       FROM stories, jsonb_array_elements(data->'sceneImages') AS scene
       WHERE id = $1 AND jsonb_array_length(COALESCE(scene->'fixableIssues','[]'::jsonb)) > 0
       ORDER BY pn LIMIT $2`,
      [storyId, MAX_PAGES_PER_STORY]
    );
    if (pr.rows.length === 0) { console.log(`(${storyId}: no pages with fixable issues — skipped)`); continue; }

    for (const s of pr.rows) {
      console.log(`\n===== ${storyId} · page ${s.pn} · ${s.fi?.length || 0} fixable issues =====`);
      for (const model of MODELS) {
        const t = Date.now();
        let res;
        try {
          res = await consolidateFeedback({
            sceneDescription: s.sd || '',
            evaluation: { fixableIssues: s.fi || [], semanticResult: s.sr || {}, bboxDetection: s.bd || {} },
            entityReport: s.er || null,
            pageNumber: s.pn,
            characters: s.chars || [],
            modelOverride: model,
          });
        } catch (e) {
          console.log(`  ${model.padEnd(14)} ERROR: ${e.message}`);
          continue;
        }
        const ms = Date.now() - t;
        const u = res.usage || {};
        const inTok = u.input_tokens || 0, outTok = u.output_tokens || 0;
        const c = costOf(model, inTok, outTok);
        const T = totals[model]; T.cost += c; T.inTok += inTok; T.outTok += outTok; T.runs++; T.ms += ms;
        const nFixes = Array.isArray(res.plan?.fixes) ? res.plan.fixes.length : (Array.isArray(res.plan) ? res.plan.length : '?');
        console.log(`  ${model.padEnd(14)} ${String(inTok).padStart(6)}in/${String(outTok).padStart(5)}out  $${c.toFixed(4)}  ${(ms/1000).toFixed(1)}s  ${nFixes} fixes${res.error ? '  ERR:' + res.error : ''}`);
        // Show the actual fix instructions so quality can be judged by eye.
        const fixes = res.plan?.fixes || (Array.isArray(res.plan) ? res.plan : []);
        for (const f of (fixes || []).slice(0, 6)) {
          console.log(`      • ${(f.instruction || f.description || JSON.stringify(f)).slice(0, 140)}`);
        }
      }
    }
  }

  console.log('\n\n======== TOTALS (across all replayed pages) ========');
  for (const m of MODELS) {
    const T = totals[m];
    if (T.runs === 0) { console.log(`${m.padEnd(14)} (no runs)`); continue; }
    console.log(`${m.padEnd(14)} ${T.runs} runs  ${T.inTok}in/${T.outTok}out  $${T.cost.toFixed(4)}  avg ${(T.ms / T.runs / 1000).toFixed(1)}s/run`);
  }
  const base = totals['claude-sonnet'];
  if (base && base.cost > 0) {
    console.log('\nvs claude-sonnet:');
    for (const m of MODELS) {
      if (m === 'claude-sonnet' || totals[m].runs === 0) continue;
      console.log(`  ${m}: $${totals[m].cost.toFixed(4)} vs $${base.cost.toFixed(4)}  (${((1 - totals[m].cost / base.cost) * 100).toFixed(0)}% cheaper)`);
    }
  }
  await pool.end();
})().catch(e => { console.error('FATAL', e.message); console.error(e.stack); process.exit(1); });
