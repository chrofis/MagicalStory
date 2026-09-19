/**
 * Round 10 — measures the trial-idea SELF-CHECK against the same prompt without it.
 *
 * Both variants are built from ONE buildTrialIdeaPrompts() call per cell, so the
 * baseline arm is byte-for-byte the pre-commit prompt (same variety axes, same
 * band, same everything) minus the self-check block. That makes the before/after
 * a within-run comparison on identical cells rather than a cross-session one.
 *
 * Ideas only. No images, no story generation.
 *   node tests/manual/trial-idea-round10.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const tpl = fs.readFileSync(path.join(ROOT, 'prompts/trial-idea.txt'), 'utf8');
const pb = require(path.join(ROOT, 'server/lib/promptBuilders'));
const chk = require(path.join(ROOT, 'server/lib/trialIdeaCheck'));
const { callTextModelStreaming } = require(path.join(ROOT, 'server/lib/textModels'));
const { getLanguageInstruction } = require(path.join(ROOT, 'server/lib/languages'));
const { buildThemePlaySentence } = require(path.join(ROOT, 'server/config/storyThemes'));
const { buildSeasonInstruction } = require(path.join(ROOT, 'server/lib/season'));
const { getTrialTitle } = require(path.join(ROOT, 'server/config/trialTitles'));
const { getTrialCostumeForStory } = require(path.join(ROOT, 'server/config/trialCostumes'));

const MODEL = 'claude-sonnet';
const LANG = 'de';
const TOWN = 'Fislisbach';

// ages 1/2/3/4/5/8/12 x male/female, one age-appropriate life challenge each.
// waiting-turn (Zara) and going-outside (Mia) are the two cells round 9 reported
// as BOTH-CARDS-MISS; getting-dressed is the half-broken third.
const CELLS = [
  { name: 'Noah',  age: 1,  gender: 'male',   topic: 'first-steps',       theme: 'farm' },
  { name: 'Mia',   age: 1,  gender: 'female', topic: 'going-outside',     theme: 'forest' },
  { name: 'Liam',  age: 2,  gender: 'male',   topic: 'first-words',       theme: 'dinosaur' },
  { name: 'Emma',  age: 2,  gender: 'female', topic: 'getting-dressed',   theme: 'unicorn' },
  { name: 'Ben',   age: 3,  gender: 'male',   topic: 'potty-training',    theme: 'fireman' },
  { name: 'Lina',  age: 3,  gender: 'female', topic: 'brushing-teeth',    theme: 'mermaid' },
  { name: 'Elias', age: 4,  gender: 'male',   topic: 'cleaning-up',       theme: 'pirate' },
  { name: 'Sofia', age: 4,  gender: 'female', topic: 'sharing',           theme: 'princess' },
  { name: 'Jonas', age: 5,  gender: 'male',   topic: 'being-brave',       theme: 'knight' },
  { name: 'Zara',  age: 5,  gender: 'female', topic: 'waiting-turn',      theme: 'ocean' },
  { name: 'Luca',  age: 8,  gender: 'male',   topic: 'homework',          theme: 'detective' },
  { name: 'Nora',  age: 8,  gender: 'female', topic: 'making-friends',    theme: 'space' },
  { name: 'Finn',  age: 12, gender: 'male',   topic: 'not-giving-up',     theme: 'dragon' },
  { name: 'Alina', age: 12, gender: 'female', topic: 'managing-emotions', theme: 'jungle' },
];

function categoryContextFor(topic, theme) {
  const { getTeachingGuide } = pb;
  const themeSentence = buildThemePlaySentence(theme);
  const guide = getTeachingGuide('life-challenge', topic);
  return `This is a life skills story about "${topic}". The idea names one outside event that forces the child to use this skill — something that happens in the world, never a feeling on its own — and what it costs them.${themeSentence ? ` ${themeSentence}` : ''}${guide ? `\nGuidance for this topic:\n${String(guide).trim()}` : ''}`;
}

const stripCheck = p => p.replace(`\n\n${chk.TRIAL_IDEA_SELF_CHECK_RULE}`, '');

async function call(prompt, bag) {
  const t = Date.now();
  const r = await callTextModelStreaming(prompt, null, null, MODEL, { usageLabel: 'trial_idea_round10' });
  bag.push({ ms: Date.now() - t, usage: r.usage, modelId: r.modelId });
  return String(r.text || '');
}

async function runCell(cell, out, timing) {
  {
    const char = { name: cell.name, age: cell.age, gender: cell.gender };
    const charDesc = `${cell.name}, ${cell.age} years old, ${cell.gender}`;
    const args = {
      template: tpl,
      characters: [char],
      charDesc,
      categoryContext: categoryContextFor(cell.topic, cell.theme),
      landmarksText: 'At least one scene must take place at one of these real local landmarks: Reformierte Kirche Fislisbach, Schulhaus Birch, Waldhütte Fislisbach.',
      townName: TOWN,
      storyTheme: cell.theme,
      trialTitle: getTrialTitle(cell.topic, 'life-challenge', cell.gender, LANG),
      langInstruction: getLanguageInstruction(LANG),
      seasonInstruction: buildSeasonInstruction({}),
      ideaCostume: getTrialCostumeForStory({ storyCategory: 'life-challenge', storyTheme: cell.theme, storyTopic: cell.topic, gender: cell.gender }),
    };
    // ONE draw of the axes, used by both variants.
    const prompts = pb.buildTrialIdeaPrompts(args);
    const row = { cell, arms: {} };
    for (const arm of ['local', 'fantasy']) {
      const withCheck = prompts[arm];
      const baselinePrompt = stripCheck(withCheck);
      if (baselinePrompt === withCheck) throw new Error('self-check block not found in built prompt');

      const [baselineRaw, checkedRaw] = await Promise.all([
        call(baselinePrompt, timing.baseline),
        call(withCheck, timing.selfcheck),
      ]);

      const entry = { baseline: baselineRaw.trim(), prompts: { chars: withCheck.length } };
      try {
        let parsed = chk.parseIdeaSelfCheck(checkedRaw);
        entry.first = { idea: parsed.idea, event: parsed.event, act: parsed.act, ok: parsed.ok, failure: parsed.failure };
        if (!parsed.ok) {
          const rerunRaw = await call(chk.buildIdeaRerunPrompt(withCheck, parsed), timing.rerun);
          const re = chk.parseIdeaSelfCheck(rerunRaw);
          entry.rerun = { idea: re.idea, event: re.event, act: re.act, ok: re.ok, failure: re.failure };
          entry.final = re.idea;
        } else {
          entry.final = parsed.idea;
        }
      } catch (err) {
        entry.parseError = err.message;
        entry.raw = checkedRaw;
      }
      row.arms[arm] = entry;
    }
    out.push(row);
    process.stderr.write(`cell ${cell.name}/${cell.topic} done\n`);
  }
}

(async () => {
  const out = [];
  const timing = { baseline: [], selfcheck: [], rerun: [] };
  const CONC = 4;
  for (let i = 0; i < CELLS.length; i += CONC) {
    await Promise.all(CELLS.slice(i, i + CONC).map(c => runCell(c, out, timing)));
  }
  out.sort((a, b) => CELLS.indexOf(a.cell) - CELLS.indexOf(b.cell));
  const sum = a => a.reduce((s, x) => s + x, 0);
  const cost = list => sum(list.map(x => x.usage?.direct_cost || 0));
  const report = {
    model: MODEL,
    cells: out,
    timing: {
      baselineMs: timing.baseline.map(x => x.ms),
      selfcheckMs: timing.selfcheck.map(x => x.ms),
      rerunMs: timing.rerun.map(x => x.ms),
      baselineMean: Math.round(sum(timing.baseline.map(x => x.ms)) / timing.baseline.length),
      selfcheckMean: Math.round(sum(timing.selfcheck.map(x => x.ms)) / timing.selfcheck.length),
      rerunMean: timing.rerun.length ? Math.round(sum(timing.rerun.map(x => x.ms)) / timing.rerun.length) : null,
      baselineOutTokens: timing.baseline.map(x => x.usage?.output_tokens),
      selfcheckOutTokens: timing.selfcheck.map(x => x.usage?.output_tokens),
    },
    cost: { baseline: cost(timing.baseline), selfcheck: cost(timing.selfcheck), rerun: cost(timing.rerun) },
  };
  fs.writeFileSync(path.join(ROOT, 'tests/manual/round10-out.json'), JSON.stringify(report, null, 2));
  console.log('written tests/manual/round10-out.json');
})().catch(e => { console.error(e); process.exit(1); });
