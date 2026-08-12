// clothingResolve.js — clothing/avatar category resolution + character photo assembly.
// Extracted verbatim from storyHelpers.js (docs/plans/storyhelpers-split.md, Wave 1).
// storyHelpers.js re-exports everything here — importers keep requiring storyHelpers.
// Cross-bucket calls go through lazy require('./storyHelpers') to avoid circular imports.

const { log } = require('../utils/logger');
const { getPrimaryPhoto, getStandardAvatar, getFaceThumb, getBodyThumb } = require('./characterPhotos');

let imagesModule = null;
function getImagesModule() {
  if (!imagesModule) {
    imagesModule = require('./images');
  }
  return imagesModule;
}

/**
 * Format a clothing object into a readable string
 * @param {Object} clothingObj - Object with upperBody, lowerBody, shoes, fullBody properties
 * @returns {string} Formatted clothing description
 */
function formatClothingObject(clothingObj) {
  if (!clothingObj) return '';
  if (typeof clothingObj === 'string') return clothingObj;

  const parts = [];
  if (clothingObj.fullBody) {
    parts.push(clothingObj.fullBody);
  } else {
    if (clothingObj.upperBody) parts.push(clothingObj.upperBody);
    if (clothingObj.lowerBody) parts.push(clothingObj.lowerBody);
  }
  if (clothingObj.shoes) parts.push(clothingObj.shoes);

  return parts.join(', ');
}


/**
 * Apply a reference mode to a page's image-generation inputs. The mode controls
 * how many character / landmark photos get attached to the model call. The
 * Visual Bible grid is ALWAYS kept (it carries identity for proper-named
 * entities the model can't infer from the image alone). Looser modes trade
 * identity stability for painterly cohesion.
 *
 * Modes:
 *   'strict'      — pass the full 2×2 quadrant grid (face+body, front+profile)
 *                   on every shot (legacy behaviour)
 *   'loose'       — shot-aware reference packing using the pre-cropped
 *                   quadrants instead of the 2×2 grid:
 *                     close / medium / OTS  →  TWO refs per character
 *                                              (face crop + body crop)
 *                     wide                  →  ONE ref per character (body)
 *                   The face quadrant would anchor portrait scale on wide
 *                   shots, so it's dropped there. Older avatars without
 *                   thumbnail URLs fall back to the full 2×2 grid.
 *   'styled-only' — keep the full 2×2 grid (already styled) on every shot
 *   'off'         — drop character photos, landmarks, and empty-scene plate
 *
 * @param {Object} args
 * @param {string} args.mode               — one of strict|loose|styled-only|off
 * @param {Array}  args.characterPhotos    — current page character refs
 * @param {Buffer|string|null} args.visualBibleGrid — passed through untouched
 * @param {Array}  args.landmarkPhotos
 * @param {string|null} args.sceneBackground
 * @param {Object|null} args.sceneMetadata — used to read the shot type
 */
function applyReferenceMode({
  mode,
  characterPhotos = [],
  visualBibleGrid = null,
  landmarkPhotos = [],
  sceneBackground = null,
  sceneMetadata = null,
} = {}) {
  const m = String(mode || 'strict').toLowerCase();
  if (m === 'strict' || !m) {
    return { characterPhotos, visualBibleGrid, landmarkPhotos, sceneBackground };
  }
  if (m === 'off') {
    // VB grid stays — it's identity, not style noise.
    return { characterPhotos: [], visualBibleGrid, landmarkPhotos: [], sceneBackground: null };
  }
  if (m === 'styled-only') {
    return { characterPhotos, visualBibleGrid, landmarkPhotos, sceneBackground };
  }
  if (m === 'loose') {
    const shot = String(sceneMetadata?.fullData?.shot || sceneMetadata?.framingPattern || '').toLowerCase();
    const isWide = shot.includes('wide');
    // Two outputs per character: face + body, attached as separate refs (so
    // Grok can use each crop verbatim without splitting a quadrant). On wide
    // shots we drop the face crop because it would anchor portrait scale.
    // Older avatars (no thumbnail URLs) keep their single full-grid entry.
    //
    // CRITICAL: when the photo is already a fresh story-scoped cell crop
    // from applyStoryCellRefs (photoType starts with `cell-`), DO NOT
    // overwrite photoUrl with variantUrls. variantUrls.face/body point to
    // pre-baked thumbnails of the character's BASE photo (default outfit) —
    // overwriting with them silently reverts the freshly-rendered styled
    // avatar with the outline's per-story clothing back to the character's
    // default outfit. Real-world miss: smoke #5 page 4 had Hans in red
    // plaid + suspenders (base photo) instead of the outline-specified
    // beige collared shirt, because his cell-cropped watercolor ref got
    // overwritten by variantUrls.body pointing at the realistic plaid
    // thumbnail.
    const out = [];
    for (const p of characterPhotos) {
      if (!p) continue;
      const photoType = String(p.photoType || '');
      const isStoryCellCrop = photoType.startsWith('cell-');
      if (isStoryCellCrop) {
        // Already a per-story styled crop — keep verbatim. Do not split
        // into face/body variantUrls.
        out.push(p);
        continue;
      }
      const v = p.variantUrls || {};
      if (!v.face && !v.body) {
        // Pre-thumbnail avatar — keep the original entry untouched.
        out.push(p);
        continue;
      }
      if (!isWide && v.face) {
        out.push({ ...p, photoUrl: v.face, photoVariant: 'face' });
      }
      if (v.body) {
        out.push({ ...p, photoUrl: v.body, photoVariant: 'body' });
      } else if (isWide) {
        // Wide shot but no body crop available — keep the full grid as
        // fallback rather than dropping the character entirely.
        out.push(p);
      }
    }
    return { characterPhotos: out, visualBibleGrid, landmarkPhotos, sceneBackground };
  }
  return { characterPhotos, visualBibleGrid, landmarkPhotos, sceneBackground };
}


