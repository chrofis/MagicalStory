// Builds the REAL prompts for the three plot fixes (F1 idea, F2 arc re-tell, F3 writer must-say) over STORED
// stories (prod + staging, read-only DB, no model call), once as the prompt stood before 2026-11-07 ("old") and
// once as it is now ("new"). Free. usage: node build-prompts.js <outDir>
//   F1: the stored wizard idea prompt (data.ideaGeneration.prompt, verbatim as sent); new = its coherence rule swapped
//       for today's. 10 stories with 3+ characters and 10 with 1-2 (clean negatives).
//   F2: buildArcRetellPrompt over the stored arc block, the stored ISSUES TO REPAIR text and the stored challenge section
//       (rounds[0].retellPrompt), as the Lab's arc_panel_replay does; old = the cut-don't-add bullets removed.
//   F3: buildStoryTextFromBeatsPrompt as the Lab's story_text replay does (buildReplayTextArgs); old = no MUST SAY block
//       and the old load-bearing clause.
require('dotenv').config({ path: 'C:/Users/roger/MagicalStory/.env' });
const fs = require('fs');
const ROOT = 'C:/Users/roger/MagicalStory';
const { Pool } = require(ROOT + '/node_modules/pg');
const { loadPromptTemplates } = require(ROOT + '/server/services/prompts');
const PB = require(ROOT + '/server/lib/promptBuilders');
const CO = require(ROOT + '/server/lib/ideaCoherence');
const { resolveReplayInputData, buildReplayTextArgs } = require(ROOT + '/server/lib/beatsReplayInputs');
const { resolveStoryBeats } = require(ROOT + '/server/lib/testlab');
const SH = require(ROOT + '/server/lib/storyHelpers');

const outDir = process.argv[2];
const EVIDENCE = ['ao77wh9j5', 'fre2mb4d0', '1tmyzh1do']; // the three Janna books (F2/F3 lead cases)

const k = (id) => id.split('_')[2];
const pick = (arr, n) => { // deterministic, evenly spread
  if (arr.length <= n) return arr;
  const out = []; for (let i = 0; i < n; i++) out.push(arr[Math.floor(i * arr.length / n)]);
  return out;
};

