// Stage 3: Art Director call 2 (scene-briefs-all.txt) replayed with the CURRENT prompt.
// Inputs: the stored plan lines + the stored per-page Jev FIXED data + the STORED Visual Bible (all as the run held them),
// the cover beats built by the real buildCoverBeats (cover place undecided = the production fallback shape),
// and the wardrobe the new stage 1 + stage 2 (arm A) produced, so the AD sees a nightwear entry.
// Not rebuilt: the Visual Bible call 1 and the Jev decisions (stored values are used).
const fs = require('fs');
const path = require('path');
const L = require('./lib');
(async () => {
  const dry = process.argv.includes('--dry');
  const onlyArg = process.argv.find(a => a.startsWith('--only='));
  const only = onlyArg ? onlyArg.split('=')[1].split(',') : null;
  const { loadPromptTemplates } = require(L.ROOT + '/server/services/prompts');
  await loadPromptTemplates();
  const H = require(L.ROOT + '/server/lib/storyHelpers');
  const { resolveReplayInputData, resolveReplayArc, resolveReplayCentralFigure } = require(L.ROOT + '/server/lib/beatsReplayInputs');
  const { MODEL_DEFAULTS, IMAGE_MODELS } = require(L.ROOT + '/server/config/models');
  const { buildAvailableAvatarsForPrompt } = require(L.ROOT + '/server/lib/clothingResolve');
  const { visualBibleJsonOf } = require(L.ROOT + '/server/lib/jevBriefFields');
  const { buildCoverBeats } = require(L.ROOT + '/server/lib/coverBeats');
  const { coverTypesFor } = require(L.ROOT + '/server/lib/coverKeys');
  const effort = require(L.ROOT + '/server/config/runtime').runtime('adBriefsReasoningEffort'); // = beatsPipeline.adBriefsCallOptions
  const model = MODEL_DEFAULTS.sceneBriefsModel;
  const outDir = path.join(__dirname, 'stage3');
  fs.mkdirSync(outDir, { recursive: true });
  let failures = 0;
  const items = L.ALL.filter(x => (x.kind === 'positive' || x.kind === 'negative') && (!only || only.includes(x.id)));
  await L.pool(items, 2, async (it) => {
    const file = path.join(outDir, it.id + (process.env.REP ? '.r' + process.env.REP : '') + '.json');
    if (fs.existsSync(file) && !dry) return;
    if (failures >= 2) return;
    try {
      const sd = await L.loadStory(it.env, it.id);
      const input = resolveReplayInputData(sd);
      const clothing = JSON.parse(fs.readFileSync(path.join(__dirname, 'stage2', it.id + '.A.json'), 'utf8')).after;
      const planOf = (b) => ((String(b.brief || '').match(/(?:^|\n)\s*PLAN:\s*([\s\S]*)$/i) || [])[1] || '').trim();
      const stored = new Map((sd.sceneImages || []).map(s => [s.pageNumber, s]));
      const beats = (sd.beatsReviewReport.briefsIn || []).map(b => ({ pageNumber: b.pageNumber, planLine: planOf(b), jevFixed: stored.get(b.pageNumber)?.jevFixed || undefined })).filter(b => b.planLine);
      const covers = buildCoverBeats(input, { coverTypes: coverTypesFor(input), clothingRequirements: clothing, centralFigure: resolveReplayCentralFigure(sd), placeDecided: false });
      const briefBeats = [...beats, ...covers];
      const vbJson = visualBibleJsonOf(sd.outline);
      if (!vbJson) throw new Error('stored outline has no Visual Bible JSON');
      const imgCfg = IMAGE_MODELS[(sd.modelOverrides && sd.modelOverrides.imageModel) || MODEL_DEFAULTS.pageRenderImage];
      const prompt = H.buildSceneBriefsAllPrompt(input, briefBeats, {
        jevBackup: false, availableAvatars: buildAvailableAvatarsForPrompt(input.characters || [], clothing),
        maxCharactersPerScene: (imgCfg && imgCfg.maxCharactersPerScene) || 3,
        finalArc: resolveReplayArc(sd, { parseBeats: H.parseBeats }), clothingRequirements: clothing, visualBible: vbJson,
      });
      if (!prompt) throw new Error('scene-briefs-all prompt unavailable');
      if (dry) { console.log(it.kind, it.id, 'pages', beats.length, 'covers', covers.length, 'prompt chars', prompt.length, 'jevFixed pages', beats.filter(b => b.jevFixed).length); return; }
      const { res, cost } = await L.paidCall({ stage: 'ad', storyId: it.id, prompt, model, opts: { usageLabel: 'nightwear_replay_ad', ...(effort ? { reasoning: { effort } } : {}) }, outGuess: 24000 });
      const parsed = H.parseRefinedText(res.text || '', briefBeats.map(b => b.pageNumber), 'SCENES', H.BRIEF_TRAILING_MARKERS);
      fs.writeFileSync(file, JSON.stringify({ ...it, title: sd.title, model: res.modelId, cost, usage: res.usage, covers: covers.map(c => c.pageNumber), prompt, raw: res.text, pages: parsed.pages }, null, 1));
      console.log('ok', it.id, '$' + cost.toFixed(4), 'pages parsed', parsed.pages.length, 'of', briefBeats.length, 'cum', L.spent().toFixed(3));
    } catch (e) {
      if (e.capStop) { console.log('CAP', e.message); failures = 99; return; }
      failures++;
      console.log('FAIL', it.id, e.message.slice(0, 300));
    }
  });
  await L.closePools();
  process.exit(0);
})();
