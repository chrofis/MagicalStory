#!/usr/bin/env node
/**
 * Test Lab CLI runner — create + execute a Test Lab experiment from the shell.
 *
 * Runs the SAME stage runners as POST /api/admin/testlab/experiments and writes
 * to the SAME tables, so results appear in the /admin/test-lab UI (experiment
 * list → before/after grid) exactly like a UI-started run. Intended for
 * Claude-driven prompt iteration: analyze a page, write a prompt variant to a
 * file, run it against the benchmark set, review side-by-side in the UI.
 *
 * Usage
 *   node scripts/admin/testlab-run.js --stage image --benchmark [options]
 *   node scripts/admin/testlab-run.js --stage quality_eval --targets job_123:5,job_456:2
 *
 * Options
 *   --stage <s>        image | empty_scene | quality_eval | semantic_eval |
 *                      bbox | char_repair | entity            (required)
 *   --targets <list>   comma-separated storyId:pageNumber pairs
 *   --benchmark        use ALL benchmark_scenes entries as targets
 *   --benchmark-ids <list>  comma-separated benchmark ids (subset)
 *   --prompt <file>    prompt-override template file (A/B variant)
 *   --label <text>     experiment label shown in the UI
 *   --character <name> character name (char_repair only)
 *   --no-eval          skip auto-eval on image stage results
 *   --avatars-exp <id> avatar experiment id: use its styled sheets (character →
 *                      tl_avatar version) as scene refs, matched by artStyle
 *   --styles <list|all>  STYLE MATRIX mode (stage must be image): for each
 *                      target and each style, generate an empty scene in that
 *                      style, then the page image on top of it. 'all' = every
 *                      ART_STYLES key. 2 images per target per style.
 *   --env <staging|prod>  which DATABASE_URL to use (default: staging)
 *
 * Requires .env with STAGING_DATABASE_URL / DATABASE_URL + the image/eval API
 * keys (GEMINI_API_KEY, XAI_API_KEY). Cost note: image stages call paid APIs —
 * one image per target.
 */
'use strict';

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const val = (i + 1 < argv.length && !argv[i + 1].startsWith('--')) ? argv[++i] : 'true';
      flags[key] = val;
    }
  }
  return flags;
}

const flags = parseFlags(process.argv.slice(2));

function die(msg) { console.error(`ERROR: ${msg}`); process.exit(1); }

// Point the shared pool at the right environment BEFORE requiring any server code.
const env = flags.env || 'staging';
if (env === 'staging') {
  if (!process.env.STAGING_DATABASE_URL) die('STAGING_DATABASE_URL not set in .env');
  process.env.DATABASE_URL = process.env.STAGING_DATABASE_URL;
} else if (env !== 'prod') {
  die(`--env must be staging or prod (got ${env})`);
}
if (!process.env.DATABASE_URL) die('DATABASE_URL not set');

