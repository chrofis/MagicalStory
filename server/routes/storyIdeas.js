/**
 * Story Ideas Routes — Extracted from server.js
 *
 * Contains: story idea generation (non-streaming and streaming).
 * These are free endpoints that don't cost credits.
 */

const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const path = require('path');

// Middleware
const { authenticateToken } = require('../middleware/auth');
const { storyIdeasLimiter } = require('../middleware/rateLimit');

// Services
const { log } = require('../utils/logger');
const { fillTemplate } = require('../services/prompts');

// Landmark resolution — one shared resolver + cache in landmarkPhotos.js.
// This route once kept a PRIVATE cache here, so landmarks it discovered were
// invisible to the story pipeline.
const { resolveAvailableLandmarks } = require('../lib/landmarkPhotos');

// The idea funnel: one row per idea generation and one per pick, so "would a
// parent buy this" is measured from the production click instead of from a
// rater's proxy (migrations/039, docs/decisions.md 2026-09-21).
const { recordIdeaEvent } = require('../lib/ideaEvents');
const { IDEA_BUY_QUESTIONS } = require('../lib/ideaBuyCriterion');

/**
 * Build the shared prompt context for story idea generation.
 * Used by both the authenticated endpoints and the trial endpoint.
 *
 * @param {Object} params
 * @param {string} params.storyCategory
 * @param {string} params.storyTopic
 * @param {string} params.storyTheme
 * @param {string} params.storyTypeName
 * @param {string} params.customThemeText
 * @param {string} params.language
 * @param {string} params.languageLevel - defaults to 'standard'
 * @param {Array}  params.characters
 * @param {Array}  params.relationships
 * @param {number} params.pages - defaults to 10
 * @param {string} [params.userLocationInstruction] - pre-built location instruction (empty for trial)
 * @param {string} [params.availableLandmarksSection] - pre-built landmarks section (empty for trial)
 * @returns {Promise<Object>} { promptReplacements, storyRequirements1, storyRequirements2, singlePromptTemplate }
 */
const { buildSeasonInstruction } = require('../lib/season');

