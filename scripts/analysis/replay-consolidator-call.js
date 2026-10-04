// Replay stored consolidator calls (consolidator_calls rows) with the CURRENT
// prompts/feedback-consolidator.txt: the stored user input is sent unchanged, only
// the rules template is swapped. Then the production id resolution and the
// fix-rests-on-a-kept-finding check run on the reply. One paid model call per id.
//
// Usage: node scripts/analysis/replay-consolidator-call.js --env=staging <callId> [<callId> ...]
// DB urls come from .env (MS_ENV_DIR points at the folder holding it).
const path = require('path');
require('dotenv').config({ path: path.join(process.env.MS_ENV_DIR || path.resolve(__dirname, '../..'), '.env') });
const { Pool } = require('pg');

(async () => {
  const args = process.argv.slice(2);
  const env = (args.find(a => a.startsWith('--env=')) || '--env=staging').split('=')[1];
  const ids = args.filter(a => /^\d+$/.test(a)).map(Number);
  if (!ids.length) { console.error('give consolidator_calls ids'); process.exit(1); }
  const url = env === 'prod' ? process.env.DATABASE_URL : process.env.STAGING_DATABASE_URL;
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  const { loadPromptTemplates, PROMPT_TEMPLATES } = require('../../server/services/prompts');
  await loadPromptTemplates();
  const FC = require('../../server/lib/feedbackConsolidator');
  const { callTextModel } = require('../../server/lib/textModels');
  const { extractJsonFromText } = require('../../server/lib/storyHelpers');
  const { resolveEvalModel, EVAL_TEMPERATURE } = require('../../server/config/models');
  const { FINDING_SOURCES } = require('../../server/lib/findingSources');
  const { sumDeductionPoints, composeDeductions } = require('../../server/lib/scoring');
  const SOURCE_BY_LETTER = { Q: FINDING_SOURCES.QUALITY, S: FINDING_SOURCES.SEMANTIC, C: FINDING_SOURCES.COMPLIANCE, E: FINDING_SOURCES.ENTITY, R: FINDING_SOURCES.READER, F: FINDING_SOURCES.FINAL_CHECKS };
  const template = PROMPT_TEMPLATES.feedbackConsolidator;
  const model = resolveEvalModel();
  console.log(`model=${model}`);
  const score = (p) => 100 - sumDeductionPoints(composeDeductions({ consolidated: p.deduped_issues }));
  const brief = (p) => ({
    scene_fix: p.scene_fix?.instruction ? `${p.scene_fix.severity} ids=${JSON.stringify(p.scene_fix.ids)} "${p.scene_fix.instruction}"` : null,
    per_character: (p.per_character_fixes || []).map(f => `${f.severity} ${f.characterName} ids=${JSON.stringify(f.ids)} "${f.fix_instruction}"`),
    dropped: (p.dropped_issues || []).map(d => `${d.reason} ${JSON.stringify(d.ids)} ${String(d.issue).slice(0, 90)}`),
    kept: (p.deduped_issues || []).map(d => `${d.severity}/${d.type} ${JSON.stringify(d.ids)}`),
    score: score(p),
  });
  let inTok = 0, outTok = 0;
  for (const id of ids) {
    const r = await pool.query('SELECT story_id, page_number, round, full_prompt, plan FROM consolidator_calls WHERE id = $1', [id]);
    const row = r.rows[0];
    if (!row) { console.log(`#${id} not found`); continue; }
    const cut = row.full_prompt.indexOf('\n\n---\n\n');
    let userInput = row.full_prompt.slice(cut + 7);
    // Calls stored before the 2026-10-04 id contract show findings as "- [SEV] (type) ...":
    // number them per section (Q/S/C/E, in order) the way indexFindings does.
    if (!/^- [QSCERF]\d+ \[/m.test(userInput)) {
      const prefixByHeading = { 'Quality evaluation issues': 'Q', 'Semantic evaluation issues': 'S', 'Compliance evaluation issues': 'C', 'Entity consistency issues': 'E' };
      let prefix = null, n = 0;
      userInput = userInput.split('\n').map(line => {
        const h = line.match(/^## (.+?)( \(|$)/);
        if (h) { prefix = prefixByHeading[h[1]] || null; n = 0; return line; }
        if (prefix && /^- \[/.test(line)) { n++; return `- ${prefix}${n} ${line.slice(2)}`; }
        return line;
      }).join('\n');
    }
    const index = new Map();
    for (const m of userInput.matchAll(/^- ([QSCERF]\d+) \[([A-Z]+)\]/gm)) index.set(m[1], { id: m[1], source: SOURCE_BY_LETTER[m[1][0]], severity: m[2] });
    const res = await callTextModel(userInput, null, model, { temperature: EVAL_TEMPERATURE, usageLabel: 'eval_consolidation', cachePrefix: `${template}\n\n---\n\n` });
    inTok += res?.usage?.input_tokens || 0; outTok += res?.usage?.output_tokens || 0;
    const plan = res?.text && extractJsonFromText(res.text);
    if (!plan) { console.log(`#${id} p${row.page_number}: no parsable reply`); continue; }
    const resolved = FC.resolveDedupedIssues(plan, index, row.page_number);
    plan.deduped_issues = resolved.deduped;
    const fixErrors = FC.checkFixesRestOnKeptFindings(plan, index, row.page_number);
    console.log(`\n#${id} ${row.story_id} p${row.page_number} r${row.round}`);
    console.log('OLD', JSON.stringify(brief(row.plan), null, 1));
    console.log('NEW', JSON.stringify({ ...brief(plan), fix_errors: fixErrors, id_errors: resolved.errors }, null, 1));
  }
  console.log(`\ntokens in=${inTok} out=${outTok}`);
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
