/**
 * Avatar Routes
 *
 * Photo analysis, avatar generation, and face matching endpoints.
 * Extracted from server.js for better code organization.
 */

const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { log } = require('../utils/logger');
const { logActivity } = require('../services/database');
const { PROMPT_TEMPLATES, fillTemplate } = require('../services/prompts');
const { compressImageToJPEG } = require('../lib/images');

// ============================================================================
// COSTUMED AVATAR GENERATION LOG (for developer mode auditing)
// ============================================================================

// Generation log for developer mode auditing
// Tracks all costumed avatar generations with inputs, prompts, outputs, timing
let costumedAvatarGenerationLog = [];

/**
 * Create a short identifier for an image (first 12 chars of base64 data after header)
 */
function getImageIdentifier(imageData) {
  if (!imageData || typeof imageData !== 'string') return null;
  const base64 = imageData.replace(/^data:image\/\w+;base64,/, '');
  return base64.substring(0, 12) + '...';
}

/**
 * Get the size of an image in KB from base64
 */
function getImageSizeKB(imageData) {
  if (!imageData || typeof imageData !== 'string') return 0;
  const base64 = imageData.replace(/^data:image\/\w+;base64,/, '');
  return Math.round((base64.length * 3 / 4) / 1024);
}

/**
 * Get the costumed avatar generation log for developer mode auditing
 */
function getCostumedAvatarGenerationLog() {
  return [...costumedAvatarGenerationLog];
}

/**
 * Clear the costumed avatar generation log
 */
function clearCostumedAvatarGenerationLog() {
  const count = costumedAvatarGenerationLog.length;
  costumedAvatarGenerationLog = [];
  log.debug(`🗑️ [COSTUMED AVATARS] Generation log cleared (${count} entries)`);
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Extract physical traits from a photo using Gemini vision
 */
async function extractTraitsWithGemini(imageData, languageInstruction = '') {
  try {
    const geminiApiKey = process.env.GEMINI_API_KEY;
    if (!geminiApiKey) {
      log.debug('📸 [GEMINI] No API key, skipping trait extraction');
      return null;
    }

    const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
    const mimeType = imageData.match(/^data:(image\/\w+);base64,/) ?
      imageData.match(/^data:(image\/\w+);base64,/)[1] : 'image/png';

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${geminiApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              {
                text: (PROMPT_TEMPLATES.characterAnalysis || `Analyze this image of a person for a children's book illustration system. Return JSON with traits (age, gender, height, build, face, hair). Be specific about colors.`).replace('{LANGUAGE_INSTRUCTION}', languageInstruction)
              },
              {
                inlineData: {
                  mimeType: mimeType,
                  data: base64Data,
                },
              },
            ],
          }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 2048,
            responseMimeType: 'application/json'
          }
        }),
        signal: AbortSignal.timeout(20000)
      }
    );

    if (!response.ok) {
      log.error('📸 [GEMINI] API error:', response.status);
      return null;
    }

    const data = await response.json();

    // Log token usage
    const modelId = 'gemini-2.0-flash-exp';
    const inputTokens = data.usageMetadata?.promptTokenCount || 0;
    const outputTokens = data.usageMetadata?.candidatesTokenCount || 0;
    if (inputTokens > 0 || outputTokens > 0) {
      console.log(`📊 [CHARACTER ANALYSIS] Token usage - model: ${modelId}, input: ${inputTokens.toLocaleString()}, output: ${outputTokens.toLocaleString()}`);
    }

    if (data.candidates && data.candidates[0]?.content?.parts?.[0]?.text) {
      const text = data.candidates[0].content.parts[0].text;
      log.debug('📸 [GEMINI] Raw response length:', text.length);
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const result = JSON.parse(jsonMatch[0]);
        // Always include raw response for debugging
        const rawResponse = text;
        if (result.traits) {
          log.debug('📸 [GEMINI] Extracted traits:', result.traits);
          return { ...result, _rawResponse: rawResponse };
        } else {
          log.debug('📸 [GEMINI] Extracted traits (flat format):', result);
          return { traits: result, _rawResponse: rawResponse };
        }
      } else {
        log.error('📸 [GEMINI] No JSON found in response:', text.substring(0, 200));
        return { _rawResponse: text, _error: 'No JSON found in response' };
      }
    } else {
      log.error('📸 [GEMINI] Unexpected response structure:', JSON.stringify(data).substring(0, 200));
      return { _rawResponse: JSON.stringify(data), _error: 'Unexpected response structure' };
    }
    return null;
  } catch (err) {
    log.error('📸 [GEMINI] Trait extraction error:', err.message);
    return null;
  }
}

/**
 * Evaluate face match between original photo and generated avatar
 * Also extracts physical traits from reference photo and clothing from avatar
 * Returns { score, details, physicalTraits, clothing } or null on error
 */
