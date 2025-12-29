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
        if (result.traits) {
          log.debug('📸 [GEMINI] Extracted traits:', result.traits);
          return result;
        } else {
          log.debug('📸 [GEMINI] Extracted traits (flat format):', result);
          return { traits: result };
        }
      } else {
        log.error('📸 [GEMINI] No JSON found in response:', text.substring(0, 200));
      }
    } else {
      log.error('📸 [GEMINI] Unexpected response structure:', JSON.stringify(data).substring(0, 200));
    }
    return null;
  } catch (err) {
    log.error('📸 [GEMINI] Trait extraction error:', err.message);
    return null;
  }
}

/**
 * Evaluate face match between original photo and generated avatar
 * Returns { score: 1-10, details: string, clothing: string|null } or null on error
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
        signal: AbortSignal.timeout(20000)
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

    log.debug(`🔍 [AVATAR EVAL] Raw response: ${responseText.substring(0, 200)}${responseText.length > 200 ? '...' : ''}`);

    // Parse JSON response
    try {
      const evalResult = JSON.parse(responseText);
      const score = evalResult.finalScore;
      const clothing = evalResult.clothing || null;
      if (typeof score === 'number' && score >= 1 && score <= 10) {
        const details = [
          `Face Shape: ${evalResult.faceShape?.score}/10 - ${evalResult.faceShape?.reason}`,
          `Eyes: ${evalResult.eyes?.score}/10 - ${evalResult.eyes?.reason}`,
          `Nose: ${evalResult.nose?.score}/10 - ${evalResult.nose?.reason}`,
          `Mouth: ${evalResult.mouth?.score}/10 - ${evalResult.mouth?.reason}`,
          `Overall: ${evalResult.overallStructure?.score}/10 - ${evalResult.overallStructure?.reason}`,
          `Final Score: ${score}/10`
        ].join('\n');
        log.debug(`🔍 [AVATAR EVAL] Score: ${score}/10${clothing ? `, Clothing: ${clothing}` : ''}`);
        return { score, details, clothing, raw: evalResult };
      }
    } catch (parseErr) {
      log.warn(`[AVATAR EVAL] JSON parse failed, trying text fallback: ${parseErr.message}`);
      const scoreMatch = responseText.match(/finalScore["']?\s*:\s*(\d+)/i);
      if (scoreMatch) {
        const score = parseInt(scoreMatch[1], 10);
        return { score, details: responseText, clothing: null };
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

// ============================================================================
// ROUTES
// ============================================================================

/**
 * POST /api/analyze-photo
 * Analyze a photo to extract face and physical traits
 */
