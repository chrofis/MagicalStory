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
// Per-arm world seeds (a centre and a turn from the adventure guide's two lists)
// and the shared idea seed hash.
const { pickWorldSeeds, worldSeedInstruction, stripSeedLists, stripAngleList, pickHistoricalAngle, historicalAngleInstruction, pickWorldPlace, worldPlaceInstruction, ideaVariantSeed } = require('../lib/worldSeeds');

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

/**
 * What the page count means to a back cover: the SIZE of what stands behind the
 * idea, never a sentence budget and never a beat count. The old
 * {STORY_LENGTH_CATEGORY} handed the model "MEDIUM (11-20 pages) - 8 sentences
 * max per idea", which is a limit the four-to-six-sentence rule already sets,
 * stated in a unit the back cover does not use.
 *
 * @param {number} pages @returns {string} the {STORY_SCOPE} block
 */
const SCOPE_TAIL = 'The back cover stays four to six sentences whatever the scope; the scope is the size of what stands behind them.';

function buildStoryScope(pages) {
  const band = pages <= 10
    ? 'This is a short book: one place, one want, one thing in the way. The cast is beside the child. It fits in an afternoon.'
    : pages <= 20
      ? 'This is a journey: the goal is somewhere else, the story passes through two or three places, and one side character wants something of their own.'
      : 'This is a world: several places, days pass, and a second thread crosses the main one.';
  return `${band}\n\n${SCOPE_TAIL}`;
}

/**
 * The landmarks section of an IDEA prompt: at most two, one line each.
 *
 * One builder for all three callers (the pair endpoint, the streaming endpoint
 * and the rating harness) — the same block was hand-copied three times. The
 * STORY path is untouched: the resolver is shared, only this section is
 * trimmed. An idea needs a name to set the scene at, not an encyclopaedia
 * entry, so the description is cut to its first sentence.
 *
 * @param {Array} landmarks - resolveAvailableLandmarks() rows
 * @returns {string} the {AVAILABLE_LANDMARKS} block, '' when there are none
 */
function buildIdeaLandmarksSection(landmarks) {
  const rows = (landmarks || []).slice(0, 2);
  if (!rows.length) return '';
  const lines = rows.map(l => {
    let entry = `- ${l.name}`;
    if (l.type) entry += ` (${l.type})`;
    const description = l.wikipediaExtract || l.photoDescription;
    if (description) {
      // The lookbehind skips abbreviation dots ("445 m ü. M.", "ca. 1200"), which
      // otherwise end the "first sentence" mid-measurement.
      const flat = String(description).replace(/\s+/g, ' ').trim();
      const first = (flat.match(/^.*?(?<!\s[A-Za-zÄÖÜäöü]{1,2})[.!?](?=\s|$)/) || [flat])[0].trim();
      entry += `: ${first}`;
    }
    return entry;
  });
  return `**LOCAL LANDMARKS (use one or two)**\n${lines.join('\n')}`;
}