async function main() {
  const stage = flags.stage;
  const { STAGES, runStageOnTarget } = require('../../server/lib/testlab');
  if (!stage || !STAGES.includes(stage)) die(`--stage required. Valid: ${STAGES.join(', ')}`);

  const { dbQuery, initializePool } = require('../../server/services/database');
  initializePool();
  const { loadPromptTemplates } = require('../../server/services/prompts');
  await loadPromptTemplates();

  // Resolve targets
  let targets = [];
  if (flags.targets) {
    targets = flags.targets.split(',').map(t => {
      const [storyId, page] = t.split(':');
      return { storyId: storyId.trim(), pageNumber: parseInt(page, 10) };
    });
  }
  if (flags.benchmark === 'true' || flags['benchmark-ids']) {
    const rows = flags['benchmark-ids']
      ? await dbQuery('SELECT story_id, page_number FROM benchmark_scenes WHERE id = ANY($1::int[]) ORDER BY id',
          [flags['benchmark-ids'].split(',').map(Number)])
      : await dbQuery('SELECT story_id, page_number FROM benchmark_scenes ORDER BY id');
    targets = targets.concat(rows.map(r => ({ storyId: r.story_id, pageNumber: r.page_number })));
  }
  targets = targets.filter(t => t.storyId && Number.isFinite(t.pageNumber));
  if (targets.length === 0) die('No targets. Use --targets storyId:page,... or --benchmark');
  if (targets.length > 25) die('Max 25 targets per experiment');

  const promptOverride = flags.prompt ? fs.readFileSync(flags.prompt, 'utf8') : null;
  const params = {};
  if (flags.character) params.characterName = flags.character;
  if (flags['no-eval'] === 'true') params.autoEval = false;

  // Style-matrix mode: expand targets × styles; each unit = empty_scene + image.
  let styles = null;
  if (flags.styles) {
    if (stage !== 'image') die('--styles requires --stage image');
    const { ART_STYLES } = require('../../server/lib/storyHelpers');
    const allStyles = Object.keys(ART_STYLES);
    styles = flags.styles === 'all' ? allStyles : flags.styles.split(',').map(s => s.trim());
    const unknown = styles.filter(s => !allStyles.includes(s));
    if (unknown.length) die(`Unknown style(s): ${unknown.join(', ')}. Valid: ${allStyles.join(', ')}`);
    params.styleMatrix = styles;
  }

  // Avatar sheets from a prior 'avatars' experiment: {artStyle: {name: versionIndex}}
  const avatarSheetsByStyle = {};
  if (flags['avatars-exp']) {
    const exp = await dbQuery('SELECT results FROM testlab_experiments WHERE id = $1', [parseInt(flags['avatars-exp'], 10)]);
    if (!exp.length) die(`avatars experiment ${flags['avatars-exp']} not found`);
    for (const e of exp[0].results || []) {
      if (!e.ok || e.versionIndex === undefined) continue;
      (avatarSheetsByStyle[e.artStyle] ||= {})[e.character] = e.versionIndex;
    }
    console.log(`Avatar sheets loaded: ${Object.entries(avatarSheetsByStyle).map(([s, m]) => `${s}(${Object.keys(m).length})`).join(', ')}`);
  }

  const ins = await dbQuery(
    `INSERT INTO testlab_experiments (stage, label, prompt_override, params, status, targets, created_by)
     VALUES ($1, $2, $3, $4, 'running', $5, $6) RETURNING id`,
    [stage, flags.label || null, promptOverride, JSON.stringify({ ...params, avatarsExp: flags['avatars-exp'] || null }), JSON.stringify(targets), 'testlab-cli']
  );
  const experimentId = ins[0].id;
  const units = styles ? targets.length * styles.length : targets.length;
  console.log(`Experiment ${experimentId} started: stage=${stage}, env=${env}, targets=${targets.length}${styles ? ` × ${styles.length} styles` : ''} (${units} unit(s)), override=${promptOverride ? 'yes' : 'no'}`);

  let failures = 0;

  const record = async (entry) => {
    if (entry.promptUsed && entry.promptUsed.length > 30000) {
      entry.promptUsed = entry.promptUsed.slice(0, 30000) + '\n…[truncated]';
    }
    await dbQuery(`UPDATE testlab_experiments SET results = results || $2::jsonb WHERE id = $1`,
      [experimentId, JSON.stringify([entry])]);
  };

  const runUnit = async (target, styleOverride) => {
    const t0 = Date.now();
    const tag = `${target.storyId} P${target.pageNumber}${styleOverride ? ` [${styleOverride}]` : ''}`;
    try {
      let unitParams = { ...params };
      const sheets = avatarSheetsByStyle[styleOverride || 'default'];
      if (sheets) unitParams.avatarSheets = sheets;
      if (styleOverride) {
        // Empty scene in the target style first, then the page image on top of it.
        const empty = await runStageOnTarget('empty_scene', target, {
          promptOverride: null,
          params: { artStyleOverride: styleOverride },
          experimentId,
        });
        unitParams = { ...unitParams, artStyleOverride: styleOverride, backgroundRef: { imageType: 'empty_scene', versionIndex: empty.versionIndex } };
      }
      const result = await runStageOnTarget(stage, target, {
        promptOverride,
        params: unitParams,
        autoEval: params.autoEval !== false,
        experimentId,
      });
      const entry = { ...target, ok: true, ...result, artStyle: styleOverride || result.artStyle };
      const s = result.scores ? ` scores: final=${result.scores.final ?? '—'} sem=${result.scores.semantic ?? '—'}` : '';
      console.log(`  ✅ ${tag} (${((Date.now() - t0) / 1000).toFixed(1)}s)${result.versionIndex !== undefined ? ` → test v${result.versionIndex}` : ''}${s}`);
      await record(entry);
    } catch (err) {
      failures++;
      console.log(`  ❌ ${tag}: ${err.message}`);
      await record({ ...target, ok: false, error: err.message, artStyle: styleOverride || undefined });
    }
  };

  try {
    for (const target of targets) {
      if (styles) {
        for (const style of styles) await runUnit(target, style);
      } else {
        await runUnit(target, null);
      }
    }
    await dbQuery(`UPDATE testlab_experiments SET status = 'completed', completed_at = NOW() WHERE id = $1`, [experimentId]);
    console.log(`\n✅ Experiment ${experimentId} completed (${units - failures}/${units} ok).`);
    console.log(`   Review: /admin/test-lab → Experiments → #${experimentId} (before/after per page)`);
  } catch (err) {
    await dbQuery(`UPDATE testlab_experiments SET status = 'failed', error = $2, completed_at = NOW() WHERE id = $1`,
      [experimentId, err.message]).catch(() => {});
    die(`Experiment ${experimentId} aborted: ${err.message}`);
  }
  process.exit(failures > 0 ? 2 : 0);
}

main().catch(e => die(e.stack || e.message));