async function buildIdeasPromptContext({
  storyCategory, storyTopic, storyTheme, storyTypeName, customThemeText,
  language, languageLevel = 'standard', characters, relationships,
  pages = 10, userLocationInstruction = '', availableLandmarksSection = '',
  seasonInstruction = ''
}) {
  const { getLanguageInstruction } = require('../lib/languages');

  // Picture-book layout (default for all reading levels): 1 page = 1 scene
  // (image on top, text below). The reading level controls text density,
  // not the layout, so the page count maps directly to scene count.
  const sceneCount = pages;

  // Build character descriptions
  const characterDescriptions = characters.map(c => {
    const role = c.isMain ? 'main character' : 'side character';
    const traits = [];
    if (c.traits?.strengths?.length) traits.push(`strengths: ${c.traits.strengths.join(', ')}`);
    if (c.traits?.flaws?.length) traits.push(`flaws: ${c.traits.flaws.join(', ')}`);
    if (c.traits?.challenges?.length) traits.push(`challenges: ${c.traits.challenges.join(', ')}`);
    const specialDetails = c.traits?.specialDetails || c.specialDetails || c.special_details;
    if (specialDetails) traits.push(`special: ${specialDetails}`);
    const traitsStr = traits.length ? ` (${traits.join('; ')})` : '';
    return `- ${c.name}: ${c.age} years old, ${c.gender}, ${role}${traitsStr}`;
  }).join('\n');

  // Build relationship descriptions.
  // The wizard posts EVERY matrix cell here, sentinels included, so this list
  // has to make the same two distinctions the story brief makes (owner
  // 2026-09-19): an unanswered cell says nothing and is dropped; the deliberate
  // strangers choice is a fact about the cast and is stated as a sentence, never
  // as the ungrammatical "X <sentinel> Y". Before the split this site emitted
  // the sentinel verbatim in EVERY language, English included.
  const { isNotSetRelationship, isStrangersRelationship } = require('../lib/relationships');
  const relationshipDescriptions = (relationships || [])
    .filter(r => !isNotSetRelationship(r.relationship))
    .map(r => isStrangersRelationship(r.relationship)
      ? `- ${r.character1} and ${r.character2} do not know each other`
      : `- ${r.character1} ${r.relationship} ${r.character2}`)
    .join('\n');

  // Determine reading level description
  const readingLevelDescriptions = {
    '1st-grade': 'Early reader (simple sentences, 6-7 year olds)',
    'advanced': 'Advanced (older children 10+)',
    'standard': 'Standard (7-9 year olds)'
  };

  // Build category-specific instructions
  let categoryInstructions = '';
  const effectiveCategory = storyCategory || 'adventure';
  const effectiveTheme = storyTheme || storyTypeName || 'adventure';

  if (effectiveCategory === 'life-challenge') {
    categoryInstructions = `IMPORTANT: This is a LIFE SKILLS story about "${storyTopic}".
The story should help children understand and cope with this topic.
Show the characters facing this challenge and learning to handle it.
What stands in the way is this skill being hard, met in one outside event — never a feeling on its own.
${effectiveTheme && effectiveTheme !== 'realistic' ? `Set the story in a ${effectiveTheme} adventure context.` : 'Keep the setting realistic and relatable.'}`;
  } else if (effectiveCategory === 'educational') {
    categoryInstructions = `IMPORTANT: This is an EDUCATIONAL story teaching about "${storyTopic}".
Weave learning about ${storyTopic} naturally into the plot.
Make the educational content fun and part of the adventure.
${effectiveTheme && effectiveTheme !== 'realistic' ? `Set the story in a ${effectiveTheme} adventure context.` : 'Use everyday situations to explore the topic.'}`;
  } else if (effectiveCategory === 'historical') {
    const { getEventById } = require('../lib/historicalEvents');
    const { getTeachingGuide: getHistoricalGuide } = require('../lib/storyHelpers');
    const historicalEvent = getEventById(storyTopic);
    const historicalGuide = getHistoricalGuide('historical', storyTopic);

    if (historicalEvent && historicalGuide) {
      categoryInstructions = `IMPORTANT: This is a HISTORICAL story about "${historicalEvent.name}" (${historicalEvent.year}).

**HISTORICAL ACCURACY REQUIRED**
Use ONLY the verified information provided. Do NOT invent historical facts.

${historicalGuide}`;
    } else {
      categoryInstructions = `This is a HISTORICAL story about "${storyTopic}". Create an age-appropriate adventure set during this historical event.`;
    }
  } else if (effectiveCategory === 'swiss-stories') {
    if (storyTopic.startsWith('sage-')) {
      // Swiss fairy tale / legend (Sage)
      const { getSageById } = require('../lib/swissStories');
      const sage = getSageById(storyTopic);
      if (sage) {
        const sageTitle = typeof sage.title === 'object' ? sage.title.en : sage.title;
        const sageDesc = typeof sage.description === 'object' ? sage.description.en : sage.description;
        const sageContext = sage.context && typeof sage.context === 'object' ? sage.context.en : (sage.context || '');
        categoryInstructions = `IMPORTANT: This is a SWISS LEGEND (Sage).
Story: "${sageTitle}" — ${sageDesc}

${sageContext}

Themes: ${(sage.themes || []).join(', ')}

INSTRUCTIONS:
- Retell this classic Swiss legend with the child characters as participants in the story
- Keep the core plot and moral but make it age-appropriate
- Use vivid Swiss Alpine imagery and real Swiss cultural elements
- The child becomes part of the legend — they don't just observe it`;

        // Load detailed guide if available (from swiss-sagen-guides.txt or matching historical guide)
        const { getTeachingGuide: getSageGuide } = require('../lib/storyHelpers');
        const sageGuide = getSageGuide('swiss-sagen', storyTopic);
        if (sageGuide) {
          categoryInstructions += `\n\n**DETAILED LEGEND GUIDE:**\n${sageGuide}`;
        } else {
          // Try matching historical event guide (sage-wilhelm-tell → wilhelm-tell)
          const historicalId = storyTopic.replace('sage-', '');
          const historicalGuide = getSageGuide('historical', historicalId);
          if (historicalGuide) {
            categoryInstructions += `\n\n**DETAILED HISTORICAL CONTEXT:**\n${historicalGuide}`;
          }
        }
      } else {
        categoryInstructions = `This is a SWISS LEGEND. Create an engaging retelling of a Swiss legend.`;
      }
    } else {
      // City-based Swiss story
      const { getSwissStoryResearch, getSwissCityById } = require('../lib/swissStories');
      const cityId = storyTopic.replace(/-\d+$/, '');
      const cityData = getSwissStoryResearch(cityId);
      const cityMeta = getSwissCityById(cityId);
      const cityName = cityMeta?.name?.en || cityId;

      if (cityData) {
        const ideaNum = parseInt(storyTopic.split('-').pop());
        const idea = cityData.ideas[ideaNum - 1];
        // Support both localized {en,de,fr} and plain string formats
        const ideaTitle = (idea?.title && typeof idea.title === 'object' ? idea.title.en : idea?.title) || storyTopic;
        const ideaDesc = idea?.description && typeof idea.description === 'object' ? idea.description.en : (idea?.description || '');
        categoryInstructions = `IMPORTANT: This is a SWISS LOCAL STORY set in ${cityName}.
Story idea: "${ideaTitle}" — ${ideaDesc}

Use the city's real landmarks, history, and cultural elements.
${cityData.research.slice(0, 2000)}`;
      } else {
        categoryInstructions = `This is a SWISS LOCAL STORY. Create an engaging story set in a Swiss city.`;
      }
    }
  } else if (effectiveCategory === 'custom') {
    categoryInstructions = `IMPORTANT: This is a CUSTOM story. The user provided their own concept:
"${customThemeText || ''}"
Follow the user's vision closely while keeping the story age-appropriate and engaging.`;
  } else {
    categoryInstructions = `This is a ${effectiveTheme} adventure story. Make it exciting and appropriate for children.`;
  }

  // Get teaching guide for the topic if available
  const { getTeachingGuide, getSceneComplexityGuide, getAdventureGuide } = require('../lib/storyHelpers');
  const teachingGuide = getTeachingGuide(effectiveCategory, storyTopic);
  const topicGuideText = teachingGuide
    ? `**TOPIC GUIDE for "${storyTopic}":**
${teachingGuide}`
    : '';

  // Get scene complexity guide based on page count
  const sceneComplexityGuide = getSceneComplexityGuide(sceneCount);

  // Always get adventure guide for setting/costume context
  const adventureGuideContent = getAdventureGuide(effectiveTheme);
  const adventureSettingGuide = adventureGuideContent
    ? `**ADVENTURE SETTING GUIDE for "${effectiveTheme}":**
${adventureGuideContent}`
    : '';

  // A sample of the challenge catalogue (prompts/challenge-catalogue.txt), so the
  // generator stops reaching for the same five obstacles (a stream, a boulder, a
  // locked gate, a refusing guard, a storm — catalogue ids 29, 1, 67, 78, 51).
  // Filtered by the cast's ages, peril-free when a young child is in the cast,
  // and sampled ACROSS categories with the five AI-default categories (A, C, D,
  // F, G) capped, so variety comes from the sample itself. ~40 entries is ~900
  // tokens (~$0.003/call); a fresh sample per call varies a customer's stories.
  // The three simple bands (routine/quest/tries) carry no budgeted challenge at
  // all, so there is nothing to sample for — challengeCatalogueBands returns an
  // empty list for them, and picks the bands for every other age.
  const { buildAgeModeSection, resolveAgeBand, challengeCatalogueBands } = require('../lib/promptBuilders');
  const premiseShapes = pickPremiseShapes({ characters, storyTopic, storyTheme, language });
  const ageModeSection = buildAgeModeSection({ characters });
  const bands = challengeCatalogueBands({ characters });

  let challengeCatalogueSection = '';
  if (!bands.length) {
    log.debug(`[IDEAS] ${resolveAgeBand({ characters })} band — challenge catalogue skipped`);
  } else try {
    const rawCat = await fs.readFile(path.join(__dirname, '../../prompts', 'challenge-catalogue.txt'), 'utf-8');
    const ages = (characters || []).map(c => parseInt(c.age, 10)).filter(Number.isFinite);
    const youngest = ages.length ? Math.min(...ages) : 8;
    const entries = rawCat.split('\n')
      .filter(l => l && !l.startsWith('#'))
      .map(l => l.split('|'))
      .filter(f => f.length >= 6)
      .filter(f => bands.some(b => f[4].startsWith(b)))
      .filter(f => youngest > 5 || f[5].trim() !== '1');
    const byCat = new Map();
    for (const f of entries) {
      if (!byCat.has(f[1])) byCat.set(f[1], []);
      byCat.get(f[1]).push(`- ${f[2]} (tests: ${f[3]})`);
    }
    const DEFAULT_ZONE = new Set(['A', 'C', 'D', 'F', 'G']);
    const picked = [];
    const cats = [...byCat.keys()].sort(() => Math.random() - 0.5);
    let round = 0;
    while (picked.length < 40 && round < 8) {
      for (const c of cats) {
        if (picked.length >= 40) break;
        const cap = DEFAULT_ZONE.has(c) ? 1 : 2; // the default zone gets one pick, ever
        const used = picked.filter(x => x.cat === c).length;
        if (used >= cap * (DEFAULT_ZONE.has(c) ? 1 : round + 1)) continue;
        const pool = byCat.get(c);
        if (!pool.length) continue;
        const i = Math.floor(Math.random() * pool.length);
        picked.push({ cat: c, line: pool.splice(i, 1)[0] });
      }
      round++;
    }
    if (picked.length) {
      challengeCatalogueSection = [
        '## CHALLENGE IDEAS (a sample from a catalogue of classic trials)',
        'When the story needs an obstacle, prefer one of these — or one in their spirit — over the usual stream, boulder, locked gate, refusing guard or storm. Pick what fits the characters and the world; vary the kind.',
        '',
        ...picked.map(x => x.line),
      ].join('\n');
    }
  } catch (err) {
    log.warn(`[IDEAS] challenge catalogue unavailable: ${err.message}`);
  }

  // Calculate story length category for output length limits
  const storyLengthCategory = pages <= 10 ? 'SHORT (1-10 pages) - 6 sentences max per idea' :
                              pages <= 20 ? 'MEDIUM (11-20 pages) - 8 sentences max per idea' :
                                            'LONG (21+ pages) - 10 sentences max per idea';

  // Load prompt templates
  const promptTemplate = await fs.readFile(path.join(__dirname, '../../prompts', 'generate-story-ideas.txt'), 'utf-8');
  const singlePromptTemplate = await fs.readFile(path.join(__dirname, '../../prompts', 'generate-story-idea-single.txt'), 'utf-8');

  // Load category-specific story requirements (separate files for story 1 and story 2)
  // Sagen (Swiss legends) use the historical template — children become the characters, not generic adventure
  const isSage = effectiveCategory === 'swiss-stories' && storyTopic?.startsWith('sage-');
  const requirementsBase = (effectiveCategory === 'historical' || isSage)
    ? 'story-idea-requirements-historical'
    : 'story-idea-requirements-adventure';
  const storyRequirements1 = await fs.readFile(path.join(__dirname, '../../prompts', `${requirementsBase}-1.txt`), 'utf-8');
  const storyRequirements2 = await fs.readFile(path.join(__dirname, '../../prompts', `${requirementsBase}-2.txt`), 'utf-8');

  // Build the replacement map (shared across all prompt templates)
  const storyCategoryLabel = effectiveCategory === 'custom' ? 'Custom' : effectiveCategory === 'life-challenge' ? 'Life Skills' : effectiveCategory === 'educational' ? 'Educational' : effectiveCategory === 'historical' ? 'Historical' : 'Adventure';
  const storyTypeNameLabel = effectiveCategory === 'custom' ? 'custom' : effectiveTheme;
  const storyTopicLabel = storyTopic || (effectiveCategory === 'custom' ? (customThemeText || 'None') : 'None');
  const languageInstruction = getLanguageInstruction(language);

  // Fill templates via the shared fillTemplate (services/prompts.js) —
  // global replacement, $-escaped values, WARN + strip on unfilled
  // {UPPERCASE} placeholders. The old hand-rolled chained String.replace
  // was first-occurrence only (the SECOND {STORY_LENGTH_CATEGORY} in
  // generate-story-ideas.txt shipped to the model literally) and
  // interpreted $-sequences in user-derived values (characterDescriptions,
  // customThemeText), silently mangling them.
  // extraReplacements keys are bare placeholder names (no braces), same as
  // every other fillTemplate call site.
  const applyReplacements = (template, extraReplacements = {}) => fillTemplate(template, {
    STORY_CATEGORY: storyCategoryLabel,
    STORY_TYPE_NAME: storyTypeNameLabel,
    STORY_TOPIC: storyTopicLabel,
    CHARACTER_DESCRIPTIONS: characterDescriptions,
    RELATIONSHIP_DESCRIPTIONS: relationshipDescriptions || 'No specific relationships defined.',
    READING_LEVEL_DESCRIPTION: readingLevelDescriptions[languageLevel] || readingLevelDescriptions['standard'],
    SCENE_COMPLEXITY_GUIDE: sceneComplexityGuide,
    CATEGORY_INSTRUCTIONS: categoryInstructions,
    TOPIC_GUIDE: topicGuideText,
    ADVENTURE_SETTING_GUIDE: adventureSettingGuide,
    USER_LOCATION_INSTRUCTION: userLocationInstruction,
    // Season is its OWN placeholder, never part of the location block. A
    // fantasy idea blanks USER_LOCATION_INSTRUCTION so the real city cannot
    // leak into a made-up world — and while the season lived inside that
    // block it was blanked too, so a story set in Herbst came back as
    // "in einem Sommer vor langer Zeit".
    SEASON_INSTRUCTION: seasonInstruction,
    AVAILABLE_LANDMARKS: availableLandmarksSection,
    STORY_LENGTH_CATEGORY: storyLengthCategory,
    CHALLENGE_CATALOGUE: challengeCatalogueSection,
    AGE_MODE: ageModeSection,
    LANGUAGE_INSTRUCTION: languageInstruction,
    // One premise shape per idea arm, picked in code (pickPremiseShapes). The
    // single-idea template takes {PREMISE_SHAPE} (overridden per arm by the
    // caller); the two-idea template writes both ideas in ONE call and takes
    // {PREMISE_SHAPE_1} / {PREMISE_SHAPE_2}. All three are declared here so no
    // call site can ship an unfilled placeholder.
    // The parent's own questions, ONE constant (server/lib/ideaBuyCriterion.js)
    // filled into both templates twice: once as a rule the draft answers, once
    // as the last review check, which answers each question with a quote. The
    // rule and its critic cannot drift because they are the same string.
    BUY_CRITERION: IDEA_BUY_QUESTIONS,
    PREMISE_SHAPE: premiseShapeInstruction(premiseShapes[0]),
    PREMISE_SHAPE_1: premiseShapeInstruction(premiseShapes[0]),
    PREMISE_SHAPE_2: premiseShapeInstruction(premiseShapes[1]),
    ...extraReplacements,
  });

  return {
    effectiveCategory,
    effectiveTheme,
    characterDescriptions,
    relationshipDescriptions,
    sceneCount,
    promptTemplate,
    premiseShapes,
    singlePromptTemplate,
    storyRequirements1,
    storyRequirements2,
    applyReplacements
  };
}

