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

// Services
const { log } = require('../utils/logger');

// Landmark functions
const { discoverLandmarksForLocation, getIndexedLandmarks } = require('../lib/landmarkPhotos');

// Landmark discovery cache (module-level, same as was in server.js)
const userLandmarkCache = new Map();

// Generate story ideas endpoint - FREE, no credits
router.post('/generate-story-ideas', authenticateToken, async (req, res) => {
  try {
    const { storyType, storyTypeName, storyCategory, storyTopic, storyTheme, language, languageLevel, characters, relationships, ideaModel, pages = 10, userLocation, season } = req.body;

    log.debug(`💡 Generating story ideas for user ${req.user.username}`);

    // Discover landmarks for user location (await to include in ideas prompt)
    // Skip for historical stories - they use historically accurate locations, not local landmarks
    let availableLandmarks = [];
    if (userLocation?.city && storyCategory !== 'historical') {
      log.debug(`  📍 User location: ${userLocation.city}, ${userLocation.region || ''}, ${userLocation.country || ''}`);

      const cacheKey = `${userLocation.city}_${userLocation.country || ''}`.toLowerCase().replace(/\s+/g, '_');

      // Check landmark_index table first (works for any city worldwide)
      try {
        const indexedLandmarks = await getIndexedLandmarks(userLocation.city, 20);
        if (indexedLandmarks.length > 0) {
          // For story ideas, we just need landmark names (no photos needed)
          availableLandmarks = indexedLandmarks.map(l => ({
            name: l.name,
            query: l.name,
            type: l.type,
            score: l.score,
            wikipediaExtract: l.wikipedia_extract,  // For outline prompt (what landmark IS)
            photoDescription: l.photo_description,   // For image generation (what photo looks like)
            isIndexed: true,
            landmarkIndexId: l.id
          }));
          log.info(`[LANDMARK] 📍 Using ${availableLandmarks.length} indexed landmarks for ${userLocation.city}`);
        }
      } catch (indexErr) {
        log.debug(`[LANDMARK] Indexed landmarks lookup failed: ${indexErr.message}`);
      }

      // If not in index, discover on-demand (with timeout)
      if (!availableLandmarks || availableLandmarks.length === 0) {
        log.info(`[LANDMARK] 🔍 Discovering landmarks for ${userLocation.city}, ${userLocation.country || ''}...`);

        try {
          // Use Promise.race to timeout after 15 seconds
          const discoveryPromise = discoverLandmarksForLocation(userLocation.city, userLocation.country || '', 10);
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Landmark discovery timeout')), 15000)
          );

          availableLandmarks = await Promise.race([discoveryPromise, timeoutPromise]);

          // Also update in-memory cache
          if (availableLandmarks && availableLandmarks.length > 0) {
            userLandmarkCache.set(cacheKey, {
              landmarks: availableLandmarks,
              city: userLocation.city,
              country: userLocation.country || '',
              timestamp: Date.now()
            });
            log.info(`[LANDMARK] ✅ Discovered ${availableLandmarks.length} landmarks for ${userLocation.city}`);
          }
        } catch (err) {
          log.warn(`[LANDMARK] Discovery failed or timed out for ${userLocation.city}: ${err.message}`);
          availableLandmarks = [];
        }
      }

      // Select landmark names in story language (using Wikidata variants)
      // Each landmark has variants: [{name: "Ruine Stein", lang: "de"}, {name: "Stein Castle", lang: "en"}]
      if (availableLandmarks.length > 0 && language) {
        const baseLang = language.split('-')[0].toLowerCase();
        for (const landmark of availableLandmarks) {
          if (landmark.variants && landmark.variants.length > 0) {
            // Find variant matching story language
            const match = landmark.variants.find(v => v.lang === baseLang);
            if (match && match.name !== landmark.name) {
              log.debug(`[LANDMARK] Using ${baseLang} name: "${match.name}" (was: "${landmark.name}")`);
              landmark.originalName = landmark.name; // Keep original for reference
              landmark.name = match.name;
              landmark.query = match.name;
            }
          }
        }
      }
    }
    log.debug(`  Category: ${storyCategory}, Topic: ${storyTopic}, Theme: ${storyTheme || storyTypeName}, Language: ${language}, Pages: ${pages}`);

    // Calculate scene count based on reading level
    const sceneCount = languageLevel === '1st-grade' ? pages : Math.floor(pages / 2);
    log.debug(`  Scene count: ${sceneCount} (${languageLevel})`);

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

    // Build relationship descriptions
    // Format: "Lukas is younger sibling of Manuel" (more readable than "Lukas and Manuel: younger sibling")
    const relationshipDescriptions = relationships.map(r =>
      `- ${r.character1} ${r.relationship} ${r.character2}`
    ).join('\n');

    // Get language instruction from centralized config
    const { getLanguageInstruction } = require('../lib/languages');

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
${effectiveTheme && effectiveTheme !== 'realistic' ? `Set the story in a ${effectiveTheme} adventure context.` : 'Keep the setting realistic and relatable.'}`;
    } else if (effectiveCategory === 'educational') {
      categoryInstructions = `IMPORTANT: This is an EDUCATIONAL story teaching about "${storyTopic}".
Weave learning about ${storyTopic} naturally into the plot.
Make the educational content fun and part of the adventure.
${effectiveTheme && effectiveTheme !== 'realistic' ? `Set the story in a ${effectiveTheme} adventure context.` : 'Use everyday situations to explore the topic.'}`;
    } else if (effectiveCategory === 'historical') {
      // Get historical event data and guide
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

    // Build user location instruction for personalized settings (skip for historical - events have fixed locations)
    // Season labels for prompt
    const seasonLabels = { spring: 'Spring', summer: 'Summer', autumn: 'Autumn', winter: 'Winter' };
    const seasonLabel = season ? seasonLabels[season] || season : null;

    let userLocationInstruction = '';
    if (userLocation?.city && effectiveCategory !== 'historical') {
      const locationParts = [userLocation.city, userLocation.region, userLocation.country].filter(Boolean);
      const locationStr = locationParts.join(', ');
      const seasonPart = seasonLabel ? ` The story takes place in ${seasonLabel} - include seasonal details like weather, activities, and atmosphere typical for this season.` : '';
      userLocationInstruction = `**LOCATION PREFERENCE**: Set the story in or near ${locationStr}. Use real local landmarks, street names, parks, or recognizable places from this area to make the story feel personal and familiar to the reader. The main characters live in this area.${seasonPart}`;
    } else if (seasonLabel && effectiveCategory !== 'historical') {
      // Skip season for historical stories - they have their own time period from the event
      userLocationInstruction = `**SEASON**: The story takes place in ${seasonLabel}. Include seasonal details like weather, activities, and atmosphere typical for this season.`;
    }

    // Build available landmarks section for the prompt (include photo descriptions if available)
    // Skip for historical stories - they use historically accurate locations, not local landmarks
    let availableLandmarksSection = '';
    if (availableLandmarks && availableLandmarks.length > 0 && effectiveCategory !== 'historical') {
      const landmarkEntries = availableLandmarks
        .slice(0, 10) // Limit to top 10 landmarks
        .map(l => {
          let entry = `- ${l.name}`;
          if (l.type) entry += ` (${l.type})`;
          // Prefer Wikipedia extract (what landmark IS) over photo description (what photo shows)
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
      log.info(`[LANDMARK] ⚠️ No landmarks for ideas prompt (userLocation: ${userLocation?.city || 'none'})`);
    }

    // Calculate story length category for output length limits
    const storyLengthCategory = pages <= 10 ? 'SHORT (1-10 pages) - 4 sentences max per idea' :
                                pages <= 20 ? 'MEDIUM (11-20 pages) - 6 sentences max per idea' :
                                              'LONG (21+ pages) - 8 sentences max per idea';

    // Load prompt from file and replace placeholders
    const promptTemplate = await fs.readFile(path.join(__dirname, '../../prompts', 'generate-story-ideas.txt'), 'utf-8');

    // Load category-specific story requirements (separate files for story 1 and story 2)
    const requirementsBase = effectiveCategory === 'historical'
      ? 'story-idea-requirements-historical'
      : 'story-idea-requirements-adventure';
    const storyRequirements1 = await fs.readFile(path.join(__dirname, '../../prompts', `${requirementsBase}-1.txt`), 'utf-8');
    const storyRequirements2 = await fs.readFile(path.join(__dirname, '../../prompts', `${requirementsBase}-2.txt`), 'utf-8');
    // Combined for backwards compatibility with non-streaming endpoint
    const storyRequirements = storyRequirements1 + '\n\n' + storyRequirements2;

    const prompt = promptTemplate
      .replace('{STORY_CATEGORY}', effectiveCategory === 'life-challenge' ? 'Life Skills' : effectiveCategory === 'educational' ? 'Educational' : effectiveCategory === 'historical' ? 'Historical' : 'Adventure')
      .replace('{STORY_TYPE_NAME}', effectiveTheme)
      .replace('{STORY_TOPIC}', storyTopic || 'None')
      .replace('{CHARACTER_DESCRIPTIONS}', characterDescriptions)
      .replace('{RELATIONSHIP_DESCRIPTIONS}', relationshipDescriptions || 'No specific relationships defined.')
      .replace('{READING_LEVEL_DESCRIPTION}', readingLevelDescriptions[languageLevel] || readingLevelDescriptions['standard'])
      .replace('{SCENE_COMPLEXITY_GUIDE}', sceneComplexityGuide)
      .replace('{CATEGORY_INSTRUCTIONS}', categoryInstructions)
      .replace('{TOPIC_GUIDE}', topicGuideText)
      .replace('{ADVENTURE_SETTING_GUIDE}', adventureSettingGuide)
      .replace('{USER_LOCATION_INSTRUCTION}', userLocationInstruction)
      .replace('{AVAILABLE_LANDMARKS}', availableLandmarksSection)
      .replace('{STORY_LENGTH_CATEGORY}', storyLengthCategory)
      .replace('{STORY_REQUIREMENTS}', storyRequirements)
      .replace('{LANGUAGE_INSTRUCTION}', getLanguageInstruction(language));

    // Call the text model (using the imported function)
    const { callTextModel, getModelDefaults } = require('../lib/textModels');

    // Use model override from admin, or fall back to default
    const modelDefaults = getModelDefaults();
    const modelToUse = (req.user.role === 'admin' && ideaModel) ? ideaModel : modelDefaults.idea;

    log.debug(`  Using model: ${modelToUse}${ideaModel && req.user.role === 'admin' ? ' (admin override)' : ' (default)'}`);
    const result = await callTextModel(prompt, 6000, modelToUse);

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

    // Return ideas array, prompt and model for dev mode display
    // Also include legacy storyIdea field for backwards compatibility
    res.json({
      storyIdeas,
      storyIdea: storyIdeas[0], // backwards compatibility
      prompt,
      model: modelToUse
    });

  } catch (err) {
    log.error('Generate story ideas error:', err);
    res.status(500).json({ error: err.message || 'Failed to generate story ideas' });
  }
});

// SSE Streaming endpoint for story ideas - streams each story as it completes
router.post('/generate-story-ideas-stream', authenticateToken, async (req, res) => {
  // Set up SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
  res.flushHeaders();

  try {
    const { storyType, storyTypeName, storyCategory, storyTopic, storyTheme, language, languageLevel, characters, relationships, ideaModel, pages = 10, userLocation, season } = req.body;

    log.debug(`💡 [STREAM] Generating story ideas for user ${req.user.username}`);

    // Discover landmarks for user location (await to include in ideas prompt)
    // Skip for historical stories - they use historically accurate locations, not local landmarks
    let availableLandmarks = [];
    if (userLocation?.city && storyCategory !== 'historical') {
      log.debug(`  📍 User location: ${userLocation.city}, ${userLocation.region || ''}, ${userLocation.country || ''}`);

      const cacheKey = `${userLocation.city}_${userLocation.country || ''}`.toLowerCase().replace(/\s+/g, '_');

      // Check landmark_index table first (works for any city worldwide)
      try {
        const indexedLandmarks = await getIndexedLandmarks(userLocation.city, 20);
        if (indexedLandmarks.length > 0) {
          // For story ideas, we just need landmark names (no photos needed)
          availableLandmarks = indexedLandmarks.map(l => ({
            name: l.name,
            query: l.name,
            type: l.type,
            score: l.score,
            wikipediaExtract: l.wikipedia_extract,  // For outline prompt (what landmark IS)
            photoDescription: l.photo_description,   // For image generation (what photo looks like)
            isIndexed: true,
            landmarkIndexId: l.id
          }));
          log.info(`[LANDMARK] 📍 [STREAM] Using ${availableLandmarks.length} indexed landmarks for ${userLocation.city}`);
        }
      } catch (indexErr) {
        log.debug(`[LANDMARK] Indexed landmarks lookup failed: ${indexErr.message}`);
      }

      // If not in index, discover on-demand (with timeout)
      if (!availableLandmarks || availableLandmarks.length === 0) {
        log.info(`[LANDMARK] 🔍 [STREAM] Discovering landmarks for ${userLocation.city}, ${userLocation.country || ''}...`);

        // Send SSE event to inform user about landmark discovery
        res.write(`data: ${JSON.stringify({ type: 'status', message: 'Discovering local landmarks...' })}\n\n`);

        try {
          // Use Promise.race to timeout after 15 seconds
          const discoveryPromise = discoverLandmarksForLocation(userLocation.city, userLocation.country || '', 10);
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Landmark discovery timeout')), 15000)
          );

          availableLandmarks = await Promise.race([discoveryPromise, timeoutPromise]);

          // Also update in-memory cache
          if (availableLandmarks && availableLandmarks.length > 0) {
            userLandmarkCache.set(cacheKey, {
              landmarks: availableLandmarks,
              city: userLocation.city,
              country: userLocation.country || '',
              timestamp: Date.now()
            });
            log.info(`[LANDMARK] ✅ [STREAM] Discovered ${availableLandmarks.length} landmarks for ${userLocation.city}`);
          }
        } catch (err) {
          log.warn(`[LANDMARK] [STREAM] Discovery failed or timed out for ${userLocation.city}: ${err.message}`);
          availableLandmarks = [];
        }
      }

      // Select landmark names in story language (using Wikidata variants)
      // Each landmark has variants: [{name: "Ruine Stein", lang: "de"}, {name: "Stein Castle", lang: "en"}]
      if (availableLandmarks.length > 0 && language) {
        const baseLang = language.split('-')[0].toLowerCase();
        for (const landmark of availableLandmarks) {
          if (landmark.variants && landmark.variants.length > 0) {
            // Find variant matching story language
            const match = landmark.variants.find(v => v.lang === baseLang);
            if (match && match.name !== landmark.name) {
              log.debug(`[LANDMARK] [STREAM] Using ${baseLang} name: "${match.name}" (was: "${landmark.name}")`);
              landmark.originalName = landmark.name;
              landmark.name = match.name;
              landmark.query = match.name;
            }
          }
        }
      }
    }
    log.debug(`  Category: ${storyCategory}, Topic: ${storyTopic}, Theme: ${storyTheme || storyTypeName}, Language: ${language}, Pages: ${pages}`);

    // Calculate scene count based on reading level
    const sceneCount = languageLevel === '1st-grade' ? pages : Math.floor(pages / 2);
    log.debug(`  Scene count: ${sceneCount} (${languageLevel})`);

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

    // Build relationship descriptions
    // Format: "Lukas is younger sibling of Manuel" (more readable than "Lukas and Manuel: younger sibling")
    const relationshipDescriptions = relationships.map(r =>
      `- ${r.character1} ${r.relationship} ${r.character2}`
    ).join('\n');

    // Get language instruction from centralized config
    const { getLanguageInstruction } = require('../lib/languages');

    // Determine reading level description
    const readingLevelDescriptions = {
      '1st-grade': 'Early reader (simple sentences, 6-7 year olds)',
      'advanced': 'Advanced (older children 10+)',
      'standard': 'Standard (7-9 year olds)'
    };

    // Get scene complexity guide based on page count
    const { getSceneComplexityGuide, getAdventureGuide } = require('../lib/storyHelpers');
    const sceneComplexityGuide = getSceneComplexityGuide(sceneCount);

    // Build category-specific instructions
    let categoryInstructions = '';
    const effectiveCategory = storyCategory || 'adventure';
    const effectiveTheme = storyTheme || storyTypeName || 'adventure';

    if (effectiveCategory === 'life-challenge') {
      categoryInstructions = `IMPORTANT: This is a LIFE SKILLS story about "${storyTopic}".
The story should help children understand and cope with this topic.
Show the characters facing this challenge and learning to handle it.
${effectiveTheme && effectiveTheme !== 'realistic' ? `Set the story in a ${effectiveTheme} adventure context.` : 'Keep the setting realistic and relatable.'}`;
    } else if (effectiveCategory === 'educational') {
      categoryInstructions = `IMPORTANT: This is an EDUCATIONAL story teaching about "${storyTopic}".
Weave learning about ${storyTopic} naturally into the plot.
Make the educational content fun and part of the adventure.
${effectiveTheme && effectiveTheme !== 'realistic' ? `Set the story in a ${effectiveTheme} adventure context.` : 'Use everyday situations to explore the topic.'}`;
    } else if (effectiveCategory === 'historical') {
      // Get historical event data and guide
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
    } else {
      categoryInstructions = `This is a ${effectiveTheme} adventure story. Make it exciting and appropriate for children.`;
    }

    // Get teaching guide for the topic if available
    const { getTeachingGuide } = require('../lib/storyHelpers');
    const teachingGuide = getTeachingGuide(effectiveCategory, storyTopic);
    const topicGuideText = teachingGuide
      ? `**TOPIC GUIDE for "${storyTopic}":**
${teachingGuide}`
      : '';

    // Always get adventure guide for setting/costume context
    const adventureGuideContent = getAdventureGuide(effectiveTheme);
    const adventureSettingGuide = adventureGuideContent
      ? `**ADVENTURE SETTING GUIDE for "${effectiveTheme}":**
${adventureGuideContent}`
      : '';

    // Build user location instruction for personalized settings (skip for historical - events have fixed locations)
    // Season labels for prompt
    const seasonLabels = { spring: 'Spring', summer: 'Summer', autumn: 'Autumn', winter: 'Winter' };
    const seasonLabel = season ? seasonLabels[season] || season : null;

    let userLocationInstruction = '';
    if (userLocation?.city && effectiveCategory !== 'historical') {
      const locationParts = [userLocation.city, userLocation.region, userLocation.country].filter(Boolean);
      const locationStr = locationParts.join(', ');
      const seasonPart = seasonLabel ? ` The story takes place in ${seasonLabel} - include seasonal details like weather, activities, and atmosphere typical for this season.` : '';
      userLocationInstruction = `**LOCATION PREFERENCE**: Set the story in or near ${locationStr}. Use real local landmarks, street names, parks, or recognizable places from this area to make the story feel personal and familiar to the reader. The main characters live in this area.${seasonPart}`;
    } else if (seasonLabel && effectiveCategory !== 'historical') {
      // Skip season for historical stories - they have their own time period from the event
      userLocationInstruction = `**SEASON**: The story takes place in ${seasonLabel}. Include seasonal details like weather, activities, and atmosphere typical for this season.`;
    }

    // Build available landmarks section for the prompt (include photo descriptions if available)
    // Skip for historical stories - they use historically accurate locations, not local landmarks
    let availableLandmarksSection = '';
    if (availableLandmarks && availableLandmarks.length > 0 && effectiveCategory !== 'historical') {
      const landmarkEntries = availableLandmarks
        .slice(0, 10) // Limit to top 10 landmarks
        .map(l => {
          let entry = `- ${l.name}`;
          if (l.type) entry += ` (${l.type})`;
          // Prefer Wikipedia extract (what landmark IS) over photo description (what photo shows)
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
      log.info(`[LANDMARK] ⚠️ [STREAM] No landmarks for ideas prompt (userLocation: ${userLocation?.city || 'none'})`);
    }

    // Calculate story length category for output length limits
    const storyLengthCategory = pages <= 10 ? 'SHORT (1-10 pages) - 4 sentences max per idea' :
                                pages <= 20 ? 'MEDIUM (11-20 pages) - 6 sentences max per idea' :
                                              'LONG (21+ pages) - 8 sentences max per idea';

    // Load prompt from file and replace placeholders
    const promptTemplate = await fs.readFile(path.join(__dirname, '../../prompts', 'generate-story-ideas.txt'), 'utf-8');

    // Load category-specific story requirements (separate files for story 1 and story 2)
    const requirementsBase = effectiveCategory === 'historical'
      ? 'story-idea-requirements-historical'
      : 'story-idea-requirements-adventure';
    const storyRequirements1 = await fs.readFile(path.join(__dirname, '../../prompts', `${requirementsBase}-1.txt`), 'utf-8');
    const storyRequirements2 = await fs.readFile(path.join(__dirname, '../../prompts', `${requirementsBase}-2.txt`), 'utf-8');
    // Combined for backwards compatibility with non-streaming endpoint
    const storyRequirements = storyRequirements1 + '\n\n' + storyRequirements2;

    const prompt = promptTemplate
      .replace('{STORY_CATEGORY}', effectiveCategory === 'life-challenge' ? 'Life Skills' : effectiveCategory === 'educational' ? 'Educational' : effectiveCategory === 'historical' ? 'Historical' : 'Adventure')
      .replace('{STORY_TYPE_NAME}', effectiveTheme)
      .replace('{STORY_TOPIC}', storyTopic || 'None')
      .replace('{CHARACTER_DESCRIPTIONS}', characterDescriptions)
      .replace('{RELATIONSHIP_DESCRIPTIONS}', relationshipDescriptions || 'No specific relationships defined.')
      .replace('{READING_LEVEL_DESCRIPTION}', readingLevelDescriptions[languageLevel] || readingLevelDescriptions['standard'])
      .replace('{SCENE_COMPLEXITY_GUIDE}', sceneComplexityGuide)
      .replace('{CATEGORY_INSTRUCTIONS}', categoryInstructions)
      .replace('{TOPIC_GUIDE}', topicGuideText)
      .replace('{ADVENTURE_SETTING_GUIDE}', adventureSettingGuide)
      .replace('{USER_LOCATION_INSTRUCTION}', userLocationInstruction)
      .replace('{AVAILABLE_LANDMARKS}', availableLandmarksSection)
      .replace('{STORY_LENGTH_CATEGORY}', storyLengthCategory)
      .replace('{STORY_REQUIREMENTS}', storyRequirements)
      .replace('{LANGUAGE_INSTRUCTION}', getLanguageInstruction(language));

    // Get model to use
    const { callTextModelStreaming, getModelDefaults } = require('../lib/textModels');
    const modelDefaults = getModelDefaults();
    const modelToUse = (req.user.role === 'admin' && ideaModel) ? ideaModel : modelDefaults.idea;

    log.debug(`  Using model: ${modelToUse}${ideaModel && req.user.role === 'admin' ? ' (admin override)' : ' (default)'}`);

    // Load single-story prompt template
    const singlePromptTemplate = await fs.readFile(path.join(__dirname, '../../prompts', 'generate-story-idea-single.txt'), 'utf-8');

    // Helper function to parse [FINAL] from streaming text
    const parseFinal = (text) => {
      const match = text.match(/\[FINAL\]\s*([\s\S]*?)$/i);
      if (match) {
        let result = match[1].trim();
        // Strip Claude extended thinking artifacts that may leak into output
        result = result.replace(/<budget:[^>]*>[\s\S]*?<\/budget:[^>]*>/gi, '').trim();
        result = result.replace(/<[a-z_]+:[^>]*>[\s\S]*?<\/[a-z_]+:[^>]*>/gi, '').trim();
        return result;
      }
      return null; // Return null if [FINAL] not yet reached
    };

    // Build prompt for a single story (storyNum: 1 or 2)
    const buildSinglePrompt = (storyNum, variantInstruction) => {
      const requirements = storyNum === 1 ? storyRequirements1 : storyRequirements2;
      return singlePromptTemplate
        .replace('{STORY_CATEGORY}', effectiveCategory === 'life-challenge' ? 'Life Skills' : effectiveCategory === 'educational' ? 'Educational' : effectiveCategory === 'historical' ? 'Historical' : 'Adventure')
        .replace('{STORY_TYPE_NAME}', effectiveTheme)
        .replace('{STORY_TOPIC}', storyTopic || 'None')
        .replace('{CHARACTER_DESCRIPTIONS}', characterDescriptions)
        .replace('{RELATIONSHIP_DESCRIPTIONS}', relationshipDescriptions || 'No specific relationships defined.')
        .replace('{READING_LEVEL_DESCRIPTION}', readingLevelDescriptions[languageLevel] || readingLevelDescriptions['standard'])
        .replace('{SCENE_COMPLEXITY_GUIDE}', sceneComplexityGuide)
        .replace('{CATEGORY_INSTRUCTIONS}', categoryInstructions)
        .replace('{TOPIC_GUIDE}', topicGuideText)
        .replace('{ADVENTURE_SETTING_GUIDE}', adventureSettingGuide)
        .replace('{USER_LOCATION_INSTRUCTION}', userLocationInstruction)
        .replace('{AVAILABLE_LANDMARKS}', availableLandmarksSection)
        .replace('{STORY_LENGTH_CATEGORY}', storyLengthCategory)
        .replace('{STORY_VARIANT_INSTRUCTION}', variantInstruction)
        .replace('{STORY_REQUIREMENTS}', requirements)
        .replace('{LANGUAGE_INSTRUCTION}', getLanguageInstruction(language));
    };

    // Build prompts for both stories (each with its own requirements)
    const prompt1 = buildSinglePrompt(1, 'Use local landmarks if available. Create an engaging story that uses the setting naturally.');
    const prompt2 = buildSinglePrompt(2, 'Create a DIFFERENT story. Use a different location, different approach to the conflict, and different story structure. Avoid local landmarks - use the theme setting instead.');

    // Send initial event with prompt info for dev mode
    res.write(`data: ${JSON.stringify({ status: 'generating', prompt: prompt1, model: modelToUse })}\n\n`);

    // Track state for both stories
    let fullResponse1 = '';
    let fullResponse2 = '';
    let lastStory1Length = 0;
    let lastStory2Length = 0;
    let story1Started = false;
    let story2Started = false;

    log.debug('  Starting parallel story generation...');

    // Stream Story 1 - progressively send raw content as it arrives
    const streamStory1 = callTextModelStreaming(prompt1, 3000, (delta, fullText) => {
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
    }, modelToUse).then(() => {
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
    const streamStory2 = callTextModelStreaming(prompt2, 3000, (delta, fullText) => {
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
    }, modelToUse).then(() => {
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