async function buildIdeasPromptContext({
  storyCategory, storyTopic, storyTheme, storyTypeName, customThemeText,
  language, languageLevel = 'standard', characters, relationships,
  pages = 10, userLocationInstruction = '', availableLandmarksSection = '',
  seasonInstruction = '',
  // Measurement knob, not a product setting. The age below which a peril-prone
  // catalogue entry or premise shape is withheld from the sample; production
  // leaves it at SHAPE_PERIL_MAX_YOUNGEST (5, set by round 11's trace). The
  // rating harness raises it to screen `peril-input`
  // (tests/manual/story-idea-rounds.js --variant=peril-input).
  perilYoungestMax = SHAPE_PERIL_MAX_YOUNGEST
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
What stands in the way is a person, a creature or a thing that answers back.
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
      // The guide itself reaches the prompt ONCE, through {TOPIC_GUIDE} below —
      // and on the idea path it is the idea-shaped view of the sheet, not the
      // sheet (getIdeaGuide). Until 2026-09-21 this block embedded the full
      // sheet AND {TOPIC_GUIDE} repeated it verbatim, so every historical idea
      // prompt carried two copies of the same fact sheet.
      categoryInstructions = `IMPORTANT: This is a HISTORICAL story about "${historicalEvent.name}" (${historicalEvent.year}).

**HISTORICAL ACCURACY REQUIRED** Use ONLY the verified information provided. Do NOT invent historical facts.`;
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
  // getIdeaGuide, not getTeachingGuide: a topic guide is a BOOK brief and a
  // historical guide is a fact SHEET; the idea call gets the idea-shaped view of
  // each (server/lib/promptBuilders.js). The STORY path still reads the guide
  // whole through getTeachingGuide.
  const { getIdeaGuide, getAdventureGuide } = require('../lib/storyHelpers');
  const teachingGuide = getIdeaGuide(effectiveCategory, storyTopic);
  // `let`, not `const`: once an angle has been picked out of the guide below,
  // the guide the PROMPT sees drops the angle list (stripAngleList).
  let topicGuideText = teachingGuide
    ? `**TOPIC GUIDE for "${storyTopic}":**
${teachingGuide}`
    : '';

  // Always get adventure guide for setting/costume context
  // The IDEA prompt sees the guide WITHOUT its two ten-item seed lists: the
  // model is handed one centre picked in code, and printing the menu beside the
  // pick is what it answered instead. getAdventureGuide itself is untouched, so
  // every story-side builder still reads the guide whole (stripSeedLists lives
  // in server/lib/worldSeeds.js, next to the parser that needs the lists).
  const adventureGuideContent = stripSeedLists(getAdventureGuide(effectiveTheme));
  const adventureSettingGuide = adventureGuideContent
    ? `**ADVENTURE SETTING GUIDE for "${effectiveTheme}":**
${adventureGuideContent}`
    : '';

  const { buildAgeModeSection } = require('../lib/promptBuilders');
  const premiseShapes = pickPremiseShapes({ characters, storyTopic, storyTheme, language, storyCategory: effectiveCategory, perilYoungestMax });
  // One centre and one turn per arm, picked in code from the adventure guide's
  // two ten-item lists (server/lib/worldSeeds.js). null — and nothing injected —
  // for a theme with no adventure guide (custom, historical).
  const worldSeeds = [0, 1].map(arm => pickWorldSeeds({ theme: effectiveTheme, characters, topic: storyTopic, language, arm }));
  // Historical has no adventure guide and therefore no centre list. Its guide's
  // own STORY ANGLES block is the same material, so the historical arms get one
  // angle each, picked the same way, into the same {WORLD_SEED*} slot.
  const historicalAngles = effectiveCategory === 'historical'
    ? [0, 1].map(arm => pickHistoricalAngle({ sheet: teachingGuide, characters, topic: storyTopic, language, arm }))
    : [null, null];
  // ONE line per arm, whichever kind it is. Every call site fills {WORLD_SEED*}
  // from here so the streaming endpoint, the pair endpoint and the rating
  // harness cannot each build their own.
  // One angle was picked in code and goes into {WORLD_SEED}; the other five stay
  // out of the prompt, exactly as stripSeedLists does on the adventure side.
  if (historicalAngles[0] && teachingGuide) {
    topicGuideText = `**TOPIC GUIDE for "${storyTopic}":**\n${stripAngleList(teachingGuide)}`;
  }
  const worldSeedLines = [0, 1].map(arm => (historicalAngles[arm]
    ? historicalAngleInstruction(historicalAngles[arm])
    : worldSeedInstruction(worldSeeds[arm])));
  // One concrete place per arm, from the guide's own setting line. Injected on
  // the FANTASY arm only (the location arm already has named landmarks), so the
  // value is computed here and the world is applied at the call site.
  const worldPlaces = [0, 1].map(arm => pickWorldPlace({ theme: effectiveTheme, characters, topic: storyTopic, language, arm }));
  // `premise-open` (promptBuilders BAND_VIEW_KEEPS), not the writer's whole band
  // file: the idea call is writing a back-cover premise, so it gets the band's
  // [[premise]] rules and not its per-page craft or its page-count arithmetic.
  // The same 2026-09-21 cut that took {SCENE_COMPLEXITY_GUIDE} and the challenge
  // catalogue out of both idea templates — those are the story writer's inputs.
  const ageModeSection = buildAgeModeSection({ characters }, { bandView: 'premise-open' });

  const storyScope = buildStoryScope(pages);

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
  // The idea variant: same language, spelling and vocabulary constants, without
  // the dialogue-typography paragraph (guillemets, em-dash, spacing). A
  // back-cover idea has no dialogue.
  const languageInstruction = getLanguageInstruction(language, { variant: 'idea' });

  // Fill templates via the shared fillTemplate (services/prompts.js) —
  // global replacement, $-escaped values, WARN + strip on unfilled
  // {UPPERCASE} placeholders. The old hand-rolled chained String.replace
  // was first-occurrence only (a placeholder appearing TWICE in
  // generate-story-ideas.txt shipped to the model literally the second time)
  // and
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
    STORY_SCOPE: storyScope,
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
    // The world seed, same per-arm shape as {PREMISE_SHAPE*}: the single-idea
    // template takes {WORLD_SEED} (overridden per arm by the caller), the
    // two-idea template {WORLD_SEED_1} / {WORLD_SEED_2}. All three declared so
    // no call site can ship an unfilled placeholder.
    WORLD_SEED: worldSeedLines[0],
    WORLD_SEED_1: worldSeedLines[0],
    WORLD_SEED_2: worldSeedLines[1],
    // {WORLD_PLACE*} is the fantasy arm's answer to the location arm's named
    // landmarks. Declared empty here for every call site — historical and the
    // location arms ship no line — and overridden by the caller on a fantasy arm.
    WORLD_PLACE: '',
    WORLD_PLACE_1: '',
    WORLD_PLACE_2: '',
    ...extraReplacements,
  });

  return {
    effectiveCategory,
    effectiveTheme,
    characterDescriptions,
    relationshipDescriptions,
    sceneCount,
    promptTemplate,
    // The guide section verbatim, so a caller can screen an edit to it without
    // rebuilding it (the `seeds-soft` variant appends one line).
    adventureSettingGuide,
    premiseShapes,
    worldSeeds,
    historicalAngles,
    worldSeedLines,
    worldPlaces,
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

// The idea seed lives in server/lib/worldSeeds.js — one definition, shared by
// the shape pick, the place-class pick and the world-seed pick.

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

// A historical idea sits inside an event that already happened and cannot be
// made to come out differently. Only the shapes that a fixed event can carry
// are offered: race against time, rescue, a promise to keep, a door that opens
// once, a message to deliver. Withheld, because each one asks the event itself
// to bend: a swap or a mix-up (round 15 cell 4 drew it on the moon landing and
// came back with two children swapping TV-listing marks while Apollo 11
// landed off-page), a secret kept, a thing that grows, and the rest.
const SHAPE_HISTORICAL_FIT = new Set([1, 2, 7, 9, 12]);

/**
 * One shape per arm, DETERMINISTIC from the same seed buildVariantInstructions
 * uses, always two different shapes, and never a shape above the youngest
 * character's age. Exported for the unit test and the rating harness.
 */
function pickPremiseShapes(seedInput = {}) {
  const chars = seedInput?.characters || [];
  const ages = chars.map(c => parseInt(c?.age, 10)).filter(Number.isFinite);
  const youngest = ages.length ? Math.min(...ages) : 8;
  const perilMax = Number.isFinite(seedInput?.perilYoungestMax) ? seedInput.perilYoungestMax : SHAPE_PERIL_MAX_YOUNGEST;
  const mains = chars.filter(c => c?.isMain).length;
  const pool = loadPremiseShapes()
    .filter(s => youngest >= s.minAge)
    .filter(s => mains >= 2 || !SHAPE_NEEDS_TWO_MAINS.has(s.id))
    .filter(s => youngest > perilMax || !SHAPE_PERIL_PRONE.has(s.id))
    .filter(s => seedInput?.storyCategory !== 'historical' || SHAPE_HISTORICAL_FIT.has(s.id));
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
  // The fantasy arm's steering is the WORLD, nothing else. "Start directly in
  // the adventure world" and "Create a DIFFERENT story" both came off it after
  // the round-10 blind: arm 2 read 3.70 against arm 1's 4.10 and the fantasy
  // world 3.63 against location's 4.08, with arm and world perfectly
  // confounded. The two calls run in parallel and cannot see each other, so
  // "be different" is unverifiable from inside one of them; the difference is
  // carried by the premise shape and the world, both picked in code.
  const first = world1 === 'fantasy'
    ? 'Avoid local landmarks - use the theme setting instead.'
    : 'Use local landmarks if available. Create an engaging story that uses the setting naturally.';
  const bothLocation = world1 === 'location' && world2 === 'location';
  let second;
  if (world2 === 'fantasy') {
    second = 'Avoid local landmarks - use the theme setting instead.';
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
      availableLandmarksSection = buildIdeaLandmarksSection(availableLandmarks);
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

    // The place line goes to the fantasy arm only — the sibling of the
    // streaming path's per-arm WORLD_PLACE.
    const placeFor = (arm) => (ideaWorlds && ideaWorlds[arm].world === 'fantasy')
      ? worldPlaceInstruction(ctx.worldPlaces[arm]) : '';
    const prompt = ctx.applyReplacements(ctx.promptTemplate, {
      STORY_REQUIREMENTS: combinedRequirements,
      WORLD_PLACE_1: placeFor(0),
      WORLD_PLACE_2: placeFor(1),
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
      detail: { streaming: false, ideasParsed: storyIdeas.length, worldSeeds: ctx.worldSeeds },
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
      availableLandmarksSection = buildIdeaLandmarksSection(availableLandmarks);
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
    const buildSinglePrompt = (world, variantInstruction, shape, seedLine, place) => {
      const requirements = world === 'fantasy' ? ctx.storyRequirements2 : ctx.storyRequirements1;
      const worldOverrides = world === 'fantasy'
        ? { USER_LOCATION_INSTRUCTION: '', AVAILABLE_LANDMARKS: '' }
        : {};
      return ctx.applyReplacements(ctx.singlePromptTemplate, {
        STORY_VARIANT_INSTRUCTION: variantInstruction,
        STORY_REQUIREMENTS: requirements,
        PREMISE_SHAPE: premiseShapeInstruction(shape),
        WORLD_SEED: seedLine,
        WORLD_PLACE: world === 'fantasy' ? worldPlaceInstruction(place) : '',
        ...worldOverrides
      });
    };

    const world1 = ideaWorlds ? ideaWorlds[0].world : 'location';
    const world2 = ideaWorlds ? ideaWorlds[1].world : 'fantasy';
    const [firstInstruction, secondInstruction] = buildVariantInstructions(world1, world2, { characters, storyTopic, storyTheme, language });

    const prompt1 = buildSinglePrompt(world1, firstInstruction, ctx.premiseShapes[0], ctx.worldSeedLines[0], ctx.worldPlaces[0]);
    const prompt2 = buildSinglePrompt(world2, secondInstruction, ctx.premiseShapes[1], ctx.worldSeedLines[1], ctx.worldPlaces[1]);

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
      detail: { streaming: true, chars1: fullResponse1.length, chars2: fullResponse2.length, worldSeeds: ctx.worldSeeds },
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
module.exports.buildStoryScope = buildStoryScope;
module.exports.buildIdeaLandmarksSection = buildIdeaLandmarksSection;
module.exports.resolveIdeaWorlds = resolveIdeaWorlds;
module.exports.buildVariantInstructions = buildVariantInstructions;
module.exports.pickPremiseShapes = pickPremiseShapes;
module.exports.premiseShapeInstruction = premiseShapeInstruction;