router.post('/analyze-photo', authenticateToken, async (req, res) => {
  try {
    const { imageData, language } = req.body;

    if (!imageData) {
      log.debug('📸 [PHOTO] Missing imageData in request');
      return res.status(400).json({ error: 'Missing imageData' });
    }

    // Build language instruction for trait extraction
    let languageInstruction = '';
    if (language === 'de') {
      languageInstruction = 'WICHTIG: Beschreibe alle Merkmale (face, hair, build, distinctive markings) auf Deutsch. Beispiel: "rundes Gesicht mit weichen Wangen", "lange, braune Haare im Pferdeschwanz", "schlank", "Brille".';
    } else if (language === 'fr') {
      languageInstruction = 'IMPORTANT: Décrivez tous les traits (face, hair, build, distinctive markings) en français. Exemple: "visage rond avec joues douces", "longs cheveux bruns en queue de cheval", "mince", "lunettes".';
    }

    const imageSize = imageData.length;
    const imageType = imageData.substring(0, 30);
    log.debug(`📸 [PHOTO] Received image: ${imageSize} bytes, type: ${imageType}...`);

    const photoAnalyzerUrl = process.env.PHOTO_ANALYZER_URL || 'http://127.0.0.1:5000';
    log.debug(`📸 [PHOTO] Calling Python service at: ${photoAnalyzerUrl}/analyze`);
    log.debug(`📸 [PHOTO] Calling Gemini for visual trait extraction...`);

    const startTime = Date.now();

    // Helper function for Python analysis
    const analyzePython = async () => {
      const analyzerResponse = await fetch(`${photoAnalyzerUrl}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: imageData }),
        signal: AbortSignal.timeout(30000)
      });
      return analyzerResponse.json();
    };

    try {
      // Run both in parallel
      const [analyzerData, geminiTraits] = await Promise.all([
        analyzePython(),
        extractTraitsWithGemini(imageData, languageInstruction)
      ]);

      const duration = Date.now() - startTime;

      log.debug(`📸 [PHOTO] Analysis complete in ${duration}ms:`, {
        pythonSuccess: analyzerData.success,
        hasError: !!analyzerData.error,
        error: analyzerData.error || null,
        hasFaceThumbnail: !!analyzerData.faceThumbnail || !!analyzerData.face_thumbnail,
        hasBodyCrop: !!analyzerData.bodyCrop || !!analyzerData.body_crop,
        hasBodyNoBg: !!analyzerData.bodyNoBg || !!analyzerData.body_no_bg,
        hasFaceBox: !!analyzerData.faceBox || !!analyzerData.face_box,
        hasBodyBox: !!analyzerData.bodyBox || !!analyzerData.body_box,
        pythonAttributes: analyzerData.attributes || null,
        geminiTraits: geminiTraits || null,
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

      // Merge Gemini traits into attributes
      const traits = geminiTraits?.traits || geminiTraits;

      if (traits) {
        analyzerData.attributes = analyzerData.attributes || {};
        if (traits.age && !analyzerData.attributes.age) {
          analyzerData.attributes.age = String(traits.age);
        }
        // Store apparent age category from visual analysis
        if (traits.apparentAge) {
          analyzerData.attributes.apparent_age = traits.apparentAge;
          log.debug(`📸 [GEMINI] Apparent age from analysis: ${traits.apparentAge}`);
        }
        if (traits.gender && !analyzerData.attributes.gender) {
          analyzerData.attributes.gender = traits.gender.toLowerCase();
        }
        if (traits.height && !analyzerData.attributes.height) {
          analyzerData.attributes.height = traits.height;
        }
        if (traits.build && !analyzerData.attributes.build) {
          analyzerData.attributes.build = traits.build;
        }
        if (traits.face) {
          analyzerData.attributes.face = traits.face;
        }
        // New separated eye and hair fields
        if (traits.eyeColor) {
          analyzerData.attributes.eye_color = traits.eyeColor;
        }
        if (traits.hairColor) {
          analyzerData.attributes.hair_color = traits.hairColor;
        }
        if (traits.hairLength) {
          analyzerData.attributes.hair_length = traits.hairLength;
        }
        if (traits.hairStyle) {
          analyzerData.attributes.hair_style = traits.hairStyle;
        }
        // Legacy: combined hair field (fallback for old code)
        if (traits.hair && !traits.hairColor) {
          analyzerData.attributes.hair_color = traits.hair;
        }
        const distinctiveMarkings = traits["distinctive markings"] || traits.distinctiveMarkings || traits.other;
        if (distinctiveMarkings && distinctiveMarkings !== 'none') {
          analyzerData.attributes.other_features = distinctiveMarkings;
        }
      }

      await logActivity(req.user.id, req.user.username, 'PHOTO_ANALYZED', {
        age: analyzerData.attributes?.age,
        gender: analyzerData.attributes?.gender,
        hasFace: !!analyzerData.face_thumbnail || !!analyzerData.faceThumbnail,
        hasBody: !!analyzerData.body_crop || !!analyzerData.bodyCrop,
        hasGeminiTraits: !!geminiTraits
      });

      // Convert snake_case to camelCase for frontend compatibility
      const response = {
        success: analyzerData.success,
        faceThumbnail: analyzerData.face_thumbnail || analyzerData.faceThumbnail,
        bodyCrop: analyzerData.body_crop || analyzerData.bodyCrop,
        bodyNoBg: analyzerData.body_no_bg || analyzerData.bodyNoBg,
        faceBox: analyzerData.face_box || analyzerData.faceBox,
        bodyBox: analyzerData.body_box || analyzerData.bodyBox,
        attributes: analyzerData.attributes
      };

      log.debug('📸 [PHOTO] Sending response:', {
        hasAttributes: !!analyzerData.attributes,
        clothing: analyzerData.attributes?.clothing
      });
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

    // Build physical traits section if provided
    let physicalTraitsSection = '';
    if (physicalTraits || build || apparentAge || age) {
      const traitParts = [];
      // Add apparent age first (most important for body generation)
      if (apparentAge) {
        traitParts.push(`Apparent age: ${apparentAge}`);
      } else if (age) {
        traitParts.push(`Age: ${age} years old`);
      }
      if (build) traitParts.push(`Build: ${build}`);
      else if (physicalTraits?.build) traitParts.push(`Build: ${physicalTraits.build}`);
      // Use new separated hair fields if available, otherwise fall back to combined 'hair' field
      if (physicalTraits?.hairColor) traitParts.push(`Hair color: ${physicalTraits.hairColor}`);
      if (physicalTraits?.hairLength) traitParts.push(`Hair length: ${physicalTraits.hairLength}`);
      if (physicalTraits?.hairStyle) traitParts.push(`Hair style: ${physicalTraits.hairStyle}`);
      if (!physicalTraits?.hairColor && !physicalTraits?.hairLength && !physicalTraits?.hairStyle && physicalTraits?.hair) {
        traitParts.push(`Hair: ${physicalTraits.hair}`);
      }
      if (physicalTraits?.eyeColor) traitParts.push(`Eye color: ${physicalTraits.eyeColor}`);
      if (physicalTraits?.face) traitParts.push(`Face: ${physicalTraits.face}`);
      if (physicalTraits?.other) traitParts.push(`Distinctive features: ${physicalTraits.other}`);
      if (traitParts.length > 0) {
        physicalTraitsSection = `\n\nPHYSICAL CHARACTERISTICS (MUST INCLUDE):\n${traitParts.join('\n')}`;
      }
      log.debug(`👔 [CLOTHING AVATARS] Including physical traits: ${traitParts.join(', ')}`);
    }

    log.debug(`👔 [CLOTHING AVATARS] Starting generation for ${name} (id: ${characterId})${physicalTraits ? ' WITH TRAITS' : ''}`);

    const isFemale = gender === 'female';

    // Define clothing categories
    const clothingCategories = {
      winter: { emoji: '❄️' },
      standard: { emoji: '👕' },
      summer: { emoji: '☀️' },
      formal: { emoji: '👔' }
    };

    const results = {
      status: 'generating',
      generatedAt: null,
      faceMatch: {},
      clothing: {},
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

    // PHASE 1: Generate all 4 avatars in parallel
    log.debug(`🚀 [CLOTHING AVATARS] Starting PARALLEL generation of 4 avatars for ${name}...`);
    const generationStart = Date.now();
    const generationPromises = Object.entries(clothingCategories).map(
      ([category, config]) => generateSingleAvatar(category, config)
    );
    const generatedAvatars = await Promise.all(generationPromises);
    const generationTime = Date.now() - generationStart;
    log.debug(`⚡ [CLOTHING AVATARS] All 4 avatars generated in ${generationTime}ms (parallel)`);

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
          if (faceMatchResult.clothing) {
            results.clothing[category] = faceMatchResult.clothing;
            log.debug(`👕 [AVATAR EVAL] ${category} clothing: ${faceMatchResult.clothing}`);
          }
          log.debug(`🔍 [AVATAR EVAL] ${category} score: ${faceMatchResult.score}/10`);
        }
      }
    }

    log.debug(`✅ [CLOTHING AVATARS] Total time: ${Date.now() - generationStart}ms (was ~25s sequential)`)

    // Check if at least one avatar was generated
    const generatedCount = ['winter', 'standard', 'summer', 'formal'].filter(c => results[c]).length;
    if (generatedCount === 0) {
      return res.status(500).json({ error: 'Failed to generate any avatars' });
    }

    results.status = 'complete';
    results.generatedAt = new Date().toISOString();

    log.debug(`✅ [CLOTHING AVATARS] Generated ${generatedCount}/4 avatars for ${name}`);
    res.json({ success: true, clothingAvatars: results });

  } catch (err) {
    log.error('Error generating clothing avatars:', err);
    res.status(500).json({ error: 'Failed to generate clothing avatars', details: err.message });
  }
});

module.exports = router;
