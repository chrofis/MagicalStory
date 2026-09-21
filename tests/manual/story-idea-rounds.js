/**
 * Story-idea quality rounds (FULL wizard) — fixed cells, reusable across rounds.
 *
 * Replicates POST /generate-story-ideas-stream (server/routes/storyIdeas.js) exactly:
 * same landmark resolver, same location/season instructions, same
 * buildIdeasPromptContext + resolveIdeaWorlds, same two prompts, same [FINAL] parse.
 * Only the model output varies between rounds; the cells are deterministic.
 *
 *   node tests/manual/story-idea-rounds.js --round=1
 *
 * Writes tests/manual/story-idea-rounds/round-N.json (full prompts + raw replies)
 * and round-N.md (the 20 ideas, human-readable).
 *
 * Landmarks come from the STAGING database, discoverOnMiss:false — discovery
 * spawns paid indexing and must never run from here.
 */
require('dotenv').config();
if (process.env.STAGING_DATABASE_URL) process.env.DATABASE_URL = process.env.STAGING_DATABASE_URL;

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '../..');

require(path.join(ROOT, 'server/services/database')).initializePool();
const { resolveAvailableLandmarks } = require(path.join(ROOT, 'server/lib/landmarkPhotos'));
const { buildIdeasPromptContext, resolveIdeaWorlds, buildVariantInstructions, premiseShapeInstruction } = require(path.join(ROOT, 'server/routes/storyIdeas'));
// The server loads every prompts/*.txt at boot (server.js). Without this call
// PROMPT_TEMPLATES is empty here, so buildAgeModeSection returned NO age-band
// plot-shape rules and rounds 1-7 rated a prompt production never sends.
const { loadPromptTemplates } = require(path.join(ROOT, 'server/services/prompts'));
const { buildSeasonInstruction } = require(path.join(ROOT, 'server/lib/season'));
const { worldSeedInstruction } = require(path.join(ROOT, 'server/lib/worldSeeds'));
const { callTextModelStreaming, getModelDefaults } = require(path.join(ROOT, 'server/lib/textModels'));

const { MODEL_PRICING } = require(path.join(ROOT, 'server/config/models'));

// Default = what production sends (claude-sonnet). --model=<id> overrides it for
// MEASUREMENT runs only (e.g. --model=claude-opus to separate prompt from model);
// it never changes what the route uses. Ids come from TEXT_MODELS in
// server/config/models.js.
const MODEL = (process.argv.find(a => a.startsWith('--model=')) || '').split('=')[1] || getModelDefaults().idea;

// The Anthropic streaming path reports tokens, not a charge (direct_cost is only
// populated by providers that bill a real amount back). Price them with the
// repo's own MODEL_PRICING table so a round's cost is not guessed.
function costOf(usage, modelId) {
  if (usage?.direct_cost) return usage.direct_cost;
  const p = MODEL_PRICING[modelId] || MODEL_PRICING[MODEL];
  if (!p) return 0;
  return ((usage?.input_tokens || 0) * p.input + (usage?.output_tokens || 0) * p.output) / 1e6;
}
const LOCATION = { city: 'Baden', region: 'Aargau', country: 'Switzerland' };
const OUT_DIR = path.join(__dirname, 'story-idea-rounds');
const STRANGERS_DE = require(path.join(ROOT, 'shared/relationship-sentinels.json')).strangers.de;

const ch = (name, age, gender, isMain, specialDetails) => ({
  name, age, gender, isMain, traits: {},
  ...(specialDetails ? { specialDetails } : {}),
});

