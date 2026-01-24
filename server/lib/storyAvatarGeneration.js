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

const log = require('./logger').forModule('avatar-gen');
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
  const {
    generateDynamicAvatar,
    generateStyledCostumedAvatar,
    generateStyledAvatarWithSignature
  } = require('../routes/avatars');

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
            // Costumed: generate styled version directly (costume + art style in one call)
            result = await generateStyledCostumedAvatar(char, config, artStyle);
            isCostumed = true;

            if (result.success && result.imageData) {
              const costumeKey = result.costumeType;
              char.avatars.styledAvatars[artStyle].costumed[costumeKey] = result.imageData;
              setStyledAvatar(char.name, `costumed:${costumeKey}`, artStyle, result.imageData);
              if (!char.avatars.clothing.costumed) char.avatars.clothing.costumed = {};
              if (result.clothing) {
                char.avatars.clothing.costumed[costumeKey] = result.clothing;
              }
              generated.push(`${char.name}:${logCategory}@${artStyle}`);
              log.debug(`[AVATAR-GEN] ✅ Generated styled costumed:${costumeKey}@${artStyle} for ${char.name}`);
            } else {
              failed.push(`${char.name}:${logCategory}`);
            }
          } else if (config.signature) {
            // Signature: generate styled avatar directly (1 API call)
            result = await generateStyledAvatarWithSignature(char, category, config, artStyle);

            if (result.success && result.imageData) {
              char.avatars.styledAvatars[artStyle][category] = result.imageData;
              setStyledAvatar(char.name, category, artStyle, result.imageData);
              if (result.clothing) {
                char.avatars.clothing[category] = result.clothing;
              }
              if (result.signature) {
                char.avatars.signatures[category] = result.signature;
              }
              generated.push(`${char.name}:${logCategory}+sig@${artStyle}`);
              log.debug(`[AVATAR-GEN] ✅ Generated styled ${category}+sig@${artStyle} for ${char.name}`);
            } else {
              failed.push(`${char.name}:${logCategory}`);
            }
          } else {
            // Standard/winter/summer: generate base avatar (should rarely happen)
            log.warn(`[AVATAR-GEN] ⚠️ FALLBACK: ${char.name} missing ${category} avatar - this shouldn't normally happen`);
            result = await generateDynamicAvatar(char, category, config);

            if (result.success && result.imageData) {
              char.avatars[category] = result.imageData;
              invalidateStyledAvatarForCategory(char.name, category, char);
              if (result.clothing) {
                char.avatars.clothing[category] = result.clothing;
              }
              generated.push(`${char.name}:${logCategory}`);
              log.warn(`[AVATAR-GEN] ⚠️ FALLBACK: Generated ${category} for ${char.name}`);
            } else {
              failed.push(`${char.name}:${logCategory}`);
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