/**
 * Get photo URLs for specific characters based on clothing category
 * Prefers clothing avatar for the category > fallback categories > body with no background > body crop > face photo
 * @param {Array} characters - Array of character objects (filtered to scene)
 * @param {string} clothingCategory - Optional clothing category (winter, summer, formal, standard, costumed)
 * @returns {Array} Array of photo URLs for image generation
 */
function getCharacterPhotos(characters, clothingCategory = null) {
  if (!characters || characters.length === 0) return [];

  // Helper to extract URL from avatar data (handles object format)
  const extractUrl = (avatarData) => {
    if (!avatarData) return null;
    if (typeof avatarData === 'string') return avatarData;
    if (typeof avatarData === 'object') {
      // Prefer imageUrl (post-Phase-2 R2-migrated) over imageData (legacy inline base64).
      return avatarData.imageUrl || avatarData.imageData || null;
    }
    return null;
  };

  // Fallback priority for clothing avatars (same as getCharacterPhotoDetails)
  const clothingFallbackOrder = {
    winter: ['standard', 'summer'],
    summer: ['standard', 'winter'],
    standard: ['summer', 'winter'],
    costumed: ['standard']
  };

  return characters
    .map(char => {
      // Support both avatar structures (char.avatars and char.clothingAvatars)
      const avatars = char.avatars || char.clothingAvatars;

      // Handle costumed category - auto-detect costume type
      if (clothingCategory === 'costumed' && avatars?.costumed) {
        const availableCostumes = Object.keys(avatars.costumed);
        if (availableCostumes.length > 0) {
          const url = extractUrl(avatars.costumed[availableCostumes[0]]);
          if (url) return url;
        }
      }

      // If clothing category specified and character has clothing avatar for it, use it
      if (clothingCategory && clothingCategory !== 'costumed' && avatars && avatars[clothingCategory]) {
        return extractUrl(avatars[clothingCategory]);
      }

      // Try fallback clothing categories before falling back to body photos
      if (clothingCategory && avatars) {
        const fallbacks = clothingFallbackOrder[clothingCategory] || ['standard', 'summer', 'winter'];
        for (const fallbackCategory of fallbacks) {
          if (avatars[fallbackCategory]) {
            log.debug(`[AVATAR FALLBACK] ${char.name}: wanted ${clothingCategory}, using ${fallbackCategory}`);
            return extractUrl(avatars[fallbackCategory]);
          }
        }
      }

      // Fall back to body without background > body crop > face photo
      // Uses centralized helper (supports both legacy and normalized formats)
      return getPrimaryPhoto(char);
    })
    .filter(url => url); // Remove nulls
}

/**
 * Parse clothing category from scene description
 * Looks for patterns like "Clothing: winter" or "**Clothing:** standard"
 * @param {string} sceneDescription - The scene description text
 * @param {boolean} warnOnInvalid - Log warning if keyword found but no valid value (default: true)
 * @returns {string|null} Clothing category (winter, summer, formal, standard) or null if not found
 */
function parseClothingCategory(sceneDescription, warnOnInvalid = true) {
  const { extractSceneMetadata } = require('./storyHelpers'); // lazy: facade re-export (avoids circular import)
  if (!sceneDescription || typeof sceneDescription !== 'string') return null;

  // Step 0: Try JSON metadata block first (most reliable)
  const metadata = extractSceneMetadata(sceneDescription);
  if (metadata && metadata.clothing) {
    const clothingLower = metadata.clothing.toLowerCase();

    // Phase 5: collapse legacy `costumed:<subtype>` strings to bare `costumed`.
    // One costume per character per story — the subtype is captured separately
    // on story.visualBible.costumes / clothingRequirements.
    if (clothingLower.startsWith('costumed')) {
      log.debug(`[CLOTHING] Using JSON metadata: "${metadata.clothing}" → costumed`);
      return 'costumed';
    }

    // Standard categories
    const validValues = ['winter', 'summer', 'standard'];
    if (validValues.includes(clothingLower)) {
      log.debug(`[CLOTHING] Using JSON metadata: "${clothingLower}"`);
      return clothingLower;
    }
  }

  // Fallback: Generic approach - find "Clothing" keyword (in any language) and look for value nearby
  // Handles any markdown: **, *, --, __, ##, etc.

  // Markdown chars that might wrap keywords or values
  const md = '[\\*_\\-#\\s\\.\\d]*';

  // Clothing keywords in multiple languages
  const keywords = '(?:Clothing|Kleidung|Vêtements|Tenue)';

  // Valid clothing values — Phase 5: bare 'costumed' only, no subtype suffix.
  const values = '(winter|summer|standard|costumed)';

  // Pattern 1: Same line - keyword and value on same line with any markdown/separators
  // Handles: **Clothing:** winter, *Clothing*: **winter**, --Clothing--: winter, ## 4. Clothing: winter
  const sameLineMatch = sceneDescription.match(
    new RegExp(keywords + md + ':?' + md + values, 'i')
  );
  if (sameLineMatch) {
    return sameLineMatch[1].toLowerCase();
  }

  // Pattern 2: Value on next line - handles any markdown formatting
  // Handles: **Clothing:**\n**winter**, ## Clothing\n*winter*, Clothing:\nwinter
  const multilineMatch = sceneDescription.match(
    new RegExp(keywords + md + ':?' + md + '\\n' + md + values + md, 'i')
  );
  if (multilineMatch) {
    return multilineMatch[1].toLowerCase();
  }

  // Pattern 3: Fallback - find keyword and look for value within next 100 chars
  const keywordMatch = sceneDescription.match(new RegExp(keywords, 'i'));
  if (keywordMatch) {
    const startIndex = keywordMatch.index;
    const nearbyText = sceneDescription.substring(startIndex, startIndex + 100);
    const valueMatch = nearbyText.match(/\b(winter|summer|standard|costumed)\b/i);
    if (valueMatch) {
      return valueMatch[1].toLowerCase();
    }

    // Found keyword but no valid value - log error and default to standard
    if (warnOnInvalid) {
      const invalidValueMatch = nearbyText.match(/:\s*\*{0,2}(\w+)/i);
      const invalidValue = invalidValueMatch ? invalidValueMatch[1] : '(empty)';
      log.error(`[CLOTHING] No valid clothing value near keyword (found: "${invalidValue}"), defaulting to standard. Valid values: winter, summer, standard, costumed`);
    }
    return 'standard';
  }

  return null;
}