async function evaluateAvatarFaceMatch(originalPhoto, generatedAvatar, geminiApiKey) {
  try {
    const originalBase64 = originalPhoto.replace(/^data:image\/\w+;base64,/, '');
    const originalMime = originalPhoto.match(/^data:(image\/\w+);base64,/) ?
      originalPhoto.match(/^data:(image\/\w+);base64,/)[1] : 'image/png';

    const avatarBase64 = generatedAvatar.replace(/^data:image\/\w+;base64,/, '');
    const avatarMime = generatedAvatar.match(/^data:(image\/\w+);base64,/) ?
      generatedAvatar.match(/^data:(image\/\w+);base64,/)[1] : 'image/jpeg';

    const evalPrompt = PROMPT_TEMPLATES.avatarEvaluation || 'Compare these two faces. Rate similarity 1-10. Output: FINAL SCORE: [number]';

    const requestBody = {
      contents: [{
        parts: [
          { inline_data: { mime_type: originalMime, data: originalBase64 } },
          { inline_data: { mime_type: avatarMime, data: avatarBase64 } },
          { text: evalPrompt }
        ]
      }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 4000,
        responseMimeType: 'application/json'
      },
      safetySettings: [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
      ]
    };

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(30000)
      }
    );

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    const responseText = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';

    // Log token usage
    const inputTokens = data.usageMetadata?.promptTokenCount || 0;
    const outputTokens = data.usageMetadata?.candidatesTokenCount || 0;
    if (inputTokens > 0) {
      console.log(`📊 [AVATAR EVAL] model: gemini-2.5-flash, input: ${inputTokens.toLocaleString()}, output: ${outputTokens.toLocaleString()}`);
    }

    log.debug(`🔍 [AVATAR EVAL] Raw response: ${responseText.substring(0, 300)}${responseText.length > 300 ? '...' : ''}`);

    // Parse JSON response (new combined format)
    try {
      const evalResult = JSON.parse(responseText);

      // Extract face match from new nested structure
      const faceMatch = evalResult.faceMatch || evalResult;
      const score = faceMatch.finalScore || evalResult.finalScore;

      // Extract physical traits (from reference photo)
      const physicalTraits = evalResult.physicalTraits || null;

      // Extract structured clothing (from generated avatar)
      const clothing = evalResult.clothing || null;

      if (typeof score === 'number' && score >= 1 && score <= 10) {
        const fm = faceMatch;
        const details = [
          `Face Shape: ${fm.faceShape?.score}/10 - ${fm.faceShape?.reason}`,
          `Eyes: ${fm.eyes?.score}/10 - ${fm.eyes?.reason}`,
          `Nose: ${fm.nose?.score}/10 - ${fm.nose?.reason}`,
          `Mouth: ${fm.mouth?.score}/10 - ${fm.mouth?.reason}`,
          `Overall: ${fm.overallStructure?.score}/10 - ${fm.overallStructure?.reason}`,
          `Final Score: ${score}/10`
        ].join('\n');

        log.debug(`🔍 [AVATAR EVAL] Score: ${score}/10`);
        if (physicalTraits) {
          log.debug(`🔍 [AVATAR EVAL] Extracted traits: ${JSON.stringify(physicalTraits).substring(0, 100)}...`);
        }
        if (clothing) {
          log.debug(`🔍 [AVATAR EVAL] Extracted clothing: ${JSON.stringify(clothing)}`);
        }

        return { score, details, physicalTraits, clothing, raw: evalResult };
      }
    } catch (parseErr) {
      log.warn(`[AVATAR EVAL] JSON parse failed, trying text fallback: ${parseErr.message}`);
      const scoreMatch = responseText.match(/finalScore["']?\s*:\s*(\d+)/i);
      if (scoreMatch) {
        const score = parseInt(scoreMatch[1], 10);
        return { score, details: responseText, physicalTraits: null, clothing: null };
      }
    }

    return null;
  } catch (err) {
    log.error('[AVATAR EVAL] Error evaluating face match:', err.message);
    return null;
  }
}

/**
 * Get clothing style prompt for a given category and gender
 */