// ---- The 10 cells. Fixed across every round; never edit between rounds. ----
const CELLS = [
  { id: 1, language: 'de', pages: 10, languageLevel: '1st-grade', storyCategory: 'adventure', storyTheme: 'pirate',
    characters: [ch('Noah', 3, 'male', true)], relationships: [] },
  { id: 2, language: 'de', pages: 12, languageLevel: '1st-grade', storyCategory: 'life-challenge', storyTopic: 'making-friends', storyTheme: 'realistic',
    characters: [ch('Mia', 5, 'female', true), ch('Leo', 8, 'male', false)],
    relationships: [{ character1: 'Leo', character2: 'Mia', relationship: 'is the sibling of' }] },
  { id: 3, language: 'de', pages: 16, languageLevel: 'standard', storyCategory: 'adventure', storyTheme: 'wizard',
    characters: [ch('Elias', 7, 'male', true), ch('Sofia', 7, 'female', true), ch('Oma Ruth', 68, 'female', false)],
    relationships: [
      { character1: 'Sofia', character2: 'Elias', relationship: 'is the friend of' },
      { character1: 'Oma Ruth', character2: 'Elias', relationship: 'is the grandmother of' }] },
  { id: 4, language: 'de', pages: 20, languageLevel: 'standard', storyCategory: 'historical', storyTopic: 'moon-landing',
    characters: [ch('Luca', 9, 'male', true), ch('Nora', 6, 'female', false), ch('Papa Daniel', 41, 'male', false), ch('Bello', 4, 'male', false, 'a brown dog')],
    relationships: [
      { character1: 'Nora', character2: 'Luca', relationship: 'is the sister of' },
      { character1: 'Papa Daniel', character2: 'Luca', relationship: 'is the father of' },
      { character1: 'Bello', character2: 'Luca', relationship: 'is the pet of' }] },
  { id: 5, language: 'de', pages: 18, languageLevel: 'advanced', storyCategory: 'life-challenge', storyTopic: 'not-giving-up', storyTheme: 'space',
    characters: [ch('Finn', 12, 'male', true), ch('Alina', 12, 'female', true), ch('Jonas', 10, 'male', false), ch('Lina', 11, 'female', false), ch('Herr Keller', 45, 'male', false)],
    relationships: [
      { character1: 'Alina', character2: 'Finn', relationship: 'is the classmate of' },
      { character1: 'Jonas', character2: 'Finn', relationship: 'is the friend of' },
      { character1: 'Lina', character2: 'Finn', relationship: 'is the friend of' },
      { character1: 'Herr Keller', character2: 'Finn', relationship: 'is the teacher of' }] },
  { id: 6, language: 'de', pages: 14, languageLevel: '1st-grade', storyCategory: 'adventure', storyTheme: 'dinosaur',
    characters: [ch('Emma', 4, 'female', true), ch('Ben', 6, 'male', false), ch('Mama Sara', 38, 'female', false), ch('Papa Tom', 40, 'male', false), ch('Opa Hans', 70, 'male', false), ch('Zara', 4, 'female', false)],
    relationships: [
      { character1: 'Ben', character2: 'Emma', relationship: 'is the brother of' },
      { character1: 'Mama Sara', character2: 'Emma', relationship: 'is the mother of' },
      { character1: 'Papa Tom', character2: 'Emma', relationship: 'is the father of' },
      { character1: 'Opa Hans', character2: 'Emma', relationship: 'is the grandfather of' },
      { character1: 'Zara', character2: 'Emma', relationship: 'is the friend of' }] },
  { id: 7, language: 'de', pages: 10, languageLevel: '1st-grade', storyCategory: 'life-challenge', storyTopic: 'going-outside', storyTheme: 'farm',
    characters: [ch('Lena', 1, 'female', true)], relationships: [] },
  { id: 8, language: 'de', pages: 16, languageLevel: 'standard', storyCategory: 'historical', storyTopic: 'wright-brothers',
    characters: [ch('Amir', 10, 'male', true), ch('Yara', 8, 'female', false)],
    relationships: [{ character1: 'Yara', character2: 'Amir', relationship: 'is the sister of' }] },
  { id: 9, language: 'fr', pages: 12, languageLevel: 'standard', storyCategory: 'adventure', storyTheme: 'knight',
    characters: [ch('Chloé', 6, 'female', true), ch('Théo', 9, 'male', false), ch('Maman Élodie', 36, 'female', false)],
    relationships: [
      { character1: 'Théo', character2: 'Chloé', relationship: 'est le frère de' },
      { character1: 'Maman Élodie', character2: 'Chloé', relationship: 'est la mère de' }] },
  { id: 10, language: 'de', pages: 20, languageLevel: 'standard', storyCategory: 'life-challenge', storyTopic: 'managing-emotions', storyTheme: 'dragon',
    characters: [ch('Jonas', 8, 'male', true), ch('Mila', 8, 'female', true)],
    relationships: [{ character1: 'Jonas', character2: 'Mila', relationship: STRANGERS_DE }] },
];