/**
 * Parse per-character clothing from scene description metadata
 * Returns a map of character name to clothing category
 * @param {string} sceneDescription - The scene description text
 * @returns {Object|null} Map of {characterName: clothingCategory} or null if not found
 */
function parseCharacterClothing(sceneDescription) {
  const { extractSceneMetadata } = require('./storyHelpers'); // lazy: facade re-export (avoids circular import)
  if (!sceneDescription || typeof sceneDescription !== 'string') return null;

  // Try JSON metadata block first (most reliable)
  const metadata = extractSceneMetadata(sceneDescription);
  if (metadata && metadata.characterClothing && typeof metadata.characterClothing === 'object') {
    // Normalize keys to handle case differences
    const normalized = {};
    for (const [name, clothing] of Object.entries(metadata.characterClothing)) {
      if (typeof clothing === 'string') {
        normalized[name] = clothing.toLowerCase();
      }
    }
    if (Object.keys(normalized).length > 0) {
      log.debug(`[CLOTHING] Per-character clothing from metadata: ${JSON.stringify(normalized)}`);
      return normalized;
    }
  }

  // Fallback: if we have legacy single clothing value, we can't determine per-character
  // Return null and let caller use the legacy parseClothingCategory
  return null;
}


/**
 * Pre-load avatar bytes for a list of characters so the synchronous
 * getCharacterPhotoDetails() can resolve URL-only avatars from a cache
 * instead of needing await.
 *
 * Returns a Map keyed by `${charId}:${slot}` → base64 string (no data: prefix).
 * Caller should await this BEFORE calling getCharacterPhotoDetails and pass
 * the result via the optional `avatarBytesCache` parameter.
 *
 * @param {Array} characters
 * @param {string[]} slotsNeeded - default ['standard', 'summer', 'winter']
 * @returns {Promise<Map<string, string>>}
 */
async function prefetchAvatarBytesForCharacters(characters, slotsNeeded = ['standard', 'summer', 'winter']) {
  const { loadAvatarBytes } = require('./characterPhotos');
  const cache = new Map();
  if (!Array.isArray(characters) || characters.length === 0) return cache;
  await Promise.all(characters.flatMap(c => slotsNeeded.map(async slot => {
    const bytes = await loadAvatarBytes(c.avatars || c.clothingAvatars || {}, slot);
    if (bytes) cache.set(`${c.id}:${slot}`, bytes);
  })));
  return cache;
}

/**
 * Get detailed photo info for characters (for dev mode display)
 * @param {Array} characters - Array of character objects
 * @param {string} defaultClothing - Optional clothing category to show which avatar is used
 * @param {string} costumeType - Optional costume type for 'costumed' category (e.g., 'pirate', 'superhero')
 * @param {string} artStyle - Optional art style to look for styled avatars first
 * @param {Object} clothingRequirements - Optional per-character clothing requirements from outline
 * @returns {Array} Array of objects with character name and photo type used
 */
