/**
 * Story Avatar Generation Helper
 *
 * This module contains avatar generation logic that was previously embedded in server.js.
 *
 * IMPORTANT: These functions should NOT be called during normal story processing.
 * Base avatars (standard/winter/summer) should already exist from character creation.
 *
 * Use cases for this module:
 * - Manual avatar regeneration
 * - Edge case recovery
 * - Testing/debugging
 *
 * For normal story flow, use prepareStyledAvatars() which only CONVERTS existing avatars.
 */

const { log } = require('../utils/logger');
const { setStyledAvatar, invalidateStyledAvatarForCategory } = require('./styledAvatars');

/**
 * Generate avatars for story characters based on clothing requirements.
 *
 * NOTE: This should NOT be needed during normal story processing.
 * Avatars should already exist before a story starts.
 *
 * @param {Array} characters - Array of character objects
 * @param {Object} clothingRequirements - Requirements from outline parsing
 * @param {string} artStyle - Target art style (pixar, oil, anime, etc.)
 * @param {Function} addUsage - Usage tracking callback
 * @param {Object} options - Additional options
 * @returns {Object} - { generated: [], failed: [], tokenUsage: {} }
 */
async function generateStoryAvatars(characters, clothingRequirements, artStyle, addUsage, options = {}) {
  const { generateCharacter2x4Sheet } = require('./character2x4Sheet');
  const { persistStyledAvatar } = require('../services/database');
  const userId = options.userId || null;

  const generated = [];
  const failed = [];
  const promises = [];

  if (!clothingRequirements || Object.keys(clothingRequirements).length === 0) {
    log.debug('[AVATAR-GEN] No clothing requirements, skipping avatar generation');
    return { generated, failed };
  }

  log.debug(`[AVATAR-GEN] Processing clothing requirements for ${Object.keys(clothingRequirements).length} characters`);

  for (const [charName, requirements] of Object.entries(clothingRequirements)) {
    const char = characters.find(c =>
      c.name.trim().toLowerCase() === charName.trim().toLowerCase() ||
      c.name.trim().toLowerCase().includes(charName.trim().toLowerCase()) ||
      charName.trim().toLowerCase().includes(c.name.trim().toLowerCase())
    );

    if (!char) {
      log.debug(`[AVATAR-GEN] Character "${charName}" not found, skipping`);
      continue;
    }

    // Ensure avatars structure exists
    if (!char.avatars) char.avatars = {};
    if (!char.avatars.styledAvatars) char.avatars.styledAvatars = {};
    if (!char.avatars.clothing) char.avatars.clothing = {};
    if (!char.avatars.signatures) char.avatars.signatures = {};

    for (const [category, config] of Object.entries(requirements)) {
      if (!config || !config.used) continue;

      // Initialize style structure
      if (!char.avatars.styledAvatars[artStyle]) char.avatars.styledAvatars[artStyle] = {};
      if (category === 'costumed') {
        if (!char.avatars.styledAvatars[artStyle].costumed) char.avatars.styledAvatars[artStyle].costumed = {};
      }

      const logCategory = config.costume ? `costumed:${config.costume}` : category;
      log.debug(`[AVATAR-GEN] Generating ${logCategory}${config.signature ? '+sig' : ''} avatar for ${char.name}...`);

      const avatarPromise = (async () => {
        try {
          let result;
          let isCostumed = false;

          if (category === 'costumed' && config.costume) {
            // Costumed: generate the 2×4 reference sheet (the styled avatar IS the
            // 2×4 — phantom + standard avatar + face → Grok edit). No more Gemini
            // styled-2×2 step; the costume description carries everything Grok
            // needs to render the bottom-row body cells correctly.
            isCostumed = true;
            const costumeKey = String(config.costume).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
            const costumeDescription = config.description || config.costume || 'costume';
            try {
              const sheet = await generateCharacter2x4Sheet(char, {
                clothingCategory: `costumed:${costumeKey}`,
                costumeDescription,
                artStyle,
                usageTracker: addUsage,
              });
              if (sheet?.imageData) {
                char.avatars.styledAvatars[artStyle].costumed[costumeKey] = sheet.imageData;
                setStyledAvatar(char.name, `costumed:${costumeKey}`, artStyle, sheet.imageData);
                if (!char.avatars.clothing.costumed) char.avatars.clothing.costumed = {};
                char.avatars.clothing.costumed[costumeKey] = costumeDescription;
                // Persist immediately to both data + metadata columns (and R2)
                // so subsequent stories on this account reuse the sheet and
                // the UI tile picks it up. Mirrors what buildCompositeCast's
                // lazy-gen path does.
                if (userId && char.id) {
                  try {
                    await persistStyledAvatar(userId, char.id, artStyle, `costumed:${costumeKey}`, sheet.imageData);
                  } catch (persistErr) {
                    log.warn(`[AVATAR-GEN] persistStyledAvatar failed for ${char.name}/${costumeKey}: ${persistErr.message}`);
                  }
                }
                result = { success: true, imageData: sheet.imageData };
                generated.push(`${char.name}:${logCategory}@${artStyle}`);
                log.debug(`[AVATAR-GEN] ✅ Generated 2×4 costumed:${costumeKey}@${artStyle} for ${char.name}`);
              } else {
                failed.push(`${char.name}:${logCategory}`);
                result = { success: false };
              }
            } catch (err) {
              log.warn(`[AVATAR-GEN] 2×4 costumed:${costumeKey}@${artStyle} for ${char.name} failed: ${err.message}`);
              failed.push(`${char.name}:${logCategory}`);
              result = { success: false };
            }
          } else if (config.signature) {
            // Signature: 2×4 sheet via the unified path. Base clothing + signature
            // items fold into one costume description; generateCharacter2x4Sheet
            // produces the same 2×4 (Pass 1 realistic + Pass 2 styled) as the
            // costumed path, just keyed under standard/winter/summer instead of
            // styledAvatars[artStyle].costumed.<key>. Downstream cell-crop logic
            // (sceneComposite.sceneCellRefForCharacter, iteratePageCore's
            // cropAvatarCell) handles per-page depth-aware cell selection so the
            // page generator receives 1 cell (background/midground) or 2 cells
            // (foreground close-up) — never the full 8-cell sheet.
            const baseClothing = char.avatars?.clothing?.[category]
              || (typeof config.description === 'string' ? config.description : '')
              || `${category} outfit`;
            const signatureSuffix = config.signature && String(config.signature).toLowerCase() !== 'none'
              ? `, plus this signature element: ${config.signature}`
              : '';
            const combinedCostume = `${baseClothing}${signatureSuffix}`;
            try {
              const sheet = await generateCharacter2x4Sheet(char, {
                clothingCategory: category,
                costumeDescription: combinedCostume,
                artStyle,
                usageTracker: addUsage,
              });
              if (sheet?.imageData) {
                char.avatars.styledAvatars[artStyle][category] = sheet.imageData;
                setStyledAvatar(char.name, category, artStyle, sheet.imageData);
                char.avatars.clothing[category] = combinedCostume;
                if (config.signature) {
                  char.avatars.signatures[category] = config.signature;
                }
                if (userId && char.id) {
                  try {
                    await persistStyledAvatar(userId, char.id, artStyle, category, sheet.imageData);
                  } catch (persistErr) {
                    log.warn(`[AVATAR-GEN] persistStyledAvatar failed for ${char.name}/${category}: ${persistErr.message}`);
                  }
                }
                result = { success: true, imageData: sheet.imageData };
                generated.push(`${char.name}:${logCategory}+sig@${artStyle}`);
                log.debug(`[AVATAR-GEN] ✅ Generated 2×4 ${category}+sig@${artStyle} for ${char.name}`);
              } else {
                failed.push(`${char.name}:${logCategory}`);
                result = { success: false };
              }
            } catch (err) {
              log.warn(`[AVATAR-GEN] 2×4 ${category}+sig@${artStyle} for ${char.name} failed: ${err.message}`);
              failed.push(`${char.name}:${logCategory}`);
              result = { success: false };
            }
          } else {
            // Standard/winter/summer with no signature: still produce a 2×4 sheet
            // so every story avatar shares one storage shape and the cell-crop
            // readers (sceneComposite, iteratePageCore) work uniformly. The base
            // single-image generator (generateDynamicAvatar) is now reserved for
            // character-creation routes only — story-prep ALWAYS goes 2×4.
            log.warn(`[AVATAR-GEN] ⚠️ FALLBACK: ${char.name} missing ${category} styled sheet, generating one now`);
            const baseClothing = char.avatars?.clothing?.[category]
              || (typeof config.description === 'string' ? config.description : '')
              || `${category} outfit`;
            try {
              const sheet = await generateCharacter2x4Sheet(char, {
                clothingCategory: category,
                costumeDescription: baseClothing,
                artStyle,
                usageTracker: addUsage,
              });
              if (sheet?.imageData) {
                char.avatars.styledAvatars[artStyle][category] = sheet.imageData;
                setStyledAvatar(char.name, category, artStyle, sheet.imageData);
                char.avatars.clothing[category] = baseClothing;
                if (userId && char.id) {
                  try {
                    await persistStyledAvatar(userId, char.id, artStyle, category, sheet.imageData);
                  } catch (persistErr) {
                    log.warn(`[AVATAR-GEN] persistStyledAvatar failed for ${char.name}/${category}: ${persistErr.message}`);
                  }
                }
                result = { success: true, imageData: sheet.imageData };
                generated.push(`${char.name}:${logCategory}@${artStyle}`);
                log.warn(`[AVATAR-GEN] ⚠️ FALLBACK: Generated 2×4 ${category}@${artStyle} for ${char.name}`);
              } else {
                failed.push(`${char.name}:${logCategory}`);
                result = { success: false };
              }
            } catch (err) {
              log.warn(`[AVATAR-GEN] FALLBACK 2×4 ${category}@${artStyle} for ${char.name} failed: ${err.message}`);
              failed.push(`${char.name}:${logCategory}`);
              result = { success: false };
            }
          }

          // Track token usage
          if (result?.tokenUsage?.byModel && addUsage) {
            for (const [modelId, usage] of Object.entries(result.tokenUsage.byModel)) {
              const functionName = isCostumed ? 'avatar_costumed' : 'avatar_styled';
              addUsage('gemini_image', {
                input_tokens: usage.input_tokens || 0,
                output_tokens: usage.output_tokens || 0
              }, functionName, modelId);
            }
          }

          return { tokenUsage: result?.tokenUsage, isCostumed };
        } catch (err) {
          log.error(`[AVATAR-GEN] ❌ Failed to generate ${logCategory} for ${char.name}:`, err.message);
          failed.push(`${char.name}:${logCategory}`);
          return { tokenUsage: null, isCostumed: false };
        }
      })();

      promises.push(avatarPromise);
    }
  }

  if (promises.length > 0) {
    log.debug(`[AVATAR-GEN] Waiting for ${promises.length} avatar generations...`);
    await Promise.all(promises);
    log.debug(`[AVATAR-GEN] ✅ All avatar generations complete`);
  }

  if (generated.length > 0) {
    log.debug(`[AVATAR-GEN] Generated ${generated.length} avatars: ${generated.join(', ')}`);
  }
  if (failed.length > 0) {
    log.warn(`[AVATAR-GEN] ⚠️ Failed ${failed.length} avatars: ${failed.join(', ')}`);
  }

  return { generated, failed };
}

/**
 * Validate that characters have required avatars for a story.
 *
 * @param {Array} characters - Array of character objects
 * @param {Object} clothingRequirements - Requirements from outline parsing
 * @returns {Array} - Array of missing avatar descriptions
 */
function validateCharacterAvatars(characters, clothingRequirements) {
  const missing = [];

  if (!clothingRequirements) return missing;

  for (const [charName, requirements] of Object.entries(clothingRequirements)) {
    const char = characters.find(c =>
      c.name.trim().toLowerCase() === charName.trim().toLowerCase()
    );

    if (!char) continue;

    for (const [category, config] of Object.entries(requirements)) {
      if (!config || !config.used) continue;

      // Check if base avatar exists for standard categories
      if (['standard', 'winter', 'summer'].includes(category)) {
        if (!char.avatars?.[category] && !char.avatars?.standard) {
          missing.push({ name: char.name, category, reason: 'No base avatar' });
        }
      }
      // Note: costumed/signature avatars are story-specific and may need generation
    }
  }

  return missing;
}

module.exports = {
  generateStoryAvatars,
  validateCharacterAvatars
};