function getClothingStylePrompt(category, isFemale) {
  const template = PROMPT_TEMPLATES.avatarMainPrompt || '';
  const styleSection = template.split('CLOTHING_STYLES:')[1] || '';

  let tag;
  if (category === 'winter') {
    tag = isFemale ? '[WINTER_FEMALE]' : '[WINTER_MALE]';
  } else if (category === 'standard') {
    tag = isFemale ? '[STANDARD_FEMALE]' : '[STANDARD_MALE]';
  } else if (category === 'summer') {
    tag = isFemale ? '[SUMMER_FEMALE]' : '[SUMMER_MALE]';
  } else if (category === 'formal') {
    tag = isFemale ? '[FORMAL_FEMALE]' : '[FORMAL_MALE]';
  } else {
    return 'Full outfit with shoes matching the style of the reference.';
  }

  const tagIndex = styleSection.indexOf(tag);
  if (tagIndex === -1) {
    return 'Full outfit with shoes matching the style of the reference.';
  }

  const afterTag = styleSection.substring(tagIndex + tag.length);
  const nextTagIndex = afterTag.search(/\n\[/);
  const styleText = nextTagIndex === -1 ? afterTag : afterTag.substring(0, nextTagIndex);

  return styleText.trim();
}

/**
 * Build clothing prompt for dynamic avatar generation
 * Handles signature items (additions to base) and full costume descriptions
 *
 * @param {string} category - 'standard', 'winter', 'summer', or 'costumed'
 * @param {Object} config - { signature?: string, costume?: string, description?: string }
 * @param {boolean} isFemale - Whether character is female
 * @returns {string} - Clothing prompt for avatar generation
 */
function getDynamicClothingPrompt(category, config, isFemale) {
  // For costumed: use full costume description
  if (category === 'costumed' && config.description) {
    const costumeType = config.costume || 'costume';
    return `FULL COSTUME TRANSFORMATION - ${costumeType.toUpperCase()}:
${config.description}

This is a COMPLETE outfit change. The character wears this entire costume from head to toe.
Include ALL costume elements: headwear, shirt/top, pants/skirt/dress, footwear, and any accessories mentioned.
The costume should look authentic and age-appropriate for a children's book illustration.`;
  }

  // For standard/winter/summer: use base prompt + optional signature items
  const basePrompt = getClothingStylePrompt(category, isFemale);

  if (config.signature) {
    return `${basePrompt}

SIGNATURE ITEMS (MUST INCLUDE these specific elements):
${config.signature}

These signature items are essential to the character's look in this story.
Add them to the base outfit described above. They should be prominently visible.`;
  }

  // No signature - just use base prompt
  return basePrompt;
}

/**
 * Generate a single avatar with dynamic clothing requirements
 * Called internally from story generation flow
 *
 * @param {Object} character - Character object with photoUrl, physicalTraits, etc.
 * @param {string} category - 'standard', 'winter', 'summer', or 'costumed'
 * @param {Object} config - { signature?: string, costume?: string, description?: string }
 * @returns {Promise<Object>} - { success, imageData, clothing, error? }
 */
async function generateDynamicAvatar(character, category, config) {
  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (!geminiApiKey) {
    log.error('[DYNAMIC AVATAR] No Gemini API key available');
    return { success: false, error: 'Avatar generation service unavailable' };
  }

  const facePhoto = character.photoUrl || character.photos?.face || character.photos?.original;
  if (!facePhoto) {
    log.error(`[DYNAMIC AVATAR] No face photo for ${character.name}`);
    return { success: false, error: 'No face photo available' };
  }

  const isFemale = character.gender === 'female';
  const costumeType = category === 'costumed' ? (config.costume || 'costume').toLowerCase() : null;
  const logCategory = costumeType ? `costumed:${costumeType}` : category;

  log.debug(`🎭 [DYNAMIC AVATAR] Generating ${logCategory} avatar for ${character.name}`);

  try {
    // Build physical traits section
    let physicalTraitsSection = '';
    const physicalTraits = character.physical || character.physicalTraits;
    if (physicalTraits || character.build || character.age) {
      const traitParts = [];
      if (character.apparentAge) {
        traitParts.push(`Apparent age: ${character.apparentAge}`);
      } else if (character.age) {
        traitParts.push(`Age: ${character.age} years old`);
      }
      if (character.build) traitParts.push(`Build: ${character.build}`);
      else if (physicalTraits?.build) traitParts.push(`Build: ${physicalTraits.build}`);
      if (physicalTraits?.hairColor) traitParts.push(`Hair color: ${physicalTraits.hairColor}`);
      if (physicalTraits?.hairLength) traitParts.push(`Hair length: ${physicalTraits.hairLength}`);
      if (physicalTraits?.hairStyle) traitParts.push(`Hair style: ${physicalTraits.hairStyle}`);
      if (physicalTraits?.eyeColor) traitParts.push(`Eye color: ${physicalTraits.eyeColor}`);
      if (physicalTraits?.face) traitParts.push(`Face: ${physicalTraits.face}`);
      if (physicalTraits?.other) traitParts.push(`Distinctive features: ${physicalTraits.other}`);
      if (traitParts.length > 0) {
        physicalTraitsSection = `\n\nPHYSICAL CHARACTERISTICS (MUST INCLUDE):\n${traitParts.join('\n')}`;
      }
    }

    // Build the prompt
    const promptPart = (PROMPT_TEMPLATES.avatarMainPrompt || '').split('---\nCLOTHING_STYLES:')[0].trim();
    const clothingPrompt = getDynamicClothingPrompt(category, config, isFemale);
    let avatarPrompt = fillTemplate(promptPart, {
      'CLOTHING_STYLE': clothingPrompt
    });
    if (physicalTraitsSection) {
      avatarPrompt += physicalTraitsSection;
    }

    // Prepare image data
    const base64Data = facePhoto.replace(/^data:image\/\w+;base64,/, '');
    const mimeType = facePhoto.match(/^data:(image\/\w+);base64,/) ?
      facePhoto.match(/^data:(image\/\w+);base64,/)[1] : 'image/png';

    const requestBody = {
      systemInstruction: {
        parts: [{
          text: PROMPT_TEMPLATES.avatarSystemInstruction
        }]
      },
      contents: [{
        parts: [
          {
            inline_data: {
              mime_type: mimeType,
              data: base64Data
            }
          },
          { text: avatarPrompt }
        ]
      }],
      generationConfig: {
        temperature: 0.3,
        responseModalities: ["TEXT", "IMAGE"],
        imageConfig: {
          aspectRatio: "9:16"
        }
      },
      safetySettings: [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" }
      ]
    };

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${geminiApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      log.error(`❌ [DYNAMIC AVATAR] ${logCategory} generation failed:`, errorText);
      return { success: false, error: `API error: ${response.status}` };
    }

    let data = await response.json();

    // Log token usage
    const inputTokens = data.usageMetadata?.promptTokenCount || 0;
    const outputTokens = data.usageMetadata?.candidatesTokenCount || 0;
    if (inputTokens > 0 || outputTokens > 0) {
      console.log(`📊 [DYNAMIC AVATAR] ${logCategory} - input: ${inputTokens.toLocaleString()}, output: ${outputTokens.toLocaleString()}`);
    }

    // Check if blocked by safety filters
    if (data.promptFeedback?.blockReason) {
      log.warn(`[DYNAMIC AVATAR] ${logCategory} blocked by safety filters:`, data.promptFeedback.blockReason);
      return { success: false, error: `Blocked by safety filters: ${data.promptFeedback.blockReason}` };
    }

    // Extract image from response
    let imageData = null;
    if (data.candidates && data.candidates[0]?.content?.parts) {
      for (const part of data.candidates[0].content.parts) {
        if (part.inlineData?.mimeType?.startsWith('image/')) {
          const imgMime = part.inlineData.mimeType;
          imageData = `data:${imgMime};base64,${part.inlineData.data}`;
          break;
        }
      }
    }

    if (!imageData) {
      log.error(`❌ [DYNAMIC AVATAR] No image in response for ${logCategory}`);
      return { success: false, error: 'No image generated' };
    }

    // Compress the avatar
    const compressed = await compressImageToJPEG(imageData, 85, 768);
    const finalImageData = compressed || imageData;

    // Evaluate face match to get clothing description
    let clothingDescription = null;
    const faceMatchResult = await evaluateAvatarFaceMatch(facePhoto, finalImageData, geminiApiKey);
    if (faceMatchResult?.clothing) {
      clothingDescription = faceMatchResult.clothing;
      log.debug(`👕 [DYNAMIC AVATAR] ${logCategory} clothing: ${clothingDescription}`);
    }

    log.debug(`✅ [DYNAMIC AVATAR] Generated ${logCategory} avatar for ${character.name}`);

    return {
      success: true,
      imageData: finalImageData,
      clothing: clothingDescription,
      signature: config.signature || null,
      costumeType: costumeType
    };

  } catch (err) {
    log.error(`❌ [DYNAMIC AVATAR] Error generating ${logCategory}:`, err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Load art style prompts from prompts/art-styles.txt
 */
function loadArtStylePrompts() {
  const fs = require('fs');
  const artStylesPath = require('path').join(__dirname, '../../prompts/art-styles.txt');
  const prompts = {};
  try {
    const content = fs.readFileSync(artStylesPath, 'utf8');
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const colonIndex = trimmed.indexOf(':');
        if (colonIndex > 0) {
          const styleId = trimmed.substring(0, colonIndex).trim();
          const prompt = trimmed.substring(colonIndex + 1).trim();
          prompts[styleId] = prompt;
        }
      }
    }
  } catch (err) {
    log.error(`[AVATARS] Failed to load art-styles.txt:`, err.message);
  }
  return prompts;
}

const ART_STYLE_PROMPTS = loadArtStylePrompts();

/**
 * Generate a styled costumed avatar in a single API call
 * Combines costume transformation + art style conversion
 *
 * @param {Object} character - Character object with photoUrl, physicalTraits, etc.
 * @param {Object} config - { costume: string, description: string }
 * @param {string} artStyle - Art style ID (pixar, watercolor, oil, etc.)
 * @returns {Promise<Object>} - { success, imageData, clothing, costumeType, artStyle, error? }
 */
async function generateStyledCostumedAvatar(character, config, artStyle) {
  const startTime = Date.now();
  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (!geminiApiKey) {
    log.error('[STYLED COSTUME] No Gemini API key available');
    return { success: false, error: 'Avatar generation service unavailable' };
  }

  // Get high-resolution face photo (prefer original, then face thumbnail)
  const facePhoto = character.photos?.face || character.photos?.original || character.photoUrl;
  if (!facePhoto) {
    log.error(`[STYLED COSTUME] No face photo for ${character.name}`);
    return { success: false, error: 'No face photo available' };
  }

  // Get standard avatar for body reference (already has correct proportions)
  const standardAvatar = character.avatars?.standard;

  const costumeType = (config.costume || 'costume').toLowerCase();
  const artStylePrompt = ART_STYLE_PROMPTS[artStyle] || ART_STYLE_PROMPTS.pixar || '';

  log.debug(`🎨 [STYLED COSTUME] Generating ${costumeType} avatar in ${artStyle} style for ${character.name} (${standardAvatar ? '2 reference images' : 'face only'})`);

  try {
    // Build physical traits section
    let physicalTraitsSection = '';
    const physicalTraits = character.physical || character.physicalTraits;
    if (physicalTraits || character.build || character.age) {
      const traitParts = [];
      if (character.apparentAge) {
        traitParts.push(`Apparent age: ${character.apparentAge}`);
      } else if (character.age) {
        traitParts.push(`Age: ${character.age} years old`);
      }
      if (character.build) traitParts.push(`Build: ${character.build}`);
      else if (physicalTraits?.build) traitParts.push(`Build: ${physicalTraits.build}`);
      if (physicalTraits?.hairColor) traitParts.push(`Hair color: ${physicalTraits.hairColor}`);
      if (physicalTraits?.hairStyle) traitParts.push(`Hair style: ${physicalTraits.hairStyle}`);
      if (physicalTraits?.eyeColor) traitParts.push(`Eye color: ${physicalTraits.eyeColor}`);
      if (physicalTraits?.face) traitParts.push(`Face: ${physicalTraits.face}`);
      if (traitParts.length > 0) {
        physicalTraitsSection = `\n\nPHYSICAL CHARACTERISTICS (preserve these):\n${traitParts.join('\n')}`;
      }
    }

    // Build the combined prompt using the styled-costumed-avatar template
    const template = PROMPT_TEMPLATES.styledCostumedAvatar || '';
    const avatarPrompt = fillTemplate(template, {
      'ART_STYLE_PROMPT': artStylePrompt,
      'COSTUME_DESCRIPTION': config.description || 'A creative costume appropriate for the story',
      'COSTUME_TYPE': config.costume || 'Costume',
      'PHYSICAL_TRAITS': physicalTraitsSection
    });

    // Prepare face photo data
    const faceBase64 = facePhoto.replace(/^data:image\/\w+;base64,/, '');
    const faceMimeType = facePhoto.match(/^data:(image\/\w+);base64,/) ?
      facePhoto.match(/^data:(image\/\w+);base64,/)[1] : 'image/jpeg';

    // Build image parts array (face photo + optional standard avatar)
    const imageParts = [
      {
        inline_data: {
          mime_type: faceMimeType,
          data: faceBase64
        }
      }
    ];

    // Add standard avatar as second reference if available
    if (standardAvatar) {
      const avatarBase64 = standardAvatar.replace(/^data:image\/\w+;base64,/, '');
      const avatarMimeType = standardAvatar.match(/^data:(image\/\w+);base64,/) ?
        standardAvatar.match(/^data:(image\/\w+);base64,/)[1] : 'image/jpeg';
      imageParts.push({
        inline_data: {
          mime_type: avatarMimeType,
          data: avatarBase64
        }
      });
    }

    // Build system instruction based on available references
    const systemText = standardAvatar
      ? `You are an expert character artist creating stylized avatar illustrations for children's books.
You are given TWO reference images:
1. A high-resolution face photo showing the person's exact facial features
2. A standard avatar showing the person's body proportions and build
Your task is to create a new avatar in ${artStyle} style that:
- Preserves the EXACT facial identity from the face photo (image 1)
- Uses the body proportions from the standard avatar (image 2)
- Applies the specified costume`
      : `You are an expert character artist creating stylized avatar illustrations for children's books.
Your task is to transform a reference photo into a ${artStyle} style illustration while preserving the person's identity and applying a specific costume.`;

    const requestBody = {
      systemInstruction: {
        parts: [{ text: systemText }]
      },
      contents: [{
        parts: [
          ...imageParts,
          { text: avatarPrompt }
        ]
      }],
      generationConfig: {
        temperature: 0.4,
        responseModalities: ["TEXT", "IMAGE"],
        imageConfig: {
          aspectRatio: "9:16"
        }
      },
      safetySettings: [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" }
      ]
    };

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${geminiApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      log.error(`❌ [STYLED COSTUME] Generation failed:`, errorText);
      return { success: false, error: `API error: ${response.status}` };
    }

    let data = await response.json();

    // Log token usage
    const inputTokens = data.usageMetadata?.promptTokenCount || 0;
    const outputTokens = data.usageMetadata?.candidatesTokenCount || 0;
    if (inputTokens > 0 || outputTokens > 0) {
      console.log(`📊 [STYLED COSTUME] ${costumeType}@${artStyle} - input: ${inputTokens.toLocaleString()}, output: ${outputTokens.toLocaleString()}`);
    }

    // Check if blocked by safety filters
    if (data.promptFeedback?.blockReason) {
      log.warn(`[STYLED COSTUME] Blocked by safety filters:`, data.promptFeedback.blockReason);
      return { success: false, error: `Blocked by safety filters: ${data.promptFeedback.blockReason}` };
    }

    // Extract image from response
    let imageData = null;
    if (data.candidates && data.candidates[0]?.content?.parts) {
      for (const part of data.candidates[0].content.parts) {
        if (part.inlineData?.mimeType?.startsWith('image/')) {
          const imgMime = part.inlineData.mimeType;
          imageData = `data:${imgMime};base64,${part.inlineData.data}`;
          break;
        }
      }
    }

    if (!imageData) {
      log.error(`❌ [STYLED COSTUME] No image in response`);
      return { success: false, error: 'No image generated' };
    }

    // Compress the avatar
    const compressed = await compressImageToJPEG(imageData, 85, 768);
    const finalImageData = compressed || imageData;

    // Evaluate face match to get clothing description
    let clothingDescription = null;
    const faceMatchResult = await evaluateAvatarFaceMatch(facePhoto, finalImageData, geminiApiKey);
    if (faceMatchResult?.clothing) {
      clothingDescription = faceMatchResult.clothing;
      log.debug(`👕 [STYLED COSTUME] Clothing extracted: ${JSON.stringify(clothingDescription)}`);
    }

    const duration = Date.now() - startTime;
    log.debug(`✅ [STYLED COSTUME] Generated ${costumeType}@${artStyle} avatar for ${character.name} in ${duration}ms`);

    // Log generation details for developer mode auditing
    costumedAvatarGenerationLog.push({
      timestamp: new Date().toISOString(),
      characterName: character.name,
      costumeType,
      artStyle,
      costumeDescription: config.description || '',
      durationMs: duration,
      success: true,
      inputs: {
        facePhoto: {
          identifier: getImageIdentifier(facePhoto),
          sizeKB: getImageSizeKB(facePhoto),
          imageData: facePhoto
        },
        standardAvatar: standardAvatar ? {
          identifier: getImageIdentifier(standardAvatar),
          sizeKB: getImageSizeKB(standardAvatar),
          imageData: standardAvatar
        } : null
      },
      prompt: avatarPrompt,
      output: {
        identifier: getImageIdentifier(finalImageData),
        sizeKB: getImageSizeKB(finalImageData),
        imageData: finalImageData
      }
    });

    return {
      success: true,
      imageData: finalImageData,
      clothing: clothingDescription,
      costumeType: costumeType,
      artStyle: artStyle
    };

  } catch (err) {
    const duration = Date.now() - startTime;
    log.error(`❌ [STYLED COSTUME] Error:`, err.message);

    // Log failed generation
    costumedAvatarGenerationLog.push({
      timestamp: new Date().toISOString(),
      characterName: character.name,
      costumeType,
      artStyle,
      costumeDescription: config.description || '',
      durationMs: duration,
      success: false,
      error: err.message,
      inputs: {
        facePhoto: {
          identifier: getImageIdentifier(facePhoto),
          sizeKB: getImageSizeKB(facePhoto),
          imageData: facePhoto
        },
        standardAvatar: standardAvatar ? {
          identifier: getImageIdentifier(standardAvatar),
          sizeKB: getImageSizeKB(standardAvatar),
          imageData: standardAvatar
        } : null
      }
    });

    return { success: false, error: err.message };
  }
}

// ============================================================================
// ROUTES
// ============================================================================

/**
 * POST /api/analyze-photo
 * Analyze a photo to detect face and body (Python service)
 * Physical traits are now extracted during avatar evaluation, not here
 */
router.post('/analyze-photo', authenticateToken, async (req, res) => {
  try {
    const { imageData } = req.body;

    if (!imageData) {
      log.debug('📸 [PHOTO] Missing imageData in request');
      return res.status(400).json({ error: 'Missing imageData' });
    }

    const imageSize = imageData.length;
    const imageType = imageData.substring(0, 30);
    log.debug(`📸 [PHOTO] Received image: ${imageSize} bytes, type: ${imageType}...`);

    const photoAnalyzerUrl = process.env.PHOTO_ANALYZER_URL || 'http://127.0.0.1:5000';
    log.debug(`📸 [PHOTO] Calling Python service at: ${photoAnalyzerUrl}/analyze`);

    const startTime = Date.now();

    try {
      // Only run Python analysis for face/body detection
      // Physical traits are extracted during avatar evaluation
      const analyzerResponse = await fetch(`${photoAnalyzerUrl}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: imageData }),
        signal: AbortSignal.timeout(30000)
      });
      const analyzerData = await analyzerResponse.json();

      const duration = Date.now() - startTime;

      log.debug(`📸 [PHOTO] Analysis complete in ${duration}ms:`, {
        pythonSuccess: analyzerData.success,
        hasError: !!analyzerData.error,
        error: analyzerData.error || null,
        hasFaceThumbnail: !!analyzerData.faceThumbnail || !!analyzerData.face_thumbnail,
        hasBodyCrop: !!analyzerData.bodyCrop || !!analyzerData.body_crop,
        hasBodyNoBg: !!analyzerData.bodyNoBg || !!analyzerData.body_no_bg,
        traceback: analyzerData.traceback ? analyzerData.traceback.substring(0, 500) : null
      });

      if (!analyzerData.success) {
        if (analyzerData.error === 'no_face_detected') {
          log.warn('📸 [PHOTO] No face detected in photo');
          return res.json({
            success: false,
            error: 'no_face_detected'
          });
        }
        log.error('📸 [PHOTO] Python analysis failed:', analyzerData.error, analyzerData.traceback);
        return res.status(500).json({
          error: 'Photo analysis failed',
          details: analyzerData.error || 'Unknown error',
          traceback: analyzerData.traceback
        });
      }

      await logActivity(req.user.id, req.user.username, 'PHOTO_ANALYZED', {
        hasFace: !!analyzerData.face_thumbnail || !!analyzerData.faceThumbnail,
        hasBody: !!analyzerData.body_crop || !!analyzerData.bodyCrop
      });

      // Convert snake_case to camelCase for frontend compatibility
      // Physical traits are now extracted during avatar evaluation, not here
      const response = {
        success: analyzerData.success,
        faceThumbnail: analyzerData.face_thumbnail || analyzerData.faceThumbnail,
        bodyCrop: analyzerData.body_crop || analyzerData.bodyCrop,
        bodyNoBg: analyzerData.body_no_bg || analyzerData.bodyNoBg,
        faceBox: analyzerData.face_box || analyzerData.faceBox,
        bodyBox: analyzerData.body_box || analyzerData.bodyBox
      };

      log.debug('📸 [PHOTO] Sending response (face/body detection only)');
      res.json(response);

    } catch (fetchErr) {
      log.error('Photo analyzer service error:', fetchErr.message);

      if (fetchErr.cause?.code === 'ECONNREFUSED') {
        return res.status(503).json({
          error: 'Photo analysis service unavailable',
          details: 'The photo analysis service is not running. Please contact support.',
          fallback: true
        });
      }

      throw fetchErr;
    }

  } catch (err) {
    log.error('Error analyzing photo:', err);
    res.status(500).json({
      error: 'Failed to analyze photo',
      details: err.message,
      fallback: true
    });
  }
});

/**
 * GET /api/avatar-prompt
 * Get the avatar generation prompt for a given category and gender (for developer mode)
 */
router.get('/avatar-prompt', authenticateToken, async (req, res) => {
  try {
    const { category, gender } = req.query;
    const isFemale = gender === 'female';

    // Build the prompt from template
    const promptPart = (PROMPT_TEMPLATES.avatarMainPrompt || '').split('---\nCLOTHING_STYLES:')[0].trim();
    const clothingStyle = getClothingStylePrompt(category, isFemale);
    let avatarPrompt = fillTemplate(promptPart, {
      'CLOTHING_STYLE': clothingStyle
    });

    // If physical traits are provided, append them
    if (req.query.withTraits === 'true' || req.query.build) {
      const traitParts = [];
      if (req.query.build) traitParts.push(`Build: ${req.query.build}`);
      if (req.query.hair) traitParts.push(`Hair: ${req.query.hair}`);
      if (req.query.face) traitParts.push(`Face: ${req.query.face}`);
      if (req.query.other) traitParts.push(`Distinctive features: ${req.query.other}`);
      if (traitParts.length > 0) {
        avatarPrompt += `\n\nPHYSICAL CHARACTERISTICS (MUST INCLUDE):\n${traitParts.join('\n')}`;
      }
    }

    res.json({ success: true, prompt: avatarPrompt });
  } catch (error) {
    log.error('Error getting avatar prompt:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/generate-clothing-avatars
 * Generate clothing avatars for a character (winter, standard, summer, formal)
 */
router.post('/generate-clothing-avatars', authenticateToken, async (req, res) => {
  try {
    const { characterId, facePhoto, physicalDescription, name, age, apparentAge, gender, build, physicalTraits } = req.body;

    if (!facePhoto) {
      return res.status(400).json({ error: 'Missing facePhoto' });
    }

    const geminiApiKey = process.env.GEMINI_API_KEY;
    if (!geminiApiKey) {
      return res.status(503).json({ error: 'Avatar generation service unavailable' });
    }

    // Build physical traits section for avatar generation
    // Default build to "athletic" for initial generation (can be changed by user later)
    const effectiveBuild = build || physicalTraits?.build || 'athletic';

    let physicalTraitsSection = '';
    const traitParts = [];

    // Add apparent age first (most important for body generation)
    if (apparentAge) {
      traitParts.push(`Apparent age: ${apparentAge}`);
    } else if (age) {
      traitParts.push(`Age: ${age} years old`);
    }

    // Always include build (defaulting to athletic)
    traitParts.push(`Build: ${effectiveBuild}`);

    // Use new separated hair fields if available, otherwise fall back to combined 'hair' field
    if (physicalTraits?.hairColor) traitParts.push(`Hair color: ${physicalTraits.hairColor}`);
    if (physicalTraits?.hairLength) traitParts.push(`Hair length: ${physicalTraits.hairLength}`);
    if (physicalTraits?.hairStyle) traitParts.push(`Hair style: ${physicalTraits.hairStyle}`);
    if (!physicalTraits?.hairColor && !physicalTraits?.hairLength && !physicalTraits?.hairStyle && physicalTraits?.hair) {
      traitParts.push(`Hair: ${physicalTraits.hair}`);
    }
    if (physicalTraits?.eyeColor) traitParts.push(`Eye color: ${physicalTraits.eyeColor}`);
    if (physicalTraits?.facialHair && physicalTraits.facialHair !== 'none') {
      traitParts.push(`Facial hair: ${physicalTraits.facialHair}`);
    }
    if (physicalTraits?.face) traitParts.push(`Face: ${physicalTraits.face}`);
    if (physicalTraits?.other) traitParts.push(`Distinctive features: ${physicalTraits.other}`);

    if (traitParts.length > 0) {
      physicalTraitsSection = `\n\nPHYSICAL CHARACTERISTICS (MUST INCLUDE):\n${traitParts.join('\n')}`;
    }
    log.debug(`👔 [CLOTHING AVATARS] Using build: ${effectiveBuild}, traits: ${traitParts.join(', ')}`);

    log.debug(`👔 [CLOTHING AVATARS] Starting generation for ${name} (id: ${characterId})${physicalTraits ? ' WITH TRAITS' : ''}`);

    const isFemale = gender === 'female';

    // Define clothing categories - generate winter, standard, and summer avatars in parallel
    // Formal avatar is not generated (rarely needed)
    const clothingCategories = {
      winter: { emoji: '❄️' },
      standard: { emoji: '👕' },
      summer: { emoji: '☀️' }
    };

    const results = {
      status: 'generating',
      generatedAt: null,
      faceMatch: {},
      clothing: {},           // Legacy: text clothing per category
      structuredClothing: {}, // New: structured clothing from evaluation
      extractedTraits: null,  // Physical traits extracted from reference photo
      rawEvaluation: null,    // Full unfiltered API response (for dev mode)
      prompts: {}
    };

    // Prepare base64 data once for all requests
    const base64Data = facePhoto.replace(/^data:image\/\w+;base64,/, '');
    const mimeType = facePhoto.match(/^data:(image\/\w+);base64,/) ?
      facePhoto.match(/^data:(image\/\w+);base64,/)[1] : 'image/png';

    // Helper function to generate a single avatar
    const generateSingleAvatar = async (category, config) => {
      try {
        log.debug(`${config.emoji} [CLOTHING AVATARS] Generating ${category} avatar for ${name} (${gender || 'unknown'})...`);

        // Build the prompt from template
        const promptPart = (PROMPT_TEMPLATES.avatarMainPrompt || '').split('---\nCLOTHING_STYLES:')[0].trim();
        const clothingStylePrompt = getClothingStylePrompt(category, isFemale);
        log.debug(`   [CLOTHING] Style for ${category}: "${clothingStylePrompt}"`);
        let avatarPrompt = fillTemplate(promptPart, {
          'CLOTHING_STYLE': clothingStylePrompt
        });
        if (physicalTraitsSection) {
          avatarPrompt += physicalTraitsSection;
        }

        const requestBody = {
          systemInstruction: {
            parts: [{
              text: PROMPT_TEMPLATES.avatarSystemInstruction
            }]
          },
          contents: [{
            parts: [
              {
                inline_data: {
                  mime_type: mimeType,
                  data: base64Data
                }
              },
              { text: avatarPrompt }
            ]
          }],
          generationConfig: {
            temperature: 0.3,
            responseModalities: ["TEXT", "IMAGE"],
            imageConfig: {
              aspectRatio: "9:16"
            }
          },
          safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" }
          ]
        };

        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${geminiApiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
          }
        );

        if (!response.ok) {
          const errorText = await response.text();
          log.error(`❌ [CLOTHING AVATARS] ${category} generation failed:`, errorText);
          return { category, prompt: avatarPrompt, imageData: null };
        }

        let data = await response.json();

        // Log token usage
        const avatarModelId = 'gemini-2.5-flash-image';
        const avatarInputTokens = data.usageMetadata?.promptTokenCount || 0;
        const avatarOutputTokens = data.usageMetadata?.candidatesTokenCount || 0;
        if (avatarInputTokens > 0 || avatarOutputTokens > 0) {
          console.log(`📊 [AVATAR GENERATION] ${category} - model: ${avatarModelId}, input: ${avatarInputTokens.toLocaleString()}, output: ${avatarOutputTokens.toLocaleString()}`);
        }

        // Check if blocked by safety filters - retry with simplified prompt
        if (data.promptFeedback?.blockReason) {
          log.warn(`[CLOTHING AVATARS] ${category} blocked by safety filters:`, data.promptFeedback.blockReason);
          log.debug(`🔄 [CLOTHING AVATARS] Retrying ${category} with simplified prompt...`);

          const outfitDescription = category === 'winter' ? 'a winter coat' : category === 'summer' ? 'a casual T-shirt and shorts' : category === 'formal' ? 'formal attire' : 'casual clothes';
          const retryPrompt = fillTemplate(PROMPT_TEMPLATES.avatarRetryPrompt, {
            '{OUTFIT_DESCRIPTION}': outfitDescription
          });

          const retryRequestBody = {
            ...requestBody,
            contents: [{
              parts: [
                requestBody.contents[0].parts[0],
                { text: retryPrompt }
              ]
            }]
          };

          const retryResponse = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${geminiApiKey}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(retryRequestBody)
            }
          );

          if (retryResponse.ok) {
            data = await retryResponse.json();
            const retryInputTokens = data.usageMetadata?.promptTokenCount || 0;
            const retryOutputTokens = data.usageMetadata?.candidatesTokenCount || 0;
            if (retryInputTokens > 0 || retryOutputTokens > 0) {
              console.log(`📊 [AVATAR GENERATION] ${category} retry - model: ${avatarModelId}, input: ${retryInputTokens.toLocaleString()}, output: ${retryOutputTokens.toLocaleString()}`);
            }
            if (data.promptFeedback?.blockReason) {
              log.warn(`[CLOTHING AVATARS] ${category} retry also blocked:`, data.promptFeedback.blockReason);
              return { category, prompt: avatarPrompt, imageData: null };
            }
          } else {
            log.error(`❌ [CLOTHING AVATARS] ${category} retry failed`);
            return { category, prompt: avatarPrompt, imageData: null };
          }
        }

        // Extract image from response
        let imageData = null;
        if (data.candidates && data.candidates[0]?.content?.parts) {
          for (const part of data.candidates[0].content.parts) {
            if (part.inlineData) {
              imageData = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
              break;
            }
          }
        }

        if (imageData) {
          // Compress avatar to JPEG
          try {
            const originalSize = Math.round(imageData.length / 1024);
            const compressedImage = await compressImageToJPEG(imageData);
            const compressedSize = Math.round(compressedImage.length / 1024);
            log.debug(`✅ [CLOTHING AVATARS] ${category} avatar generated and compressed (${originalSize}KB -> ${compressedSize}KB)`);
            return { category, prompt: avatarPrompt, imageData: compressedImage };
          } catch (compressErr) {
            log.warn(`[CLOTHING AVATARS] Compression failed for ${category}, using original:`, compressErr.message);
            return { category, prompt: avatarPrompt, imageData };
          }
        } else {
          log.warn(`[CLOTHING AVATARS] No image in ${category} response`);
          return { category, prompt: avatarPrompt, imageData: null };
        }
      } catch (err) {
        log.error(`❌ [CLOTHING AVATARS] Error generating ${category}:`, err.message);
        return { category, prompt: null, imageData: null };
      }
    };

    // PHASE 1: Generate all clothing avatars in parallel (winter, standard, summer)
    const categoryCount = Object.keys(clothingCategories).length;
    log.debug(`🚀 [CLOTHING AVATARS] Generating ${categoryCount} avatars for ${name} in parallel...`);
    const generationStart = Date.now();
    const generationPromises = Object.entries(clothingCategories).map(
      ([category, config]) => generateSingleAvatar(category, config)
    );
    const generatedAvatars = await Promise.all(generationPromises);
    const generationTime = Date.now() - generationStart;
    log.debug(`⚡ [CLOTHING AVATARS] ${categoryCount} avatars generated in ${generationTime}ms (parallel)`);

    // Store prompts and images
    for (const { category, prompt, imageData } of generatedAvatars) {
      if (prompt) results.prompts[category] = prompt;
      if (imageData) results[category] = imageData;
    }

    // PHASE 2: Evaluate all generated avatars in parallel
    const avatarsToEvaluate = generatedAvatars.filter(a => a.imageData);
    if (avatarsToEvaluate.length > 0) {
      log.debug(`🔍 [CLOTHING AVATARS] Starting PARALLEL evaluation of ${avatarsToEvaluate.length} avatars...`);
      const evalStart = Date.now();
      const evalPromises = avatarsToEvaluate.map(async ({ category, imageData }) => {
        const faceMatchResult = await evaluateAvatarFaceMatch(facePhoto, imageData, geminiApiKey);
        return { category, faceMatchResult };
      });
      const evalResults = await Promise.all(evalPromises);
      const evalTime = Date.now() - evalStart;
      log.debug(`⚡ [CLOTHING AVATARS] All evaluations completed in ${evalTime}ms (parallel)`);

      // Store evaluation results
      for (const { category, faceMatchResult } of evalResults) {
        if (faceMatchResult) {
          results.faceMatch[category] = { score: faceMatchResult.score, details: faceMatchResult.details };

          // Store full raw evaluation for dev mode (only from first result)
          if (faceMatchResult.raw && !results.rawEvaluation) {
            results.rawEvaluation = faceMatchResult.raw;
          }

          // Store extracted physical traits (from reference photo)
          if (faceMatchResult.physicalTraits && !results.extractedTraits) {
            results.extractedTraits = faceMatchResult.physicalTraits;
            log.debug(`📋 [AVATAR EVAL] Extracted traits: age=${faceMatchResult.physicalTraits.age}, gender=${faceMatchResult.physicalTraits.gender}, build=${faceMatchResult.physicalTraits.build}`);
          }

          // Store structured clothing (from generated avatar)
          if (faceMatchResult.clothing) {
            // Check if it's structured (object) or legacy (string)
            if (typeof faceMatchResult.clothing === 'object') {
              results.structuredClothing[category] = faceMatchResult.clothing;
              // Also create legacy text version for backwards compatibility
              const clothingParts = [];
              if (faceMatchResult.clothing.fullBody) {
                clothingParts.push(faceMatchResult.clothing.fullBody);
              } else {
                if (faceMatchResult.clothing.upperBody) clothingParts.push(faceMatchResult.clothing.upperBody);
                if (faceMatchResult.clothing.lowerBody) clothingParts.push(faceMatchResult.clothing.lowerBody);
              }
              if (faceMatchResult.clothing.shoes) clothingParts.push(faceMatchResult.clothing.shoes);
              results.clothing[category] = clothingParts.join(', ');
              log.debug(`👕 [AVATAR EVAL] ${category} structured clothing: ${JSON.stringify(faceMatchResult.clothing)}`);
            } else {
              // Legacy string format
              results.clothing[category] = faceMatchResult.clothing;
              log.debug(`👕 [AVATAR EVAL] ${category} clothing: ${faceMatchResult.clothing}`);
            }
          }

          log.debug(`🔍 [AVATAR EVAL] ${category} score: ${faceMatchResult.score}/10`);
        }
      }
    }

    log.debug(`✅ [CLOTHING AVATARS] Total time: ${Date.now() - generationStart}ms`)

    // Check if standard avatar was generated
    if (!results.standard) {
      return res.status(500).json({ error: 'Failed to generate avatar' });
    }

    results.status = 'complete';
    results.generatedAt = new Date().toISOString();

    log.debug(`✅ [CLOTHING AVATARS] Generated standard avatar for ${name}`);
    res.json({ success: true, clothingAvatars: results });

  } catch (err) {
    log.error('Error generating clothing avatars:', err);
    res.status(500).json({ error: 'Failed to generate clothing avatars', details: err.message });
  }
});

module.exports = router;
module.exports.generateDynamicAvatar = generateDynamicAvatar;
module.exports.generateStyledCostumedAvatar = generateStyledCostumedAvatar;
module.exports.getCostumedAvatarGenerationLog = getCostumedAvatarGenerationLog;
module.exports.clearCostumedAvatarGenerationLog = clearCostumedAvatarGenerationLog;