function getCharacterPhotoDetails(characters, defaultClothing = null, artStyle = null, clothingRequirements = null, avatarBytesCache = null) {
  if (!characters || characters.length === 0) return [];

  // Fallback priority for clothing avatars when exact match not found
  // Note: 'formal' was a legacy clothing category — fully removed Phase 5.
  const clothingFallbackOrder = {
    winter: ['standard', 'summer'],
    summer: ['standard', 'winter'],
    standard: ['summer', 'winter'],
    costumed: ['standard']  // Costumed falls back to standard
  };

  // Per-story clothingRequirements (signature/description) is the
  // source of truth for the CURRENT story. avatars.clothing[category] is
  // character-level metadata that persists across stories and can be stale
  // (e.g. last story dressed Emma in pink, this story wants yellow). Lookup
  // priority: clothingRequirements.signature → clothingRequirements.description
  // → avatars.clothing[category].
  const resolveClothingDescription = (charName, category, avatars) => {
    if (!category) return null;
    const charReqs = clothingRequirements?.[charName];
    if (charReqs && charReqs[category]) {
      const catReq = charReqs[category];
      if (catReq.signature && catReq.signature !== 'none') return catReq.signature;
      if (catReq.description) return catReq.description;
    }
    if (avatars?.clothing?.[category]) {
      const clothingData = avatars.clothing[category];
      return typeof clothingData === 'string' ? clothingData : formatClothingObject(clothingData);
    }
    return null;
  };

  return characters
    .map(char => {
      let photoType = 'none';
      let photoUrl = null;

      // Support both new structure (char.avatars, char.photos) and legacy (char.clothingAvatars, char.bodyNoBgUrl, etc.)
      const avatars = char.avatars || char.clothingAvatars;
      const photos = char.photos || {};

      let clothingDescription = null;
      let actualClothingUsed = null;

      // Check for per-character clothing from scene (_currentClothing field).
      // This overrides defaultClothing for this specific character. We accept
      // two shapes:
      //   1. clothingRequirements[name] is a full object with _currentClothing
      //      (built by the page-generation path at server.js:4660ish)
      //   2. clothingRequirements[name] is a bare string clothing label, e.g.
      //      "costumed:medieval" — the shape produced by parseCharacterClothing
      //      and stored on scene.characterClothing / pageData.perCharClothing.
      //      Pre-fix this path silently fell through to defaultClothing → null
      //      → "standard", which then missed the styled-standard cache and
      //      fell back to the raw user photo (modern clothes leak into the
      //      costumed scene). Accepting the bare-string shape here closes that.
      let resolvedClothing = defaultClothing;
      const charReqs = require('./clothingCategories').resolveCharacterReqs(clothingRequirements, char.name);
      if (typeof charReqs === 'string' && charReqs.length > 0) {
        resolvedClothing = charReqs;
        log.debug(`[AVATAR LOOKUP] ${char.name}: per-scene clothing (flat-map) = ${resolvedClothing}`);
      } else if (charReqs?._currentClothing) {
        resolvedClothing = charReqs._currentClothing;
        log.debug(`[AVATAR LOOKUP] ${char.name}: per-scene clothing = ${resolvedClothing}`);
      } else {
        log.debug(`[AVATAR LOOKUP] ${char.name}: no per-scene clothing; using the category the caller passed (${resolvedClothing || 'none'})`);
      }

      // Safety net against leaked/stale _currentClothing: if the requested
      // category isn't marked `used` for this character but a costumed variant
      // IS `used`, switch to costumed. Characters that only have a costumed
      // variant in the story must always render in costume — a leaked
      // "standard" from an earlier page must not downgrade them.
      const resolvedBase = resolvedClothing && resolvedClothing.startsWith('costumed')
        ? 'costumed'
        : resolvedClothing;
      const reqUsed = (cat) => {
        const entry = charReqs?.[cat];
        return entry && typeof entry === 'object' && entry.used === true;
      };
      if (charReqs && resolvedBase && resolvedBase !== 'costumed' && !reqUsed(resolvedBase) && reqUsed('costumed')) {
        const costumeType = charReqs.costumed?.costume;
        resolvedClothing = costumeType ? `costumed:${costumeType}` : 'costumed';
        log.warn(`🧥 [AVATAR LOOKUP] ${char.name}: _currentClothing was "${charReqs._currentClothing}" but only costumed is used — resolving to ${resolvedClothing}`);
      }

      // Normalize: costumed:anything → costumed (only one costume per story),
      // and canonicalize case/format — resolvedClothing keys the case-sensitive
      // styledAvatars[artStyle][…] lookup below, so 'Winter' must become
      // 'winter' or the styled avatar is silently bypassed for the base one.
      if (resolvedClothing) {
        resolvedClothing = require('./clothingCategories').normalizeClothingCategory(resolvedClothing);
      }

      // Resolve a styled-avatar slot value to an image src string. The Phase 1e
      // backfill converted plain-string slots into {imageUrl, imageData} objects
      // (with imageData nulled post Phase 4). Accept all three shapes.
      const resolveStyled = (v) => {
        if (!v) return null;
        if (typeof v === 'string') return v;
        if (typeof v === 'object') return v.imageUrl || v.imageData || null;
        return null;
      };

      // Handle costumed category — one costume per story, just grab the first
      if (resolvedClothing === 'costumed') {
        // Check styled costumed avatars first (generated during this story's creation)
        if (artStyle && avatars?.styledAvatars?.[artStyle]?.costumed) {
          const costumeEntries = Object.entries(avatars.styledAvatars[artStyle].costumed);
          if (costumeEntries.length > 0) {
            const [key, data] = costumeEntries[0];
            photoUrl = resolveStyled(data);
            photoType = `costumed-${key}`;
            actualClothingUsed = 'costumed';
            log.debug(`[AVATAR LOOKUP] ${char.name}: using styled costumed "${key}" (src=${photoUrl ? (photoUrl.startsWith('http')?'URL':'data:') : 'NULL'})`);

            // Get clothing description from avatars.clothing.costumed
            if (avatars?.clothing?.costumed) {
              const clothingDesc = Object.values(avatars.clothing.costumed)[0];
              if (clothingDesc) {
                clothingDescription = typeof clothingDesc === 'string' ? clothingDesc : formatClothingObject(clothingDesc);
              }
            }
            // Fallback: get costume description from clothingRequirements
            if (!clothingDescription && clothingRequirements?.[char.name]?.costumed?.description) {
              clothingDescription = clothingRequirements[char.name].costumed.description;
              log.debug(`[CLOTHING DESC] ${char.name}: using costumed description from clothingRequirements`);
            }
          }
        }
        // Styled costumed avatar not found (may still be generating).
        // Still use the costumed clothing DESCRIPTION so scene expansion prose
        // describes the costume, not standard clothes.
        if (!photoUrl) {
          if (avatars?.clothing?.costumed) {
            const clothingDesc = Object.values(avatars.clothing.costumed)[0];
            if (clothingDesc) {
              clothingDescription = typeof clothingDesc === 'string' ? clothingDesc : formatClothingObject(clothingDesc);
              log.debug(`[AVATAR LOOKUP] ${char.name}: costumed avatar not ready, using costumed clothing description`);
            }
          }
          if (!clothingDescription && clothingRequirements?.[char.name]?.costumed?.description) {
            clothingDescription = clothingRequirements[char.name].costumed.description;
            log.debug(`[AVATAR LOOKUP] ${char.name}: costumed avatar not ready, using description from clothingRequirements`);
          }
        }
        // Photo falls through to standard avatar below, but description is costumed
      }
      // Check styled avatars first (with signature items from this story)
      else if (resolvedClothing && resolvedClothing !== 'costumed' &&
               artStyle && avatars?.styledAvatars?.[artStyle]?.[resolvedClothing]) {
        // Accepts string, {imageData}, or {imageUrl, imageData:null} shapes.
        const styledData = avatars.styledAvatars[artStyle][resolvedClothing];
        photoUrl = resolveStyled(styledData);
        photoType = `styled-${resolvedClothing}`;
        actualClothingUsed = resolvedClothing;
        log.debug(`[AVATAR LOOKUP] ${char.name}: using styled ${resolvedClothing} for ${artStyle}`);

        if (!clothingDescription) {
          clothingDescription = resolveClothingDescription(char.name, resolvedClothing, avatars);
          if (clothingDescription) log.debug(`[CLOTHING DESC] ${char.name}: resolved for styled ${resolvedClothing}: "${clothingDescription}"`);
        }
      }
      // Fall back to unstyled clothing avatar (standard, winter, summer).
      // Usable when inline base64, R2 URL, or prefetched cache bytes exist.
      // Dual-shape (Phase 1): getStandardAvatar handles NEW (URL on `.standard`)
      // and OLD (`.standardUrl` / inline / object) shapes uniformly.
      else if (resolvedClothing && resolvedClothing !== 'costumed' && avatars &&
               (getStandardAvatar(avatars, resolvedClothing) || avatarBytesCache?.has(`${char.id}:${resolvedClothing}`))) {
        photoType = `clothing-${resolvedClothing}`;
        // Handle various legacy formats: arrays, {imageData, clothing} objects
        const avatarData = avatars[resolvedClothing];
        if (Array.isArray(avatarData)) {
          photoUrl = avatarData[0];
        } else if (typeof avatarData === 'object' && avatarData?.imageData) {
          photoUrl = avatarData.imageData;
        } else if (avatarData) {
          photoUrl = avatarData;
        } else {
          // Inline missing — try the prefetch cache (R2-resolved bytes).
          const cached = avatarBytesCache?.get(`${char.id}:${resolvedClothing}`);
          if (cached) photoUrl = `data:image/jpeg;base64,${cached}`;
        }
        actualClothingUsed = resolvedClothing;
        clothingDescription = resolveClothingDescription(char.name, resolvedClothing, avatars);
        // Desync detector: the ref image shows the STORED outfit while the
        // resolved text says the STORY outfit — the visual ref usually wins,
        // so the story outfit won't render. Benign when they match (realistic
        // non-redressed categories are exactly this case).
        const storedDesc = String(avatars?.clothing?.[resolvedClothing] || '').trim();
        if (clothingDescription && storedDesc && clothingDescription.trim() !== storedDesc) {
          log.warn(`⚠️ [AVATAR] ${char.name}: no styled ${resolvedClothing} avatar for ${artStyle} but story outfit differs from stored — ref image shows stored clothing while text says "${clothingDescription.substring(0, 60)}…"`);
        } else {
          log.debug(`[AVATAR LOOKUP] ${char.name}: using unstyled ${resolvedClothing} (no styled avatar found)`);
        }
      }


      // Try fallback clothing avatars before falling back to body photo
      // NOTE: We skip styled avatar fallbacks - only use unstyled base avatars
      // applyStyledAvatars() will convert to target style via fresh cache
      if (!photoUrl && resolvedClothing && avatars) {
        const fallbacks = clothingFallbackOrder[resolvedClothing] || ['standard', 'summer', 'winter'];

        // Check unstyled avatars only (styling applied later via cache).
        // Cache fallback covers the URL-only post-migration shape.
        for (const fallbackCategory of fallbacks) {
          const inlineFallback = avatars[fallbackCategory];
          const cachedFallback = avatarBytesCache?.get(`${char.id}:${fallbackCategory}`);
          if (inlineFallback || cachedFallback) {
            photoType = `clothing-${fallbackCategory}`;
            // Handle various legacy formats: arrays, {imageData, clothing} objects
            const fallbackData = inlineFallback;
            if (Array.isArray(fallbackData)) {
              photoUrl = fallbackData[0];
            } else if (typeof fallbackData === 'object' && fallbackData?.imageData) {
              photoUrl = fallbackData.imageData;
            } else if (fallbackData) {
              photoUrl = fallbackData;
            } else if (cachedFallback) {
              photoUrl = `data:image/jpeg;base64,${cachedFallback}`;
            }
            actualClothingUsed = fallbackCategory;
            // Only fill clothingDescription if not already set. The costumed branch
            // above may have set it from clothingRequirements — don't overwrite the
            // costume description with the standard one just because the photo fell back.
            // ALSO: if the original request was costumed and we have NO description
            // anywhere, leave it empty rather than leak standard clothing description
            // into a costumed scene (better to have no clothing guidance than wrong).
            const descriptionPreservedFromCostumed = !!clothingDescription;
            if (!clothingDescription && resolvedClothing !== 'costumed') {
              clothingDescription = resolveClothingDescription(char.name, fallbackCategory, avatars);
            }
            // Distinguish benign pre-resolution from real problems:
            // - Costumed with description already preserved: styled avatar isn't ready
            //   yet (scene-expansion pre-resolve runs before prepareStyledAvatars). The
            //   photo URL is unused in that context. Not a problem.
            // - Description now describes the fallback category (e.g. wanted winter,
            //   got standard): output will describe the wrong clothing. Real problem.
            // - No description at all: requested clothing has no description anywhere.
            if (resolvedClothing === 'costumed' && descriptionPreservedFromCostumed) {
              log.debug(`[AVATAR] ${char.name}: costumed photo not yet styled, using ${fallbackCategory} photo as reference (costume description preserved)`);
            } else if (!clothingDescription) {
              log.warn(`⚠️ [AVATAR] ${char.name}: wanted ${resolvedClothing}, fell back to ${fallbackCategory} photo AND no clothing description available — output will lack clothing guidance`);
            } else {
              log.warn(`⚠️ [AVATAR] ${char.name}: wanted ${resolvedClothing}, fell back to ${fallbackCategory} — output will describe ${fallbackCategory} clothing instead of ${resolvedClothing}`);
            }
            break;
          }
        }
      }

      // If still no avatar, fall back to body photos
      // Uses centralized helper (supports both legacy and normalized formats)
      if (!photoUrl) {
        if (photos.bodyNoBg) {
          photoType = 'bodyNoBg';
          photoUrl = photos.bodyNoBg;
        } else if (photos.body) {
          photoType = 'body';
          photoUrl = photos.body;
        } else if (photos.face || photos.original) {
          photoType = 'face';
          photoUrl = photos.face || photos.original;
        } else {
          // Final fallback using helper for any remaining legacy formats
          const fallbackPhoto = getPrimaryPhoto(char);
          if (fallbackPhoto) {
            photoType = 'fallback';
            photoUrl = fallbackPhoto;
          }
        }
      }

      // Bug #9 fix: Log when no photo found for a character
      if (!photoUrl) {
        const searchedFor = resolvedClothing || defaultClothing || 'any';
        const hasAvatars = !!avatars;
        const hasPhotos = Object.keys(photos).length > 0;
        log.warn(`[PHOTO LOOKUP] No photo found for "${char.name}" (wanted: ${searchedFor}, hasAvatars: ${hasAvatars}, hasPhotos: ${hasPhotos})`);
      }

      // Final fallback: catch any code path above that left clothingDescription
      // null (e.g. when only photos fell through). Same priority as the helper:
      // clothingRequirements.signature → .description → avatars.clothing[category].
      if (!clothingDescription) {
        const categoryToCheck = actualClothingUsed || resolvedClothing;
        clothingDescription = resolveClothingDescription(char.name, categoryToCheck, avatars);
        if (clothingDescription) log.debug(`[CLOTHING DESC] ${char.name}: late-resolved for ${categoryToCheck}: "${clothingDescription}"`);
      }

      // Per-clothing face/body crop URLs for shot-aware reference selection.
      // The default `photoUrl` above is the full 2x2 quadrant grid (face-front,
      // face-profile, body-front, body-profile). For wide shots we want body
      // only — the face quadrants anchor portrait scale and pull the figure
      // into the foreground. For close-ups we want face only — the body
      // quadrants waste reference attention. applyReferenceMode() reads these
      // and swaps photoUrl per scene shot type. Falls back to null when an
      // older avatar (no thumbnails generated) doesn't have these slots.
      // NO DEFAULT CLOTHING (owner, 2026-08-07): with no resolved category we
      // pick no thumbnail variant rather than the 'standard' wardrobe's.
      const variantClothing = (actualClothingUsed || resolvedClothing || null);
      const variantBase = !variantClothing ? null
        : (variantClothing.startsWith('costumed') ? 'standard' : variantClothing);
      // Dual-shape (Phase 1 migration): getFaceThumb/getBodyThumb read NEW
      // `faceThumb`/`bodyThumb` first, fall back to OLD `faceThumbnailsUrl`/
      // `faceThumbnails` (and same for body). One helper, one source of truth.
      const faceVariantUrl = getFaceThumb(avatars, variantBase);
      const bodyVariantUrl = getBodyThumb(avatars, variantBase);

      return {
        name: char.name,
        id: char.id,
        photoType,
        photoUrl,
        photoHash: getImagesModule().hashImageData(photoUrl),  // For dev mode verification
        clothingCategory: actualClothingUsed || resolvedClothing || null,
        // Originally requested category, before any fallback. applyStyledAvatars
        // prefers this for its cache lookup — after a winter→standard photo
        // fallback, a styled WINTER avatar that exists in cache must still win
        // over the standard one the fallback photo reports.
        requestedClothingCategory: resolvedClothing || null,
        clothingDescription,  // Exact clothing from avatar eval (e.g., "red winter parka, blue jeans")
        variantUrls: {
          face: faceVariantUrl,
          body: bodyVariantUrl,
        },
        hasPhoto: photoType !== 'none'
      };
    })
    .filter(info => info.hasPhoto);
}