/**
 * Which world each of the two generated ideas plays in — the single source of
 * truth for the wizard's per-idea world labels and for the `ideaWorld` field
 * the selected idea carries into the create-story payload (persisted on
 * stories.data so the pipeline can honor the chosen world).
 *
 * Default (auto): idea 1 = the user's real location, idea 2 = the fantasy /
 * theme world. `worldMode` lets a rerun steer both ideas to one side.
 * Overrides:
 * - historical stories play at the event's real time and place — neither
 *   "your city" nor a fantasy world applies → null (no labels, no steering).
 * - life-skills stories in a realistic environment stay in the real world:
 *   BOTH ideas from the real location, no fantasy idea.
 * - without a known location there is nothing to anchor idea 1 to → null
 *   (legacy prompt behavior, no labels).
 *
 * @returns {Array<{world: 'location'|'fantasy', theme: string|null, location: Object|null}>|null}
 */
const REALISTIC_ENVIRONMENT_THEMES = new Set(['realistic', 'farm', 'forest', 'fireman', 'doctor', 'police', 'detective']);

/**
 * The per-arm variant instruction pair. One definition, used by the streaming
 * endpoint and by tests/manual/story-idea-rounds.js, which previously carried a
 * hand-copied duplicate.
 *
 * When BOTH arms play in the real world (realistic-environment life challenges),
 * "different local places" is not something the model can check itself against -
 * it never sees the first idea. Name the axes to vary instead. The two calls stay
 * parallel; serialising them would cost wall-clock on the live wizard.
 */
