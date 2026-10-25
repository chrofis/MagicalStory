// Stage 2: wardrobe review (clothing-review.txt) replayed with the CURRENT prompt.
//   arm A: the bible stage 1 just wrote (what production would hand the reviewer) - all stories.
//   arm B: the STORED bible (written before nightwear existed: no nightwear key) - positives only; tests check 9 adding a missing entry.
const fs = require('fs');
const path = require('path');
const L = require('./lib');
(async () => {
  const dry = process.argv.includes('--dry');
  const { loadPromptTemplates } = require(L.ROOT + '/server/services/prompts');
  await loadPromptTemplates();
  const H = require(L.ROOT + '/server/lib/storyHelpers');
  const PB = require(L.ROOT + '/server/lib/promptBuilders');
  const { resolveStoryBeats } = require(L.ROOT + '/server/lib/testlab');
  const { MODEL_DEFAULTS } = require(L.ROOT + '/server/config/models');
  const outDir = path.join(__dirname, 'stage2');
  fs.mkdirSync(outDir, { recursive: true });
  let failures = 0;
  const jobs = [];
  for (const it of L.ALL) {
    jobs.push({ ...it, arm: 'A' });
    if (it.kind !== 'negative') jobs.push({ ...it, arm: 'B' });
  }
  await L.pool(jobs, 3, async (j) => {
    const file = path.join(outDir, `${j.id}.${j.arm}.json`);
    if (fs.existsSync(file) && !dry) return;
    if (failures >= 2) return;
    try {
      const sd = await L.loadStory(j.env, j.id);
      const s1 = JSON.parse(fs.readFileSync(path.join(__dirname, 'stage1', j.id + '.json'), 'utf8'));
      const before = JSON.parse(JSON.stringify(j.arm === 'A' ? s1.clothing : sd.clothingRequirements));
      const { beats } = resolveStoryBeats(sd, { getPageText: H.getPageText, extractSceneMetadata: H.extractSceneMetadata });
      const prompt = PB.buildClothingReviewPrompt(sd, before, beats);
      if (!prompt) throw new Error('clothing-review prompt unavailable');
      if (dry) { console.log(j.arm, j.id, 'chars', prompt.length); return; }
      const { res, cost } = await L.paidCall({ stage: 'review' + j.arm, storyId: j.id, prompt, model: MODEL_DEFAULTS.clothingReviewModel, opts: { usageLabel: 'nightwear_replay_review', reasoning: MODEL_DEFAULTS.clothingReviewReasoning }, outGuess: 4000 });
      const parsed = H.parseClothingReview(res.text || '');
      // Apply exactly as beatsPipeline does (lookup, check-9 add, fix).
      const after = JSON.parse(JSON.stringify(before));
      const changed = [];
      const stray = [];
      for (const fix of parsed.entries) {
        const name = Object.keys(after).find(n => n.toLowerCase() === fix.name.toLowerCase());
        let entry = name ? after[name]?.[fix.category] : null;
        entry = PB.acceptAddedWardrobeCategory(after, name, fix, entry);
        if (!entry || !entry.used) { stray.push(`${fix.name}/${fix.category}`); continue; }
        if ((entry.description || '') === fix.description) continue;
        changed.push({ name, category: fix.costume ? `costumed:${fix.costume}` : fix.category, before: entry.description || '', after: fix.description });
        H.applyClothingFix(entry, fix, `${name}/${fix.category}`);
      }
      fs.writeFileSync(file, JSON.stringify({ ...j, title: sd.title, model: res.modelId, cost, usage: res.usage, prompt, raw: res.text, analysis: parsed.analysis, entries: parsed.entries, changed, stray, before, after }, null, 1));
      console.log('ok', j.arm, j.id, '$' + cost.toFixed(4), 'cum', L.spent().toFixed(3));
    } catch (e) {
      if (e.capStop) { console.log('CAP', e.message); failures = 99; return; }
      failures++;
      console.log('FAIL', j.arm, j.id, e.message.slice(0, 200));
    }
  });
  await L.closePools();
  process.exit(0);
})();