// ============================================================================
// Character visual profile — single source of truth
// ----------------------------------------------------------------------------
// Historically we had four copy-pasted description builders (image prompt,
// cover reference list, scene expansion, feedback validation). Each one read
// the same physical fields but formatted them differently, and adding/fixing
// a field (e.g. glasses) meant four edits. Now:
//
//   getPhysicalFromChar(char)
//      ↓
//   extractCharacterVisualProfile(char, opts)   ← one canonical data shape
//      ↓
//   buildLabeledPhysicalParts(profile, opts)    ← one formatter that emits
//                                                  "Label: value" parts
//      ↓
//   thin public wrappers join the parts differently (prose / numbered /
//   [Name]: markdown) for their caller's context.
// ============================================================================

// Synonyms for "no / none / absent" across the languages our users type in.

/**
 * Build the per-page resolved view of clothingRequirements. Single source of
 * truth for "what is each character wearing on THIS page" — used by page
 * generation, scale-repair, and any other path that needs the per-page outfit.
 *
 * Story-level `clothingRequirements` holds the FULL outfit description per
 * (character, category). Per-page `perCharClothing` holds the CATEGORY label
 * for each character on this page. This function combines them: shallow-clones
 * the story-level requirements, then stamps `_currentClothing: <category>` on
 * each scene character's entry so downstream `resolveClothingForPage(char,
 * label, sceneClothingRequirements)` can pick the right description (handling
 * per-page outfit swaps like a character starting in standard and switching
 * to costumed mid-story).
 *
 * Fallback when a scene character has no per-page entry: use the character's
 * `costumed.used: true` variant if present (story is fully costumed), else
 * default to 'standard'.
 *
 * Shallow-clones the inner entry before stamping `_currentClothing` so the
 * story-level `clothingRequirements` is not mutated.
 *
 * @param {Array<{name: string}>} sceneCharacters - chars present in this page
 * @param {Object} perCharClothing - per-page category map (e.g. { Hans: 'standard' })
 * @param {Object} clothingRequirements - story-level requirements blob
 * @returns {Object} sceneClothingRequirements with _currentClothing per char
 */