(async () => {
  await loadPromptTemplates();
  const pools = {
    prod: new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }),
    staging: new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } }),
  };
  for (const f of ['F1', 'F2', 'F3']) for (const a of ['old', 'new']) fs.mkdirSync(`${outDir}/${f}/${a}`, { recursive: true });
  const manifest = { F1: [], F2: [], F3: [] }; const failed = [];

  // ---------- F2 / F3 pool: stories with a STORY LOGIC arc, a re-telling and a page plan
  const arcRows = [];
  for (const env of ['prod', 'staging']) {
    const q = await pools[env].query(`select id, data from stories
      where data->'arcReviewReport'->>'committed' like 'STORY LOGIC:%'
        and data->'arcReviewReport'->'rounds'->0->>'retellPrompt' is not null
        and data->'arcReviewReport'->>'logic' is not null
      order by created_at desc`);
    for (const r of q.rows) if (!/_edittest$/.test(r.id) && !arcRows.find(x => x.id === r.id)) arcRows.push({ id: r.id, env, data: r.data });
  }
  const evidence = arcRows.filter(r => EVIDENCE.includes(k(r.id)));
  const rest = pick(arcRows.filter(r => !EVIDENCE.includes(k(r.id))), 17);
  const f23 = [...evidence, ...rest];

  const RULE = PB.ARC_CUT_NOT_ADD_RULE;
  for (const r of f23) {
    const d = r.data; const key = k(r.id);
    // F2
    try {
      const rep = d.arcReviewReport.rounds[0];
      const sp = String(rep.retellPrompt);
      const between = (a, b) => { const i = sp.indexOf(a); const j = sp.indexOf(b, i + a.length); if (i < 0 || j < 0) throw new Error('marker ' + a); return sp.slice(i + a.length, j).trim(); };
      const arcBlock = between('# THE ARC AND ITS STORY LOGIC', '# ISSUES TO REPAIR');
      const findings = between('# ISSUES TO REPAIR', '# YOUR TASK');
      const si = sp.search(/^# CHALLENGE IDEAS/m);
      let challenge = null;
      if (si >= 0) { const rest2 = sp.slice(si); const nx = rest2.slice(1).search(/^# /m); challenge = (nx >= 0 ? rest2.slice(0, nx + 1) : rest2).trimEnd(); }
      const pages = parseInt(d.pages, 10) || (d.sceneImages || []).length || 10;
      const inputData = resolveReplayInputData(d);
      const nw = PB.buildArcRetellPrompt(inputData, pages, arcBlock, findings, challenge ? { challengeIdeas: challenge } : {});
      const old = nw.split('- ' + RULE + '\n').join('');
      if (!nw || old === nw || old.includes(RULE) || /\{[A-Z_]{4,}\}/.test(nw.replace(arcBlock, '').replace(findings, ''))) throw new Error('build mismatch');
      fs.writeFileSync(`${outDir}/F2/new/${key}.txt`, nw); fs.writeFileSync(`${outDir}/F2/old/${key}.txt`, old);
      manifest.F2.push({ k: key, id: r.id, env: r.env, priorFacts: PB.parseStoryLogic(String(d.arcReviewReport.committed)).facts.length });
    } catch (e) { failed.push({ f: 'F2', id: r.id, why: e.message }); }
    // F3
    try {
      const inputData = d; // the Lab passes storyData
      const { beats } = resolveStoryBeats(d, { getPageText: SH.getPageText, extractSceneMetadata: SH.extractSceneMetadata });
      const ta = buildReplayTextArgs(d, beats, { parseBeats: SH.parseBeats });
      const nw = PB.buildStoryTextFromBeatsPrompt(inputData, ta.beats, ta.expansions, ta.arc, { arcHints: ta.arcHints, storyLogic: ta.storyLogic, visualBible: d.visualBible, clothingRequirements: d.clothingRequirements });
      const must = PB.buildMustSay(ta.storyLogic);
      if (!nw || !must) throw new Error('no must-say block (no stakes / motive in the stored logic)');
      const OLD_LB = nw.includes(PB.LOAD_BEARING_RULE) ? PB.LOAD_BEARING_RULE.replace('(motives, causes, feelings, background) is the arc\'s reasoning, and a page that leaves it out drops nothing - except what the MUST SAY lines hold (MUST_SAY_RULE).', '(motives, causes, stakes, feelings, background) is the arc\'s reasoning, and a page that leaves it out drops nothing.') : null;
      let old = nw.split('\n\n' + must).join('');
      if (OLD_LB) old = old.split(PB.LOAD_BEARING_RULE).join(OLD_LB);
      if (old === nw || old.includes('MUST SAY') || /\{[A-Z_]{4,}\}/.test(nw)) throw new Error('build mismatch');
      fs.writeFileSync(`${outDir}/F3/new/${key}.txt`, nw); fs.writeFileSync(`${outDir}/F3/old/${key}.txt`, old);
      manifest.F3.push({ k: key, id: r.id, env: r.env, pages: beats.length, mustSay: must });
    } catch (e) { failed.push({ f: 'F3', id: r.id, why: e.message }); }
  }

  // ---------- F1 pool: stored wizard idea prompts that carry the coherence rule
  const oldRuleWith = CO.coherenceRule({ withTopic: true }).replace(' ' + CO.MAIN_ACT_RULE, '');
  const oldRuleNo = CO.coherenceRule({ withTopic: false }).replace(' ' + CO.MAIN_ACT_RULE, '');
  const ideaRows = [];
  for (const env of ['prod', 'staging']) {
    const q = await pools[env].query(`select id, data->'ideaGeneration' ig from stories where data->'ideaGeneration'->>'prompt' is not null order by created_at desc`);
    for (const r of q.rows) {
      const p = String(r.ig.prompt);
      const rule = p.includes(oldRuleWith) ? oldRuleWith : (p.includes(oldRuleNo) ? oldRuleNo : null);
      if (!rule || /_edittest$/.test(r.id) || ideaRows.find(x => x.id === r.id)) continue;
      ideaRows.push({ id: r.id, env, prompt: p, rule, nChars: (r.ig.input && r.ig.input.characters || []).length });
    }
  }
  // every stored prompt that carries the rule: multi-character books (the defect's home) and the rest (clean negatives)
  const multi = ideaRows.filter(r => r.nChars >= 3);
  const single = ideaRows.filter(r => r.nChars < 3);
  for (const r of [...multi, ...single]) {
    const old = r.prompt;
    const nw = old.split(r.rule).join(r.rule + ' ' + CO.MAIN_ACT_RULE);
    fs.writeFileSync(`${outDir}/F1/new/${k(r.id)}.txt`, nw); fs.writeFileSync(`${outDir}/F1/old/${k(r.id)}.txt`, old);
    manifest.F1.push({ k: k(r.id), id: r.id, env: r.env, nChars: r.nChars });
  }
  fs.writeFileSync(outDir + '/manifest.json', JSON.stringify({ manifest, failed, pools: { f23: arcRows.length, f1: ideaRows.length } }, null, 1));
  console.log('F1', manifest.F1.length, 'F2', manifest.F2.length, 'F3', manifest.F3.length, 'failed', JSON.stringify(failed), 'pools', arcRows.length, ideaRows.length);
  await pools.prod.end(); await pools.staging.end(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