// Verbatim from the route.
const parseFinal = (text) => {
  const matches = [...text.matchAll(/\[FINAL\]\s*/gi)];
  if (matches.length === 0) return null;
  const lastMatch = matches[matches.length - 1];
  let result = text.slice(lastMatch.index + lastMatch[0].length).trim();
  result = result.replace(/<budget:[^>]*>[\s\S]*?<\/budget:[^>]*>/gi, '').trim();
  result = result.replace(/<[a-z_]+:[^>]*>[\s\S]*?<\/[a-z_]+:[^>]*>/gi, '').trim();
  return result;
};

const landmarkCache = new Map();
async function landmarksFor(language) {
  if (!landmarkCache.has(language)) {
    landmarkCache.set(language, await resolveAvailableLandmarks(LOCATION, { limit: 20, discoverOnMiss: false, language }));
  }
  return landmarkCache.get(language);
}

async function buildCellPrompts(cell) {
  const { storyCategory, storyTopic, storyTheme, language, languageLevel, characters, relationships, pages } = cell;
  const effectiveCategory = storyCategory || 'adventure';

  const availableLandmarks = (LOCATION.city && effectiveCategory !== 'historical')
    ? await landmarksFor(language) : [];

  let userLocationInstruction = '';
  if (effectiveCategory !== 'historical') {
    const locationStr = [LOCATION.city, LOCATION.region, LOCATION.country].filter(Boolean).join(', ');
    userLocationInstruction = `**LOCATION PREFERENCE**: Set the story in or near ${locationStr}. Use real local landmarks, street names, parks, or recognizable places from this area to make the story feel personal and familiar to the reader. The main characters live in this area.`;
  }
  const seasonInstruction = effectiveCategory === 'historical' ? '' : buildSeasonInstruction({});

  let availableLandmarksSection = '';
  if (availableLandmarks.length && effectiveCategory !== 'historical') {
    const landmarkEntries = availableLandmarks.slice(0, 10).map(l => {
      let entry = `- ${l.name}`;
      if (l.type) entry += ` (${l.type})`;
      const description = l.wikipediaExtract || l.photoDescription;
      if (description) entry += `: ${description}`;
      return entry;
    }).join('\n');
    availableLandmarksSection = `**AVAILABLE LOCAL LANDMARKS** (use 1-2 of these in Story 1 to make it feel personal):\n${landmarkEntries}`;
  }

  const ctx = await buildIdeasPromptContext({
    storyCategory, storyTopic, storyTheme, storyTypeName: undefined, customThemeText: undefined,
    language, languageLevel, characters, relationships, pages,
    userLocationInstruction, availableLandmarksSection, seasonInstruction,
  });

  const buildSinglePrompt = (world, variantInstruction, shape, seeds) => {
    const requirements = world === 'fantasy' ? ctx.storyRequirements2 : ctx.storyRequirements1;
    const worldOverrides = world === 'fantasy' ? { USER_LOCATION_INSTRUCTION: '', AVAILABLE_LANDMARKS: '' } : {};
    return ctx.applyReplacements(ctx.singlePromptTemplate, {
      STORY_VARIANT_INSTRUCTION: variantInstruction, STORY_REQUIREMENTS: requirements,
      PREMISE_SHAPE: premiseShapeInstruction(shape), WORLD_SEED: worldSeedInstruction(seeds), ...worldOverrides,
    });
  };

  const ideaWorlds = resolveIdeaWorlds({ storyCategory, storyTheme, location: LOCATION, worldMode: 'auto' });
  const world1 = ideaWorlds ? ideaWorlds[0].world : 'location';
  const world2 = ideaWorlds ? ideaWorlds[1].world : 'fantasy';
  const [firstInstruction, secondInstruction] = buildVariantInstructions(world1, world2, { characters, storyTopic, storyTheme, language });

  return {
    ideaWorlds, worlds: [world1, world2],
    landmarkNames: availableLandmarks.slice(0, 10).map(l => l.name),
    premiseShapes: ctx.premiseShapes,
    worldSeeds: ctx.worldSeeds,
    prompts: [buildSinglePrompt(world1, firstInstruction, ctx.premiseShapes[0], ctx.worldSeeds[0]), buildSinglePrompt(world2, secondInstruction, ctx.premiseShapes[1], ctx.worldSeeds[1])],
  };
}