function buildSceneClothingRequirements(sceneCharacters, perCharClothing, clothingRequirements) {
  const out = { ...(clothingRequirements || {}) };
  const perChar = perCharClothing || {};
  for (const char of (sceneCharacters || [])) {
    if (!char?.name) continue;
    const charNameTrimmed = char.name.trim().toLowerCase();
    let charClothing = Object.entries(perChar).find(
      ([name]) => name.trim().toLowerCase() === charNameTrimmed
    )?.[1];
    if (!charClothing) {
      const globalReqs = clothingRequirements?.[char.name]
        || Object.entries(clothingRequirements || {}).find(([n]) => n.trim().toLowerCase() === charNameTrimmed)?.[1];
      if (globalReqs?.costumed?.used) {
        // Not a guess: a fully-costumed story has exactly one outfit, so the
        // page not restating it carries no ambiguity.
        charClothing = 'costumed';
        log.debug(`👕 [CLOTHING] ${char.name}: no per-scene clothing, story is costumed (${globalReqs.costumed.costume || 'unnamed'})`);
      } else {
        // Still not a guess: when this story marks exactly ONE category `used`
        // for this character, that category is the only outfit they own here —
        // the page omitting it carries no ambiguity, same argument as the
        // costumed branch above. Measured on 40 staging stories: 6 of 299 pages
        // reach this line with a roster character who is genuinely in the scene,
        // and every one of them has a single used category. Without this they
        // lose their repair entirely.
        const used = Object.entries(globalReqs || {})
          .filter(([, v]) => v && typeof v === 'object' && v.used)
          .map(([k]) => k);
        if (used.length === 1) {
          charClothing = used[0];
          log.warn(`⚠️ [CLOTHING] ${char.name}: no per-page clothing category — using their only used category "${charClothing}"`);
        } else {
          // NO DEFAULT CLOTHING (owner, 2026-08-07). The old `'standard'` here
          // named a category the story may not use, which has no description, so
          // buildClothingDescription fell through to the character-level
          // avatars.clothing — an outfit from an unrelated story.
          throw new Error(`[CLOTHING] ${char.name}: no per-page clothing category, story is not costumed, and ${used.length === 0 ? 'no category is marked used' : `${used.length} categories are in use (${used.join(', ')})`}. Refusing to default to 'standard'.`);
        }
      }
    }
    out[char.name] = {
      ...(out[char.name] || {}),
      _currentClothing: charClothing,
    };
  }
  return out;
}

