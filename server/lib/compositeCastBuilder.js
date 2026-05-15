/**
 * Build the composite-cast array for one page.
 *
 * For each named character in the scene:
 *   1. Locate (or lazy-generate) the styled 2×4 reference sheet for the
 *      art-style + clothing combination needed on this page.
 *   2. Pull pose + flip from the scene metadata.
 *   3. Pull the action phrase from interactions[] (essential > normal > low).
 *   4. Emit a cast entry: { name, sheetBuf, pose, flip, action, position, sizeHint }.
 *
 * Returns the cast array, or null when any cast character can't be resolved.
 * The caller (composite gate or per-page rerun endpoint) treats null as
 * "fall through to the direct path."
 *
 * Extracted from server.js so the per-page rerun endpoint can build the
 * same cast shape that the unified pipeline uses.
 *
 * @param {Object} pageData - the page payload (scene, metadata, clothing, etc.).
 * @param {Object} inputData - story-job input (characters, artStyle, clothingRequirements).
 * @param {Object} deps - injected dependencies that vary per call site.
 * @param {string} deps.userId - story owner's user id (for persistStyledAvatar).
 * @param {Function} deps.addUsage - usage-tracking callback (provider, usage, label, modelId).
 * @param {Object} deps.log - logger.
 * @returns {Promise<Array<Object>|null>}
 */
'use strict';

const { generateCharacter2x4Sheet } = require('./character2x4Sheet');
const { persistStyledAvatar } = require('../services/database');

async function buildCompositeCast(pageData, inputData, deps = {}) {
  const { userId, addUsage, log, storyCharacterAvatars = null } = deps;
  if (!log) throw new Error('buildCompositeCast: deps.log is required');

  const metaChars = pageData.sceneMetadata?.fullData?.characters
    || pageData.sceneMetadata?.characters
    || pageData.sceneCharacters
    || [];
  const sceneChars = Array.isArray(metaChars) ? metaChars : [];
  if (!sceneChars.length) return null;

  // Action lookup from interactions[] — essential > normal > low.
  const interactionsList = pageData.sceneMetadata?.fullData?.interactions
    || pageData.sceneMetadata?.interactions
    || pageData.scene?.interactions
    || [];
  const actionsByChar = new Map();
  if (Array.isArray(interactionsList)) {
    const prio = { essential: 0, normal: 1, low: 2 };
    const sorted = [...interactionsList].sort((a, b) =>
      (prio[a.priority] ?? 1) - (prio[b.priority] ?? 1));
    for (const it of sorted) {
      if (!it?.character || !it?.where) continue;
      const key = String(it.character).toLowerCase();
      if (!actionsByChar.has(key)) actionsByChar.set(key, it.where);
    }
  }

  const artStyleKey = inputData.artStyle || 'watercolor';
  const out = [];
  for (const sc of sceneChars) {
    const name = typeof sc === 'string' ? sc : (sc.name || '');
    if (!name) continue;
    const character = (inputData.characters || []).find(c => (c.name || '').toLowerCase() === String(name).toLowerCase());
    if (!character) return null;
    const clothing = (pageData.perCharClothing?.[name] || sc.clothing || 'standard').toLowerCase();
    const costumeKey = clothing.startsWith('costumed:')
      ? clothing.slice('costumed:'.length).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
      : null;

    // Step 1: try the story-scoped sheet first (Phase 4 — the canonical
    // source). When the story already has a costumed/styled-<clothing>
    // sheet for this character, use that. Falls back to the character row
    // for in-flight stories that pre-date Phase 1 (no characterAvatars
    // shadow write was performed) and for the per-page rerun endpoint
    // path that doesn't yet pass storyCharacterAvatars in deps.
    let storySlot = null;
    if (storyCharacterAvatars && storyCharacterAvatars[name]) {
      const entry = storyCharacterAvatars[name];
      if (costumeKey) {
        storySlot = entry.costumed || null;
      } else {
        storySlot = entry[`styled-${clothing}`] || entry.costumed || null;
      }
    }
    const styledForStyle = character.avatars?.styledAvatars?.[artStyleKey] || {};
    const cachedSheet = costumeKey
      ? styledForStyle.costumed?.[costumeKey]
      : styledForStyle[clothing];
    let sheetUri = storySlot
      ? (typeof storySlot === 'string' ? storySlot : (storySlot.imageUrl || storySlot.imageData || storySlot.data || null))
      : (cachedSheet
        ? (typeof cachedSheet === 'string' ? cachedSheet : (cachedSheet.imageUrl || cachedSheet.imageData || cachedSheet.data || null))
        : null);
    if (storySlot) log.debug(`[STORY-AVATAR] using story.characterAvatars[${name}] for ${clothing}`);

    // Step 2: lazy-generate if missing.
    if (!sheetUri || (!sheetUri.startsWith('data:') && !sheetUri.startsWith('http'))) {
      try {
        const costumeDesc = inputData.clothingRequirements?.[name]?.costumed?.description
          || inputData.clothingRequirements?.[name]?.description
          || (costumeKey || 'standard outfit');
        const gen = await generateCharacter2x4Sheet(character, {
          clothingCategory: clothing,
          costumeDescription: costumeDesc,
          artStyle: artStyleKey,
          usageTracker: addUsage ? (provider, usage, fn, modelId) => addUsage(provider, usage, fn, modelId) : undefined,
        });
        sheetUri = gen.imageData;
        // Cache on the in-memory character at the canonical styled-avatar field.
        character.avatars = character.avatars || {};
        character.avatars.styledAvatars = character.avatars.styledAvatars || {};
        character.avatars.styledAvatars[artStyleKey] = character.avatars.styledAvatars[artStyleKey] || {};
        if (costumeKey) {
          character.avatars.styledAvatars[artStyleKey].costumed = character.avatars.styledAvatars[artStyleKey].costumed || {};
          character.avatars.styledAvatars[artStyleKey].costumed[costumeKey] = sheetUri;
        } else {
          character.avatars.styledAvatars[artStyleKey][clothing] = sheetUri;
        }
        // Persist for reuse across stories. userId is optional (per-page
        // rerun endpoint may not always have it readily available); if
        // missing we just skip the persist and keep the in-memory cache.
        if (userId) {
          try {
            await persistStyledAvatar(userId, character.id, artStyleKey, costumeKey ? `costumed:${costumeKey}` : clothing, sheetUri);
          } catch (persistErr) {
            log.warn(`[SCENE COMPOSITE] persistStyledAvatar failed for ${name}/${clothing}: ${persistErr.message}`);
          }
        }
      } catch (err) {
        log.warn(`[SCENE COMPOSITE] cannot generate 2×4 sheet for ${name} (${clothing}): ${err.message}`);
        return null;
      }
    }
    const sheetBuf = Buffer.from(sheetUri.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    const pose = (sc.pose && ['front', 'threeQuarter', 'profile', 'back'].includes(sc.pose))
      ? sc.pose : 'threeQuarter';
    const flip = sc.flip === true;
    out.push({
      name,
      sheetBuf,
      pose,
      flip,
      action: actionsByChar.get(name.toLowerCase()) || null,
      position: sc.position || 'in the scene',
      sizeHint: sc.depth === 'background' ? 'small in the distance' : (sc.depth === 'midground' ? 'medium' : undefined),
    });
  }
  return out;
}

module.exports = { buildCompositeCast };