async function runCell(cell) {
  const built = await buildCellPrompts(cell);
  const ideas = [];
  await Promise.all(built.prompts.map(async (prompt, i) => {
    const t = Date.now();
    const r = await callTextModelStreaming(prompt, null, null, MODEL, { usageLabel: 'story_idea_rounds' });
    const raw = String(r.text || '');
    ideas[i] = {
      index: i + 1, world: built.worlds[i], prompt, raw,
      final: parseFinal(raw) || raw.trim(),
      modelId: r.modelId, ms: Date.now() - t,
      cost: costOf(r.usage, r.modelId), usage: r.usage,
    };
  }));
  process.stderr.write(`cell ${cell.id} done (${built.worlds.join('+')})\n`);
  return { cell, ideaWorlds: built.ideaWorlds, landmarkNames: built.landmarkNames, ideas };
}

(async () => {
  // Label, not a number: a re-run of one cell after a fix is round-5b, not round-6.
  await loadPromptTemplates();
  const round = (process.argv.find(a => a.startsWith('--round=')) || '--round=1').split('=')[1];
  const only = (process.argv.find(a => a.startsWith('--cells=')) || '').split('=')[1];
  const cells = only ? CELLS.filter(c => only.split(',').map(Number).includes(c.id)) : CELLS;

  // --dry-run builds the prompts and writes them out without calling the model.
  if (process.argv.includes('--dry-run')) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const built = [];
    for (const cell of cells) {
      const b = await buildCellPrompts(cell);
      built.push({ cell: cell.id, worlds: b.worlds, shapes: b.premiseShapes.map(x => x.name), worldSeeds: b.worldSeeds, prompts: b.prompts });
    }
    const f = path.join(OUT_DIR, `dry-run-${cells.map(c => c.id).join('-')}.json`);
    fs.writeFileSync(f, JSON.stringify(built, null, 2));
    console.log(`written ${f}`);
    process.exit(0);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const results = [];
  const CONC = 3;
  for (let i = 0; i < cells.length; i += CONC) {
    results.push(...await Promise.all(cells.slice(i, i + CONC).map(runCell)));
  }
  results.sort((a, b) => a.cell.id - b.cell.id);

  const totalCost = results.reduce((s, r) => s + r.ideas.reduce((t, x) => t + x.cost, 0), 0);
  const report = { round, model: MODEL, location: LOCATION, generatedAt: new Date().toISOString(), totalCost, cells: results };
  fs.writeFileSync(path.join(OUT_DIR, `round-${round}.json`), JSON.stringify(report, null, 2));

  const md = [`# Story ideas — round ${round}`, '', `Model: ${MODEL} · cost USD ${totalCost.toFixed(4)} · location ${LOCATION.city}`, ''];
  for (const r of results) {
    const c = r.cell;
    md.push(`## Cell ${c.id} — ${c.characters.length} char, ${c.pages}p, ${c.language}/${c.languageLevel}, ${c.storyCategory}${c.storyTopic ? `/${c.storyTopic}` : ''}${c.storyTheme ? `, theme ${c.storyTheme}` : ''}`);
    md.push(`Cast: ${c.characters.map(x => `${x.name} (${x.age}${x.isMain ? ', main' : ''})`).join('; ')}`, '');
    for (const idea of r.ideas) {
      md.push(`### Idea ${idea.index} — world: ${idea.world} (${idea.modelId}, ${idea.ms}ms)`, '', idea.final, '');
    }
  }
  fs.writeFileSync(path.join(OUT_DIR, `round-${round}.md`), md.join('\n'));
  console.log(`written round-${round}.json / .md — USD ${totalCost.toFixed(4)}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