// When BOTH idea arms play in the real world, the second call cannot see the
// first, so "vary the place" is unverifiable from inside it and the two arms
// came back telling the same story in every round of the 2026-09-20 rating
// series. The second arm is therefore handed VALUES, not an instruction to
// differ: one place class and one event class, picked here and stated as
// requirements. The pick is DETERMINISTIC from the request's own inputs
// (cast, topic, theme) rather than random per call, so that a fixed set of
// wizard inputs produces a reproducible pair — the rating harness replays the
// same cells across rounds — while different inputs land on different classes.
const IDEA_PLACE_CLASSES = [
  'indoors, inside a building',
  'outdoors, in the open air, away from any building',
  'at home or in the garden or yard belonging to it',
  'in a public place with other people around'
];
const IDEA_EVENT_CLASSES = [
  'weather that turns',
  'a time someone else has set, which cannot be moved',
  'other people in the way — a crowd, a queue, or a closed door',
  'a thing that breaks or goes missing',
  'an animal that will not do what it is asked',
  'somebody arriving who was not expected'
];

function ideaVariantSeed(seedInput) {
  const parts = [];
  for (const c of (seedInput?.characters || [])) parts.push(`${c?.name || ''}:${c?.age || ''}`);
  parts.push(seedInput?.storyTopic || '', seedInput?.storyTheme || '', seedInput?.language || '');
  const key = parts.join('|');
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h * 33) ^ key.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * The premise-shape catalogue (prompts/premise-shapes.txt).
 *
 * Seven rating rounds moved every defect axis and left the buy axis at 3.35-3.65.
 * The contract said what a premise may NOT contain and never said what it is BUILT
 * on, so both arms kept reaching for the same shapeless "a child wants a thing and
 * something is in the way". The shape is picked HERE, in code, and handed to the
 * model as a requirement — the same reason buildVariantInstructions hands over
 * values rather than an instruction to differ: the second call cannot see the first.
 */
let PREMISE_SHAPES = null;
function loadPremiseShapes() {
  if (PREMISE_SHAPES) return PREMISE_SHAPES;
  const raw = require('fs').readFileSync(path.join(__dirname, '../../prompts', 'premise-shapes.txt'), 'utf-8');
  PREMISE_SHAPES = raw.replace(/\r/g, '').split('\n')
    .filter(l => l.trim() && !l.startsWith('#'))
    .map(l => l.split('|'))
    .filter(f => f.length >= 4)
    .map(f => ({ id: Number(f[0]), name: f[1].trim(), definition: f[2].trim(), minAge: Number(f[3]) }));
  if (PREMISE_SHAPES.length < 4) throw new Error('premise-shapes.txt: fewer than four usable shapes');
  return PREMISE_SHAPES;
}

// Shape 10 is between the two main characters and is nonsense with one main.
// Encoded here rather than as a fifth column: it is the only shape with a cast
// precondition, and a column that is blank on eleven of twelve lines teaches
// nothing.
const SHAPE_NEEDS_TWO_MAINS = new Set([10]);

// Shapes withheld from a cast whose youngest is five or under, because they
// invite the two peril shapes the round-10 read counted (a child alone at a
// height, and a cost that ends on a child never coming home). Traced on
// round-10.json: `rescue` drew 3 of its 4 arms into a peril fault, 2 of 2 on
// the casts with a youngest of five or under, and it is the only shape with
// more than one hit — every other peril fault sits on a different shape. Same
// encoding as the set above: a column blank on eleven of twelve lines teaches
// nothing.
const SHAPE_PERIL_PRONE = new Set([2]);
const SHAPE_PERIL_MAX_YOUNGEST = 5;

/**
 * One shape per arm, DETERMINISTIC from the same seed buildVariantInstructions
 * uses, always two different shapes, and never a shape above the youngest
 * character's age. Exported for the unit test and the rating harness.
 */
function pickPremiseShapes(seedInput = {}) {
  const chars = seedInput?.characters || [];
  const ages = chars.map(c => parseInt(c?.age, 10)).filter(Number.isFinite);
  const youngest = ages.length ? Math.min(...ages) : 8;
  const mains = chars.filter(c => c?.isMain).length;
  const pool = loadPremiseShapes()
    .filter(s => youngest >= s.minAge)
    .filter(s => mains >= 2 || !SHAPE_NEEDS_TWO_MAINS.has(s.id))
    .filter(s => youngest > SHAPE_PERIL_MAX_YOUNGEST || !SHAPE_PERIL_PRONE.has(s.id));
  if (pool.length < 2) throw new Error(`premise-shapes: only ${pool.length} shape(s) for youngest age ${youngest}`);
  const h = ideaVariantSeed(seedInput);
  const i1 = h % pool.length;
  const i2 = (i1 + 1 + (Math.floor(h / pool.length) % (pool.length - 1))) % pool.length;
  return [pool[i1], pool[i2]];
}

/**
 * USD for one idea call, from the usage object the text-model layer returns.
 * The ideas route runs outside a job's usage sink (there is no job yet), so the
 * cost is computed here rather than read off a tracker. Returns null when the
 * provider gave no usage - a wrong number is worse than no number.
 */
function ideaCallCost(modelId, usage) {
  if (!usage || !modelId) return null;
  try {
    const { calculateTextCost } = require('../config/models');
    const cost = calculateTextCost(modelId, {
      inputTokens: usage.input_tokens || 0,
      outputTokens: usage.output_tokens || 0,
      thinkingTokens: usage.thinking_tokens || 0,
    });
    return Number.isFinite(cost) && cost > 0 ? cost : null;
  } catch { return null; }
}

function premiseShapeInstruction(shape) {
  return `This idea has the shape: ${shape.name} — ${shape.definition}. Keep the shape; the shape is a requirement, not a choice.`;
}

