// Stage 1: wardrobe writer (story-bible-from-beats) replayed with the CURRENT prompt over stored plan lines.
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
  const { resolveStoryBeats } = require(L.ROOT + '/server/lib/testlab');
  const { resolveReplayInputData, resolveReplayArc } = require(L.ROOT + '/server/lib/beatsReplayInputs');
  const { MODEL_DEFAULTS } = require(L.ROOT + '/server/config/models');
  const { UnifiedStoryParser } = require(L.ROOT + '/server/lib/outlineParser/unified');
  const outDir = path.join(__dirname, 'stage1');
  fs.mkdirSync(outDir, { recursive: true });
  let failures = 0;
  const items = L.ALL.filter(x => !only || only.includes(x.id));
  await L.pool(items, 3, async (it) => {
    const file = path.join(outDir, it.id + (process.env.REP ? '.r' + process.env.REP : '') + '.json');
    if (fs.existsSync(file) && !dry) return;
    if (failures >= 2) return;
    try {
      const sd = await L.loadStory(it.env, it.id);
      const input = resolveReplayInputData(sd);
      const { beats, source } = resolveStoryBeats(sd, { getPageText: H.getPageText, extractSceneMetadata: H.extractSceneMetadata });
      const prompt = H.buildStoryBibleFromBeatsPrompt(input, beats, { arc: resolveReplayArc(sd, { parseBeats: H.parseBeats }) });
      if (dry) { console.log(it.kind, it.id, 'beats', source, beats.length, 'prompt chars', prompt.length, 'cast', (sd.characters || []).length); return; }
      const { res, cost } = await L.paidCall({ stage: 'writer', storyId: it.id, prompt, model: MODEL_DEFAULTS.outline, opts: { usageLabel: 'nightwear_replay_bible', effort: MODEL_DEFAULTS.beatsPlanEffort }, outGuess: 7000 });
      let clothing = null;
      let parseError = null;
      try { clothing = new UnifiedStoryParser(res.text).extractClothingRequirements(); } catch (e) { parseError = e.message; }
      fs.writeFileSync(file, JSON.stringify({ ...it, title: sd.title, beatsSource: source, characters: (sd.characters || []).map(c => ({ name: c.name, age: c.age, gender: c.gender })), model: res.modelId, cost, usage: res.usage, prompt, raw: res.text, clothing, parseError }, null, 1));
      console.log('ok', it.id, '$' + cost.toFixed(4), 'cum', L.spent().toFixed(3));
    } catch (e) {
      if (e.capStop) { console.log('CAP', e.message); failures = 99; return; }
      failures++;
      console.log('FAIL', it.id, e.message.slice(0, 200));
    }
  });
  await L.closePools();
  process.exit(0);
})();