/**
 * Resolve the page-level clothing label (e.g. "costumed:medieval", "winter",
 * "summer", "standard") to a plain-text clothing description suitable as
 * `clothingOverride` for buildCharacterPhysicalDescription. Mirrors the
 * resolution priority used by buildScenePromptWithCharacters.
 *
 * @param {Object} char - Character object
 * @param {string|null} clothingLabel - per-page clothing label (e.g. 'costumed:medieval')
 * @param {Object|null} clothingRequirements - per-character clothing requirements
 *                                             from the unified outline pass
 * @returns {string|null} resolved clothing text, or null when nothing applies
 */
function resolveClothingForPage(char, clothingLabel, clothingRequirements = null) {
  if (!char) return null;
  const avatars = char.avatars || char.clothingAvatars || {};
  const label = (clothingLabel || '').trim();
  const isCostumed = label.startsWith('costumed');

  // Priority: clothingRequirements (per-story, source of truth for CURRENT
  // story) → avatars.clothing (character-level metadata, can be stale across
  // stories). Per the 2026-05-22 codebase-audit decision, avatars.clothing
  // is kept as a fallback rather than removed.
  if (isCostumed) {
    const reqs = clothingRequirements?.[char.name]?.costumed;
    if (reqs?.signature && reqs.signature !== 'none') return reqs.signature;
    if (reqs?.description) return reqs.description;
    if (avatars?.clothing?.costumed) {
      const desc = Object.values(avatars.clothing.costumed)[0];
      if (desc) return typeof desc === 'string' ? desc : formatClothingObject(desc);
    }
    return null;
  }

  if (label) {
    const reqs = clothingRequirements?.[char.name]?.[label];
    if (reqs?.signature && reqs.signature !== 'none') return reqs.signature;
    if (reqs?.description) return reqs.description;
    if (avatars?.clothing?.[label]) {
      const desc = avatars.clothing[label];
      return typeof desc === 'string' ? desc : formatClothingObject(desc);
    }
  }
  return null;
}


/**
 * Every outfit a character actually wears in this story, as TEXT.
 *
 * The per-page category is unknown at scene-expansion time — `pageClothing` is
 * DERIVED from the scene metadata that stage produces (storyJobPipeline.js) —
 * so a resolver keyed on one category cannot run there. This one is keyed on
 * the contract instead: every `used: true` entry, labelled with the key the
 * Art Director must write into its metadata.
 *
 * One used category → the description alone (the common case: no label noise).
 * Several → `label — description` joined, so the brief can pick per page.
 *
 * @param {Object} char
 * @param {Object|null} clothingRequirements
 * @returns {string|null} null when the character has no usable outfit
 */