function buildVariantInstructions(world1, world2, seedInput = {}) {
  const first = world1 === 'fantasy'
    ? 'Start directly in the adventure world. Avoid local landmarks - use the theme setting instead.'
    : 'Use local landmarks if available. Create an engaging story that uses the setting naturally.';
  const bothLocation = world1 === 'location' && world2 === 'location';
  let second;
  if (world2 === 'fantasy') {
    second = 'Create a DIFFERENT story. Use a different location, different approach to the conflict, and different story structure. Avoid local landmarks - use the theme setting instead.';
  } else if (bothLocation) {
    const h = ideaVariantSeed(seedInput);
    const place = IDEA_PLACE_CLASSES[h % IDEA_PLACE_CLASSES.length];
    second = `Create a DIFFERENT story than the first one. These are requirements, not choices: this story plays ${place}; and whoever is responsible for the youngest character is a different person from the obvious one, or nobody is. Use local landmarks if available.`;
  } else {
    second = 'Create a DIFFERENT story than the first one: different local places, a different approach to the conflict, and a different story structure. Use local landmarks if available.';
  }
  return [first, second];
}

function resolveIdeaWorlds({ storyCategory, storyTheme, location, worldMode = 'auto' }) {
  const effectiveCategory = storyCategory || 'adventure';
  if (effectiveCategory === 'historical') return null;

  const hasLocation = !!(location && location.city);
  if (!hasLocation) return null;

  const locationWorld = () => ({
    world: 'location',
    theme: null,
    location: { city: location.city, region: location.region || null, country: location.country || null }
  });
  const fantasyWorld = () => ({
    world: 'fantasy',
    theme: (storyTheme && storyTheme !== 'realistic') ? storyTheme : null,
    location: null
  });

  const realisticLifeChallenge = effectiveCategory === 'life-challenge'
    && (!storyTheme || REALISTIC_ENVIRONMENT_THEMES.has(storyTheme));
  if (realisticLifeChallenge) return [locationWorld(), locationWorld()];

  if (worldMode === 'location') return [locationWorld(), locationWorld()];
  if (worldMode === 'fantasy') return [fantasyWorld(), fantasyWorld()];
  return [locationWorld(), fantasyWorld()];
}

