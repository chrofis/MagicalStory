/**
 * Trial idea coherence eval: generates the two idea cards per grid cell with the
 * REAL prompt builder (buildTrialIdeaPrompts, as server/routes/trial.js) and the
 * real model, then writes inputs + outputs to evals/runs/<run>/.
 *
 *   node scripts/analysis/eval-trial-idea-coherence.js --path=trial|wizard --phase=before|after [--cells=c01,c02] [--out=dir]
 *
 * before: today's path (self-check, one rerun on a failed self-check).
 * after:  the same, plus (trial only) the Jev coherence check; a failing card reruns ONCE with
 *         the reason fed back (trialIdeaCheck.judgeIdeaCard, the function the route calls).
 * Ideas only: no images, no story, no trial account.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '../..');
const arg = n => (process.argv.find(a => a.startsWith(`--${n}=`)) || '').split('=')[1];
const phase = arg('phase') || 'before';
const only = arg('cells') ? arg('cells').split(',') : null;
const which = arg('path') || 'trial'; // trial | wizard
const outDir = arg('out') || path.join(ROOT, 'evals/runs/2026-10-09_trial-idea-coherence', `${which}-${phase}`);
const grid = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/trial-idea-coherence-v1/grid.json'), 'utf8'));

(async () => {
  const { loadPromptTemplates } = require(path.join(ROOT, 'server/services/prompts'));
  await loadPromptTemplates();
  const pb = require(path.join(ROOT, 'server/lib/promptBuilders'));
  const chk = require(path.join(ROOT, 'server/lib/trialIdeaCheck'));
  const { callTextModelStreaming } = require(path.join(ROOT, 'server/lib/textModels'));
  const { getLanguageInstruction } = require(path.join(ROOT, 'server/lib/languages'));
  const { buildSeasonInstruction } = require(path.join(ROOT, 'server/lib/season'));
  const { getTrialTitle } = require(path.join(ROOT, 'server/config/trialTitles'));
  const { getTrialCostumeForStory } = require(path.join(ROOT, 'server/config/trialCostumes'));
  const { MODEL_DEFAULTS, priceUsage } = require(path.join(ROOT, 'server/config/models'));
  fs.mkdirSync(outDir, { recursive: true });

  let spend = 0;
  const callModel = async (prompt, tag) => {
    const t = Date.now();
    const r = await callTextModelStreaming(prompt, null, null, 'claude-sonnet', { usageLabel: 'trial_idea_coherence_eval', effort: MODEL_DEFAULTS.trialIdeaEffort });
    const cost = priceUsage(r.modelId || '', r.usage || {});
    spend += cost;
    return { text: String(r.text || ''), ms: Date.now() - t, cost, tag };
  };

  const runCell = async (cell) => {
    const char = { name: cell.name, age: cell.age, gender: cell.gender };
    const charDesc = `${cell.name}, ${cell.age} years old, ${cell.gender}`;
    // Same inline category context as the route (server/routes/trial.js).
    const categoryContext = cell.category === 'life-challenge'
      ? pb.buildTrialLifeChallengeContext(cell.topic, cell.theme)
      : `This is a ${cell.theme || 'adventure'} story. Make it exciting and appropriate for children.`;
    let landmarksText = '';
    if (cell.town) {
      const idea = await require(path.join(ROOT, 'server/lib/jevSelection')).trialIdeaLandmarks(
        { characters: [char], storyCategory: cell.category, storyTheme: cell.theme, storyTopic: cell.topic, language: cell.language,
          userLocation: { city: cell.town, country: 'Switzerland', latitude: 47.3769, longitude: 8.5417 } }, { wait: true });
      landmarksText = idea.text;
    }
    const prompts = pb.buildTrialIdeaPrompts({
      characters: [char], charDesc, categoryContext, landmarksText, townName: cell.town || '',
      storyTheme: cell.theme, trialTitle: getTrialTitle(cell.topic, cell.category, cell.gender, cell.language),
      langInstruction: getLanguageInstruction(cell.language), seasonInstruction: buildSeasonInstruction({}),
      ideaCostume: getTrialCostumeForStory({ storyCategory: cell.category, storyTheme: cell.theme, storyTopic: cell.topic, gender: cell.gender }),
    });
    const row = { cell, landmarksText, cards: {} };
    await Promise.all(['local', 'fantasy'].map(async (arm) => {
      const base = prompts[arm];
      const card = { calls: [] };
      try {
        const first = await callModel(base, 'first'); card.calls.push(first);
        let parsed = chk.parseIdeaSelfCheck(first.text);
        card.first = { idea: parsed.idea, ok: parsed.ok, failure: parsed.failure, event: parsed.event, act: parsed.act };
        if (phase === 'after') {
          const t = Date.now();
          parsed = await chk.judgeIdeaCard(parsed, { topic: cell.topic, theme: cell.theme });
          card.jevMs = Date.now() - t; card.jev = parsed.jev;
        }
        if (!parsed.ok) {
          const rr = await callModel(chk.buildIdeaRerunPrompt(base, parsed), 'rerun'); card.calls.push(rr);
          parsed = chk.parseIdeaSelfCheck(rr.text);
          card.rerun = { idea: parsed.idea, ok: parsed.ok, failure: parsed.failure };
        }
        card.final = parsed.idea;
      } catch (e) { card.error = e.message; }
      row.cards[arm] = card;
    }));
    process.stderr.write(`${cell.id} done\n`);
    return row;
  };

  // ── wizard path: the real buildIdeasPromptContext + buildStreamArmPrompts + streamIdeaArm (fake res) ──
  const runWizardCell = async (cell) => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'eval';
    const wiz = require(path.join(ROOT, 'server/routes/storyIdeas'));
    const { resolveAvailableLandmarks } = require(path.join(ROOT, 'server/lib/landmarkPhotos'));
    const { coherenceRule } = require(path.join(ROOT, 'server/lib/ideaCoherence'));
    const characters = [{ name: cell.name, age: cell.age, gender: cell.gender, isMain: true, traits: {} }];
    const location = cell.town ? { city: cell.town, region: 'Zürich', country: 'Switzerland' } : null;
    const landmarks = location ? await resolveAvailableLandmarks(location, { limit: 20, discoverOnMiss: false, language: cell.language }) : [];
    const userLocationInstruction = location ? `**LOCATION PREFERENCE**: Set the story in or near ${location.city}, ${location.region}, ${location.country}. Use real local landmarks, street names, parks, or recognizable places from this area to make the story feel personal and familiar to the reader. The main characters live in this area.` : '';
    const ctx = await wiz.buildIdeasPromptContext({
      storyCategory: cell.category, storyTopic: cell.topic, storyTheme: cell.theme, storyTypeName: undefined, customThemeText: undefined,
      language: cell.language, languageLevel: 'standard', characters, relationships: [], pages: 10,
      userLocationInstruction, availableLandmarksSection: landmarks.length ? wiz.buildIdeaLandmarksSection(landmarks) : '',
      seasonInstruction: buildSeasonInstruction({}),
    });
    const ideaWorlds = wiz.resolveIdeaWorlds({ storyCategory: cell.category, storyTheme: cell.theme, location, worldMode: 'auto' });
    let prompts = wiz.buildStreamArmPrompts({ ctx, ideaWorlds, characters, storyTopic: cell.topic, storyTheme: cell.theme, language: cell.language });
    const coherence = ideaCoherenceContext({ storyCategory: cell.category, storyTopic: cell.topic, storyTheme: cell.theme });
    if (phase === 'before') {
      // The pre-change prompt: the shared rule's paragraph removed (it is its own paragraph in the template).
      const rule = `

${coherenceRule({ withTopic: cell.category === 'life-challenge' })}`;
      prompts = prompts.map(pr => { if (!pr.includes(rule)) throw new Error('coherence rule not found in wizard prompt'); return pr.replace(rule, ''); });
    }
    const row = { cell, landmarks: landmarks.slice(0, 5).map(l => l.name), cards: {} };
    await Promise.all(prompts.map(async (prompt, i) => {
      const events = [];
      const res = { write: chunk => { const m = String(chunk).match(/^data: ([\s\S]*?)\s*$/); if (m) events.push(JSON.parse(m[1])); } };
      const t = Date.now();
      const arm = await wiz.streamIdeaArm({ arm: i, prompt, res, callStreaming: callTextModelStreaming, model: 'claude-sonnet' });
      const cost = priceUsage(arm.modelId || '', arm.usage || {});
      spend += cost;
      row.cards[ideaWorlds ? ideaWorlds[i].world : i] = { final: arm.idea, jev: arm.jev, ms: Date.now() - t, cost, error: events.find(e => e.error)?.error || null, rerun: false };
    }));
    process.stderr.write(`${cell.id} done
`);
    return row;
  };

  const runner = which === 'wizard' ? runWizardCell : runCell;
  const cells = grid.cells.filter(c => !only || only.includes(c.id));
  const rows = [];
  // --cap=<usd>: stop launching batches when spend plus the worst-case batch (4 cells, ~USD 0.04 per card with a rerun) would pass it.
  const cap = Number(arg('cap')) || Infinity;
  for (let i = 0; i < cells.length; i += 4) {
    if (spend + 0.32 * 0.5 > cap) { console.log(`cap ${cap}: stopped before batch at cell ${i}, spend ${spend.toFixed(4)}`); break; }
    rows.push(...await Promise.all(cells.slice(i, i + 4).map(runner)));
  }
  fs.writeFileSync(path.join(outDir, 'out.json'), JSON.stringify({ path: which, phase, date: new Date().toISOString(), spendUsd: spend, rows }, null, 2));
  console.log(`wrote ${outDir}/out.json  cards=${rows.length * 2}  spend=$${spend.toFixed(4)}`);
})().catch(e => { console.error(e); process.exit(1); });