function buildUsedClothingText(char, clothingRequirements) {
  if (!char?.name || !clothingRequirements) return null;
  const { resolveCharacterReqs } = require('./clothingCategories');
  const reqs = resolveCharacterReqs(clothingRequirements, char.name);
  if (!reqs) return null;

  const parts = [];
  for (const [category, entry] of Object.entries(reqs)) {
    if (!entry || typeof entry !== 'object' || !entry.used) continue;
    const text = (entry.signature && entry.signature !== 'none') ? entry.signature : entry.description;
    if (!text || !String(text).trim()) continue;
    const label = (category === 'costumed' && entry.costume) ? `costumed:${entry.costume}` : category;
    parts.push({ label, text: String(text).trim() });
  }
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0].text;
  return parts.map(p => `${p.label} — ${p.text}`).join(' | ');
}

/**
 * Build available avatars list for scene expansion prompt
 * @param {Array} characters - Character array with avatars
 * @param {Object} clothingRequirements - Optional: only show categories with used=true
 * @returns {string} Formatted string showing available clothing per character
 */
function buildAvailableAvatarsForPrompt(characters, clothingRequirements = null) {
  if (!characters || characters.length === 0) return '(No characters)';

  return characters.map(char => {
    const avatars = char.avatars || {};
    const charNameLower = char.name?.toLowerCase();

    // If clothingRequirements provided, only show categories actually used in this story
    if (clothingRequirements && Object.keys(clothingRequirements).length > 0) {
      const charReqs = clothingRequirements[char.name] ||
                       clothingRequirements[charNameLower] ||
                       Object.entries(clothingRequirements)
                         .find(([k]) => k.toLowerCase() === charNameLower)?.[1];

      if (charReqs) {
        const usedCategories = Object.entries(charReqs)
          .filter(([cat, config]) => config?.used)
          .map(([cat, config]) => cat === 'costumed' && config?.costume
            ? `costumed:${config.costume}`
            : cat);

        if (usedCategories.length > 0) {
          return `- ${char.name}: ${usedCategories.join(', ')}`;
        }
      }
      // No entry (or no used category) for this character in clothingRequirements.
      // Settled rule (decisions.md 2026-08-07): never default a clothing category —
      // resolve canonically or refuse. Defaulting to 'standard' here dressed
      // characters in stale outfits from unrelated stories with zero log trace.
      try { require('../utils/logger').log.warn(`⚠️ [AVATARS-PROMPT] ${char.name} missing from clothingRequirements — refusing to default to 'standard' (unresolved)`); } catch { /* logger optional */ }
      return `- ${char.name}: UNRESOLVED — no clothing requirement recorded for this character; do not invent an outfit, reuse this character's outfit exactly as described elsewhere in this brief's CHARACTER DETAILS`;
    }

    // Legacy behavior: show all available avatars
    const available = [];

    // Standard categories — dual-shape (Phase 1): getStandardAvatar reads NEW
    // `avatars.{variant}` (URL string) first, falls back to OLD `avatars.{variant}Url`
    // or inline object form. One helper, one source of truth.
    if (getStandardAvatar(avatars, 'standard')) available.push('standard');
    if (getStandardAvatar(avatars, 'winter'))   available.push('winter');
    if (getStandardAvatar(avatars, 'summer'))   available.push('summer');

    // Costumed categories
    if (avatars.costumed && typeof avatars.costumed === 'object') {
      for (const costumeType of Object.keys(avatars.costumed)) {
        available.push(`costumed:${costumeType}`);
      }
    }

    // Fallback - always assume standard exists
    if (available.length === 0) available.push('standard');

    return `- ${char.name}: ${available.join(', ')}`;
  }).join('\n');
}


/**
 * Convert clothingRequirements to _currentClothing format for getCharacterPhotoDetails
 * This ensures characters use the story's costumes (not 'standard' fallback) for covers
 *
 * @param {Object} clothingRequirements - Raw clothing requirements from story/streaming
 * @returns {Object} - Converted requirements with _currentClothing set for each character
 */
function convertClothingToCurrentFormat(clothingRequirements) {
  const converted = {};
  for (const [charName, charData] of Object.entries(clothingRequirements || {})) {
    if (typeof charData === 'string') {
      // Flat format: "costumed:1889 belle epoque"
      converted[charName] = { _currentClothing: charData };
    } else if (charData && typeof charData === 'object') {
      if (charData._currentClothing) {
        // Already has _currentClothing, copy as-is
        converted[charName] = { ...charData };
      } else if (charData.costumed && charData.costumed.used === true && charData.costumed.costume) {
        // Nested format: { costumed: { costume: "1889 belle epoque", used: true } }
        // Both `used: true` AND a real costume name required — Claude sometimes writes
        // `{ used: false, costume: "none" }` for stories without costumes; without the
        // `used` check we'd emit `_currentClothing: "costumed:none"` and the cover lookup
        // would warn-and-fall-back on a bogus key.
        const costume = String(charData.costumed.costume).trim().toLowerCase();
        if (costume && costume !== 'none' && costume !== '[type]' && costume !== 'n/a') {
          converted[charName] = {
            ...charData,
            _currentClothing: `costumed:${charData.costumed.costume}`
          };
        } else {
          converted[charName] = { ...charData };
        }
      } else {
        // No costume found, copy as-is
        converted[charName] = { ...charData };
      }
    }
  }
  return converted;
}

// ============================================================================
// PAGE TEXT HELPERS
// ============================================================================


module.exports = {
  formatClothingObject,
  applyReferenceMode,
  getCharacterPhotos,
  parseClothingCategory,
  parseCharacterClothing,
  prefetchAvatarBytesForCharacters,
  getCharacterPhotoDetails,
  buildSceneClothingRequirements,
  resolveClothingForPage,
  buildUsedClothingText,
  buildAvailableAvatarsForPrompt,
  convertClothingToCurrentFormat
};