// Generate story ideas endpoint - FREE, no credits
router.post('/generate-story-ideas', authenticateToken, storyIdeasLimiter, async (req, res) => {
  try {
    const { storyType, storyTypeName, storyCategory, storyTopic, storyTheme, customThemeText, language, languageLevel, characters, relationships, ideaModel, pages = 10, userLocation, season, worldMode, attempt, regenerate } = req.body;

    log.debug(`💡 Generating story ideas for user ${req.user.username}${worldMode && worldMode !== 'auto' ? ` (worldMode: ${worldMode})` : ''}`);

    // For swiss-stories, use the story's city for landmarks (not user's home city)
    let effectiveLocation = userLocation;
    if (storyCategory === 'swiss-stories' && storyTopic) {
      let storyCity = null;
      if (!storyTopic.startsWith('sage-')) {
        const { getSwissCityById } = require('../lib/swissStories');
        const cityId = storyTopic.replace(/-\d+$/, '');
        const cityMeta = getSwissCityById(cityId);
        if (cityMeta) storyCity = cityMeta.name.en;
      } else {
        try {
          const sagen = require('../data/swiss-sagen.json');
          const sage = sagen.find(s => s.id === storyTopic);
          if (sage?.city) storyCity = sage.city;
        } catch (e) { /* ignore */ }
      }
      if (storyCity) {
        if (effectiveLocation?.city && effectiveLocation.city.toLowerCase() !== storyCity.toLowerCase()) {
          log.info(`[SWISS] Idea generation: overriding location from ${effectiveLocation.city} to ${storyCity}`);
        }
        effectiveLocation = { city: storyCity, country: 'Switzerland' };
      }
    }

    // Discover landmarks for story location (await to include in ideas prompt).
    // Skip for historical stories - they use historically accurate locations, not local landmarks.
    // Shared resolver: landmark_index (proximity fallback) -> shared cache -> live discovery.
    let availableLandmarks = [];
    if (effectiveLocation?.city && storyCategory !== 'historical') {
      log.debug(`  📍 Story location: ${effectiveLocation.city}, ${effectiveLocation.country || ''}`);
      availableLandmarks = await resolveAvailableLandmarks(effectiveLocation, {
        limit: 20, discoverOnMiss: true, language,
      });
    }
    log.debug(`  Category: ${storyCategory}, Topic: ${storyTopic}, Theme: ${storyTheme || storyTypeName}, Language: ${language}, Pages: ${pages}`);

    // Build user location instruction for personalized settings (skip for historical - events have fixed locations)
    const effectiveCategory_loc = storyCategory || 'adventure';

    let userLocationInstruction = '';
    const locationForPrompt = effectiveLocation || userLocation;
    if (locationForPrompt?.city && effectiveCategory_loc !== 'historical') {
      const locationParts = [locationForPrompt.city, locationForPrompt.region, locationForPrompt.country].filter(Boolean);
      const locationStr = locationParts.join(', ');
      userLocationInstruction = `**LOCATION PREFERENCE**: Set the story in or near ${locationStr}. Use real local landmarks, street names, parks, or recognizable places from this area to make the story feel personal and familiar to the reader. The main characters live in this area.`;
    }
    // The season holds for BOTH ideas, the made-up world included — it is what
    // the reader picked. Keeping it out of the location block is what lets it
    // survive the fantasy blanking below.
    // One builder for every path (trial idea, trial story, both idea endpoints),
    // so the wording cannot drift and an absent season resolves to the date the
    // way season.js documents rather than dropping the line.
    const seasonInstruction = effectiveCategory_loc === 'historical'
      ? ''
      : buildSeasonInstruction({ season });

    // Build available landmarks section for the prompt
    let availableLandmarksSection = '';
    if (availableLandmarks && availableLandmarks.length > 0 && effectiveCategory_loc !== 'historical') {
      const landmarkEntries = availableLandmarks
        .slice(0, 10)
        .map(l => {
          let entry = `- ${l.name}`;
          if (l.type) entry += ` (${l.type})`;
          const description = l.wikipediaExtract || l.photoDescription;
          if (description) entry += `: ${description}`;
          return entry;
        })
        .join('\n');
      availableLandmarksSection = `**AVAILABLE LOCAL LANDMARKS** (use 1-2 of these in Story 1 to make it feel personal):
${landmarkEntries}`;
      const withDesc = availableLandmarks.filter(l => l.wikipediaExtract || l.photoDescription).length;
      log.info(`[LANDMARK] ✅ Including ${availableLandmarks.length} landmarks in ideas prompt (${withDesc} with descriptions): ${availableLandmarks.slice(0, 3).map(l => l.name).join(', ')}...`);
    } else {
      log.info(`[LANDMARK] No landmarks available for ideas prompt (userLocation: ${userLocation?.city || 'none'})`);
    }

    // Use shared prompt builder
    const ctx = await buildIdeasPromptContext({
      storyCategory, storyTopic, storyTheme, storyTypeName, customThemeText,
      language, languageLevel, characters, relationships, pages,
      userLocationInstruction, availableLandmarksSection, seasonInstruction
    });

    // Resolve which world each idea plays in (null = legacy split, no labels)
    const ideaWorlds = resolveIdeaWorlds({ storyCategory, storyTheme, location: locationForPrompt, worldMode });
    const reqForWorld = (w) => w === 'fantasy' ? ctx.storyRequirements2 : ctx.storyRequirements1;
    const combinedRequirements = ideaWorlds
      ? reqForWorld(ideaWorlds[0].world) + '\n\n' + reqForWorld(ideaWorlds[1].world)
      : ctx.storyRequirements1 + '\n\n' + ctx.storyRequirements2;
    // When both ideas play in the fantasy world, blank the real-location
    // sections so the city cannot leak in
    const bothFantasy = ideaWorlds && ideaWorlds[0].world === 'fantasy' && ideaWorlds[1].world === 'fantasy';

    const prompt = ctx.applyReplacements(ctx.promptTemplate, {
      STORY_REQUIREMENTS: combinedRequirements,
      ...(bothFantasy ? { USER_LOCATION_INSTRUCTION: '', AVAILABLE_LANDMARKS: '' } : {})
    });

    // Call the text model (using the imported function)
    const { callTextModel, getModelDefaults } = require('../lib/textModels');

    // Use model override from admin, or fall back to default
    const modelDefaults = getModelDefaults();
    const modelToUse = (req.user.role === 'admin' && ideaModel) ? ideaModel : modelDefaults.idea;

    log.debug(`  Using model: ${modelToUse}${ideaModel && req.user.role === 'admin' ? ' (admin override)' : ' (default)'}`);
    const result = await callTextModel(prompt, null, modelToUse, { usageLabel: 'story_ideas' });

    // Parse the response to extract 2 ideas
    // Support multiple formats: [FINAL_1], ## STORY 1, STORY 1:, etc.
    const responseText = result.text.trim();

    // Try [FINAL_1]/[FINAL_2] format first (expected from prompt)
    // Include \n--- as terminator for markdown horizontal rule separator between stories
    let idea1Match = responseText.match(/\[FINAL_1\]\s*([\s\S]*?)(?=\n---|\[DRAFT_2\]|\[FINAL_2\]|##\s*STORY\s*2|$)/i);
    let idea2Match = responseText.match(/\[FINAL_2\]\s*([\s\S]*?)$/);

    // Try ## STORY 1 / ## STORY 2 format
    if (!idea1Match || !idea2Match) {
      idea1Match = responseText.match(/##\s*STORY\s*1[:\s]*([^\n]*(?:\n(?!\n---|##\s*STORY\s*2)[\s\S])*?)(?=\n---|##\s*STORY\s*2|$)/i);
      idea2Match = responseText.match(/##\s*STORY\s*2[:\s]*([\s\S]*?)$/i);
    }

    // Try STORY 1: / STORY 2: format (without ##)
    if (!idea1Match || !idea2Match) {
      idea1Match = responseText.match(/STORY\s*1[:\s]+([^\n]*(?:\n(?!\n---|STORY\s*2)[\s\S])*?)(?=\n---|STORY\s*2|$)/i);
      idea2Match = responseText.match(/STORY\s*2[:\s]+([\s\S]*?)$/i);
    }

    const idea1 = idea1Match ? idea1Match[1].trim() : '';
    const idea2 = idea2Match ? idea2Match[1].trim() : '';

    // If parsing failed, treat the whole response as a single idea
    const storyIdeas = (idea1 && idea2)
      ? [idea1, idea2]
      : [responseText];

    log.debug(`  Generated ${storyIdeas.length} idea(s)`);

    // The idea funnel. Fire-and-forget; see server/lib/ideaEvents.js.
    recordIdeaEvent({
      event: 'idea_generated',
      userId: req.user.id,
      category: ctx.effectiveCategory, topic: storyTopic, theme: ctx.effectiveTheme,
      language, pages, characters, worldMode,
      attempt, regenerate,
      worlds: ideaWorlds ? ideaWorlds.map(w => w.world) : null,
      shapes: ctx.premiseShapes,
      model: result.modelId || modelToUse,
      costUsd: ideaCallCost(result.modelId || modelToUse, result.usage),
      detail: { streaming: false, ideasParsed: storyIdeas.length },
    });

    // Return ideas array, prompt and model for dev mode display
    // Also include legacy storyIdea field for backwards compatibility
    res.json({
      storyIdeas,
      storyIdea: storyIdeas[0], // backwards compatibility
      ideaWorlds,
      // The premise shape each arm was built on (code-picked, deterministic -
      // pickPremiseShapes). The wizard echoes the chosen arm's shape back on
      // create-story so the pick is queryable by shape without recomputing a
      // seed that may have moved (an excluded character changes it).
      premiseShapes: ctx.premiseShapes.map(sh => ({ id: sh.id, name: sh.name })),
      prompt,
      model: modelToUse
    });

  } catch (err) {
    log.error('Generate story ideas error:', err);
    res.status(500).json({ error: err.message || 'Failed to generate story ideas' });
  }
});

// SSE Streaming endpoint for story ideas - streams each story as it completes
router.post('/generate-story-ideas-stream', authenticateToken, storyIdeasLimiter, async (req, res) => {
  // Set up SSE headers. Don't set Connection: keep-alive — it's forbidden in
  // HTTP/2 (RFC 7540 §8.1.2.2) and Cloudflare/Railway hand the response to
  // the browser over HTTP/2, which then drops the frame with
  // ERR_HTTP2_PROTOCOL_ERROR even though the server stream completed cleanly.
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
  res.flushHeaders();

  try {
    const { storyType, storyTypeName, storyCategory, storyTopic, storyTheme, customThemeText, language, languageLevel, characters, relationships, ideaModel, pages = 10, userLocation, season, worldMode, attempt, regenerate } = req.body;

    log.debug(`💡 [STREAM] Generating story ideas for user ${req.user.username}${worldMode && worldMode !== 'auto' ? ` (worldMode: ${worldMode})` : ''}`);

    // For swiss-stories, use the story's city for landmarks (not user's home city)
    let effectiveLocation = userLocation;
    if (storyCategory === 'swiss-stories' && storyTopic) {
      let storyCity = null;
      if (!storyTopic.startsWith('sage-')) {
        const { getSwissCityById } = require('../lib/swissStories');
        const cityId = storyTopic.replace(/-\d+$/, '');
        const cityMeta = getSwissCityById(cityId);
        if (cityMeta) storyCity = cityMeta.name.en;
      } else {
        try {
          const sagen = require('../data/swiss-sagen.json');
          const sage = sagen.find(s => s.id === storyTopic);
          if (sage?.city) storyCity = sage.city;
        } catch (e) { /* ignore */ }
      }
      if (storyCity) {
        if (effectiveLocation?.city && effectiveLocation.city.toLowerCase() !== storyCity.toLowerCase()) {
          log.info(`[SWISS] [STREAM] Idea generation: overriding location from ${effectiveLocation.city} to ${storyCity}`);
        }
        effectiveLocation = { city: storyCity, country: 'Switzerland' };
      }
    }

    // Discover landmarks for story location (await to include in ideas prompt).
    // Skip for historical stories - they use historically accurate locations, not local landmarks.
    // Shared resolver: landmark_index (proximity fallback) -> shared cache -> live discovery.
    let availableLandmarks = [];
    if (effectiveLocation?.city && storyCategory !== 'historical') {
      log.debug(`  📍 Story location: ${effectiveLocation.city}, ${effectiveLocation.country || ''}`);
      availableLandmarks = await resolveAvailableLandmarks(effectiveLocation, {
        limit: 20, discoverOnMiss: true, language,
        onStatus: (message) => res.write(`data: ${JSON.stringify({ type: 'status', message })}\n\n`),
      });
    }
    log.debug(`  Category: ${storyCategory}, Topic: ${storyTopic}, Theme: ${storyTheme || storyTypeName}, Language: ${language}, Pages: ${pages}`);

    // Build user location instruction for personalized settings (skip for historical - events have fixed locations)
    const effectiveCategory_loc = storyCategory || 'adventure';

    let userLocationInstruction = '';
    const locationForPrompt = effectiveLocation || userLocation;
    if (locationForPrompt?.city && effectiveCategory_loc !== 'historical') {
      const locationParts = [locationForPrompt.city, locationForPrompt.region, locationForPrompt.country].filter(Boolean);
      const locationStr = locationParts.join(', ');
      userLocationInstruction = `**LOCATION PREFERENCE**: Set the story in or near ${locationStr}. Use real local landmarks, street names, parks, or recognizable places from this area to make the story feel personal and familiar to the reader. The main characters live in this area.`;
    }
    // The season holds for BOTH ideas, the made-up world included — it is what
    // the reader picked. Keeping it out of the location block is what lets it
    // survive the fantasy blanking below.
    // One builder for every path (trial idea, trial story, both idea endpoints),
    // so the wording cannot drift and an absent season resolves to the date the
    // way season.js documents rather than dropping the line.
    const seasonInstruction = effectiveCategory_loc === 'historical'
      ? ''
      : buildSeasonInstruction({ season });

    // Build available landmarks section for the prompt
    let availableLandmarksSection = '';
    if (availableLandmarks && availableLandmarks.length > 0 && effectiveCategory_loc !== 'historical') {
      const landmarkEntries = availableLandmarks
        .slice(0, 10)
        .map(l => {
          let entry = `- ${l.name}`;
          if (l.type) entry += ` (${l.type})`;
          const description = l.wikipediaExtract || l.photoDescription;
          if (description) entry += `: ${description}`;
          return entry;
        })
        .join('\n');
      availableLandmarksSection = `**AVAILABLE LOCAL LANDMARKS** (use 1-2 of these in Story 1 to make it feel personal):
${landmarkEntries}`;
      const withDesc = availableLandmarks.filter(l => l.wikipediaExtract || l.photoDescription).length;
      log.info(`[LANDMARK] ✅ [STREAM] Including ${availableLandmarks.length} landmarks in ideas prompt (${withDesc} with descriptions): ${availableLandmarks.slice(0, 3).map(l => l.name).join(', ')}...`);
    } else {
      log.info(`[LANDMARK] [STREAM] No landmarks available for ideas prompt (userLocation: ${userLocation?.city || 'none'})`);
    }

    // Use shared prompt builder
    const ctx = await buildIdeasPromptContext({
      storyCategory, storyTopic, storyTheme, storyTypeName, customThemeText,
      language, languageLevel, characters, relationships, pages,
      userLocationInstruction, availableLandmarksSection, seasonInstruction
    });

    // Get model to use
    const { callTextModelStreaming, getModelDefaults } = require('../lib/textModels');
    const modelDefaults = getModelDefaults();
    const modelToUse = (req.user.role === 'admin' && ideaModel) ? ideaModel : modelDefaults.idea;

    log.debug(`  Using model: ${modelToUse}${ideaModel && req.user.role === 'admin' ? ' (admin override)' : ' (default)'}`);

    // Helper function to parse [FINAL] from streaming text.
    //
    // IMPORTANT: Uses the LAST [FINAL] marker, not the first. The LLM
    // sometimes writes "[FINAL]" inside the [REVIEW] section (e.g. mentioning
    // "the [FINAL] instructions" while explaining its own process), which
    // used to make the parser grab from the first mention all the way to EOF
    // — pulling in the tail of the review, a literal second [FINAL] header,
    // and then the actual story. Taking the last marker gives us the real
    // final section since the prompt structure is [DRAFT] → [REVIEW] → [FINAL].
    const parseFinal = (text) => {
      const matches = [...text.matchAll(/\[FINAL\]\s*/gi)];
      if (matches.length === 0) return null;
      const lastMatch = matches[matches.length - 1];
      let result = text.slice(lastMatch.index + lastMatch[0].length).trim();
      // Strip Claude extended thinking artifacts that may leak into output
      result = result.replace(/<budget:[^>]*>[\s\S]*?<\/budget:[^>]*>/gi, '').trim();
      result = result.replace(/<[a-z_]+:[^>]*>[\s\S]*?<\/[a-z_]+:[^>]*>/gi, '').trim();
      return result;
    };

    // Resolve which world each idea plays in (null = legacy split, no labels)
    const ideaWorlds = resolveIdeaWorlds({ storyCategory, storyTheme, location: locationForPrompt, worldMode });

    // Build prompts for both stories using shared context.
    // The world decides the requirements file: 'location' = real-world setting
    // with landmarks (requirements-1), 'fantasy' = direct start in the theme
    // world, no landmarks (requirements-2). Fantasy prompts get the location
    // and landmarks sections blanked so the real city cannot leak in.
    const buildSinglePrompt = (world, variantInstruction, shape) => {
      const requirements = world === 'fantasy' ? ctx.storyRequirements2 : ctx.storyRequirements1;
      const worldOverrides = world === 'fantasy'
        ? { USER_LOCATION_INSTRUCTION: '', AVAILABLE_LANDMARKS: '' }
        : {};
      return ctx.applyReplacements(ctx.singlePromptTemplate, {
        STORY_VARIANT_INSTRUCTION: variantInstruction,
        STORY_REQUIREMENTS: requirements,
        PREMISE_SHAPE: premiseShapeInstruction(shape),
        ...worldOverrides
      });
    };

    const world1 = ideaWorlds ? ideaWorlds[0].world : 'location';
    const world2 = ideaWorlds ? ideaWorlds[1].world : 'fantasy';
    const [firstInstruction, secondInstruction] = buildVariantInstructions(world1, world2, { characters, storyTopic, storyTheme, language });

    const prompt1 = buildSinglePrompt(world1, firstInstruction, ctx.premiseShapes[0]);
    const prompt2 = buildSinglePrompt(world2, secondInstruction, ctx.premiseShapes[1]);

    // Send initial event with prompt info for dev mode + per-idea worlds so the
    // wizard can label each card before/while the ideas stream in
    res.write(`data: ${JSON.stringify({ status: 'generating', prompt: prompt1, model: modelToUse, ideaWorlds, premiseShapes: ctx.premiseShapes.map(sh => ({ id: sh.id, name: sh.name })) })}\n\n`);

    // Track state for both stories
    // Usage per arm: the two calls are independent, so the funnel's cost is
    // their sum, not one of them.
    let usage1 = null;
    let usage2 = null;
    let streamModelId = null;
    let fullResponse1 = '';
    let fullResponse2 = '';
    let lastStory1Length = 0;
    let lastStory2Length = 0;
    let story1Started = false;
    let story2Started = false;

    log.debug('  Starting parallel story generation...');

    // Stream Story 1 - progressively send raw content as it arrives
    const streamStory1 = callTextModelStreaming(prompt1, null, (delta, fullText) => {
      fullResponse1 = fullText;
      // Stream raw content progressively (every 50 chars) - don't wait for [FINAL]
      if (fullText.length > 50 && fullText.length > lastStory1Length + 50) {
        res.write(`data: ${JSON.stringify({ story1: fullText.trim() })}\n\n`);
        lastStory1Length = fullText.length;
        if (!story1Started) {
          log.debug('  Story 1 streaming started');
          story1Started = true;
        }
      }
    }, modelToUse).then((streamResult) => {
      usage1 = streamResult?.usage || null;
      streamModelId = streamResult?.modelId || streamModelId;
      // Send final story 1 content (extract [FINAL] if present for clean output)
      const extractedFinal = parseFinal(fullResponse1);
      const finalContent = extractedFinal || fullResponse1.trim();
      // Always send final content - if [FINAL] was extracted, it replaces the streamed raw content
      if (finalContent) {
        res.write(`data: ${JSON.stringify({ story1: finalContent, isFinal: true })}\n\n`);
        log.debug(`  Story 1 final: ${extractedFinal ? 'extracted [FINAL] section' : 'using full response'} (${finalContent.length} chars)`);
      }
      log.debug('  Story 1 complete');
    }).catch(err => {
      log.error('  Story 1 generation failed:', err.message);
      res.write(`data: ${JSON.stringify({ error: 'Failed to generate first story idea' })}\n\n`);
    });

    // Stream Story 2 - progressively send raw content as it arrives
    const streamStory2 = callTextModelStreaming(prompt2, null, (delta, fullText) => {
      fullResponse2 = fullText;
      // Stream raw content progressively (every 50 chars) - don't wait for [FINAL]
      if (fullText.length > 50 && fullText.length > lastStory2Length + 50) {
        res.write(`data: ${JSON.stringify({ story2: fullText.trim() })}\n\n`);
        lastStory2Length = fullText.length;
        if (!story2Started) {
          log.debug('  Story 2 streaming started');
          story2Started = true;
        }
      }
    }, modelToUse).then((streamResult) => {
      usage2 = streamResult?.usage || null;
      streamModelId = streamResult?.modelId || streamModelId;
      // Send final story 2 content (extract [FINAL] if present for clean output)
      const extractedFinal = parseFinal(fullResponse2);
      const finalContent = extractedFinal || fullResponse2.trim();
      // Always send final content - if [FINAL] was extracted, it replaces the streamed raw content
      if (finalContent) {
        res.write(`data: ${JSON.stringify({ story2: finalContent, isFinal: true })}\n\n`);
        log.debug(`  Story 2 final: ${extractedFinal ? 'extracted [FINAL] section' : 'using full response'} (${finalContent.length} chars)`);
      }
      log.debug('  Story 2 complete');
    }).catch(err => {
      log.error('  Story 2 generation failed:', err.message);
      res.write(`data: ${JSON.stringify({ error: 'Failed to generate second story idea' })}\n\n`);
    });

    // Wait for both to complete
    await Promise.all([streamStory1, streamStory2]);

    recordIdeaEvent({
      event: 'idea_generated',
      userId: req.user.id,
      category: ctx.effectiveCategory, topic: storyTopic, theme: ctx.effectiveTheme,
      language, pages, characters, worldMode,
      attempt, regenerate,
      worlds: ideaWorlds ? ideaWorlds.map(w => w.world) : null,
      shapes: ctx.premiseShapes,
      model: streamModelId || modelToUse,
      costUsd: (ideaCallCost(streamModelId || modelToUse, usage1) || 0)
             + (ideaCallCost(streamModelId || modelToUse, usage2) || 0),
      detail: { streaming: true, chars1: fullResponse1.length, chars2: fullResponse2.length },
    });
    log.debug('  Both stories complete, sending done event...');

    // Send completion with full responses for dev mode
    const combinedResponse = `=== STORY 1 ===\n${fullResponse1}\n\n=== STORY 2 ===\n${fullResponse2}`;
    res.write(`data: ${JSON.stringify({ done: true, fullResponse: combinedResponse })}\n\n`);
    log.debug('  Done event sent, closing stream');
    // Small delay before closing to let HTTP/2 proxy flush the final event
    await new Promise(resolve => setTimeout(resolve, 500));
    res.end();

  } catch (err) {
    log.error('Generate story ideas stream error:', err);
    res.write(`data: ${JSON.stringify({ error: err.message || 'Failed to generate story ideas' })}\n\n`);
    res.end();
  }
});

module.exports = router;
module.exports.buildIdeasPromptContext = buildIdeasPromptContext;
module.exports.resolveIdeaWorlds = resolveIdeaWorlds;
module.exports.buildVariantInstructions = buildVariantInstructions;
module.exports.pickPremiseShapes = pickPremiseShapes;
module.exports.premiseShapeInstruction = premiseShapeInstruction;
