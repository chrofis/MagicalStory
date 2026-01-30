/**
 * Character Routes - /api/characters/*
 *
 * Character management endpoints
 */

const express = require('express');
const router = express.Router();

const { dbQuery, isDatabaseMode, logActivity } = require('../services/database');
const { authenticateToken } = require('../middleware/auth');

// GET /api/characters - Get user's characters
// Query params:
//   - includeAllAvatars=true: Include all avatar variants (dev mode only)
//   By default, only returns 'standard' avatar to reduce payload size
router.get('/', authenticateToken, async (req, res) => {
  try {
    const startTime = Date.now();
    // Allow includeAllAvatars for admins OR when admin is impersonating a user
    const includeAllAvatars = req.query.includeAllAvatars === 'true' &&
      (req.user.role === 'admin' || req.user.impersonating);

    let characterData = {
      characters: [],
      relationships: {},
      relationshipTexts: {},
      customRelationships: [],
      customStrengths: [],
      customWeaknesses: [],
      customFears: []
    };

    if (isDatabaseMode()) {
      const characterId = `characters_${req.user.id}`;
      let rows;
      const queryStart = Date.now();

      if (includeAllAvatars) {
        // Admin mode: return full data
        rows = await dbQuery('SELECT data FROM characters WHERE id = $1', [characterId]);
        if (rows.length === 0) {
          rows = await dbQuery('SELECT data FROM characters WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1', [req.user.id]);
        }
      } else {
        // Normal mode: use metadata column (pre-stripped, ~100KB vs 14MB)
        rows = await dbQuery('SELECT metadata FROM characters WHERE id = $1', [characterId]);
        if (rows.length === 0) {
          rows = await dbQuery('SELECT metadata FROM characters WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1', [req.user.id]);
        }
        // Rename metadata to data for consistent handling below
        if (rows.length > 0 && rows[0].metadata) {
          rows[0].data = rows[0].metadata;
        } else if (rows.length > 0 && !rows[0].metadata) {
          // Fallback: metadata column not populated yet, use full data with JS stripping
          console.log('[Characters] GET - metadata column empty, falling back to full data');
          rows = await dbQuery('SELECT data FROM characters WHERE id = $1', [characterId]);
        }
      }
      const queryTime = Date.now() - queryStart;
      console.log(`[Characters] GET - Query took ${queryTime}ms for user_id: ${req.user.id}, mode: ${includeAllAvatars ? 'full' : 'metadata'}`);

      if (rows.length > 0 && rows[0].data) {
        const data = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;
        if (Array.isArray(data)) {
          characterData.characters = data;
        } else {
          characterData = { ...characterData, ...data };
        }
        console.log(`[Characters] GET - Characters count: ${characterData.characters.length}, total time: ${Date.now() - startTime}ms`);
      }
    } else {
      return res.status(501).json({ error: 'File storage mode not supported' });
    }

    // Runtime stripping for non-admin mode - handles stale metadata with embedded base64
    // These fields should have been stripped when saving but some old data has them
    if (!includeAllAvatars && characterData.characters) {
      const preStripSize = JSON.stringify(characterData).length;
      characterData.characters = characterData.characters.map(char => {
        // Strip heavy base64 fields that shouldn't be in metadata
        const {
          body_no_bg_url, body_photo_url, photo_url, thumbnail_url,
          clothing_avatars, photos, styledAvatars, costumedAvatars,
          ...lightChar
        } = char;

        // Also strip faceThumbnails except 'standard' (they're 260-330KB each)
        if (lightChar.avatars?.faceThumbnails) {
          const standardThumb = lightChar.avatars.faceThumbnails.standard;
          lightChar.avatars = {
            ...lightChar.avatars,
            faceThumbnails: standardThumb ? { standard: standardThumb } : undefined
          };
        }

        return lightChar;
      });
      const postStripSize = JSON.stringify(characterData).length;
      if (preStripSize - postStripSize > 100000) {
        console.log(`[Characters] GET - Runtime stripped ${Math.round((preStripSize - postStripSize)/1024)}KB from stale metadata`);
      }
    }

    // Fire and forget - don't block response for logging
    logActivity(req.user.id, req.user.username, 'CHARACTERS_LOADED', { count: characterData.characters.length }).catch(() => {});
    res.json(characterData);
  } catch (err) {
    console.error('Error fetching characters:', err);
    res.status(500).json({ error: 'Failed to fetch characters' });
  }
});

// PUT /api/characters/roles - Update story roles for characters
// IMPORTANT: This must be BEFORE /:characterId routes to avoid "roles" being matched as an ID
// Body: { roles: { [characterId]: 'main' | 'in' | 'out' } }
router.put('/roles', authenticateToken, async (req, res) => {
  try {
    const { roles } = req.body;

    if (!roles || typeof roles !== 'object') {
      return res.status(400).json({ error: 'roles object is required' });
    }

    if (!isDatabaseMode()) {
      return res.status(501).json({ error: 'File storage mode not supported' });
    }

    const rowId = `characters_${req.user.id}`;

    // Get current data
    const rows = await dbQuery('SELECT data FROM characters WHERE id = $1', [rowId]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'No characters found' });
    }

    const data = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;
    const characters = Array.isArray(data) ? data : (data.characters || []);

    // Update storyRole for each character
    let updatedCount = 0;
    for (const char of characters) {
      const role = roles[char.id];
      if (role && ['main', 'in', 'out'].includes(role)) {
        char.storyRole = role;
        updatedCount++;
      }
    }

    // Prepare updated data
    const updatedData = Array.isArray(data) ? characters : { ...data, characters };

    // Create metadata (stripped version for fast loading)
    const metadataCharacters = characters.map(char => {
      const { avatars, photos, generatedOutfits, ...rest } = char;
      return {
        ...rest,
        avatars: avatars ? {
          // Don't include full avatars in metadata - use hasFullAvatars flag instead
          // Full avatars are loaded on-demand via /api/characters/:id/avatars
          hasFullAvatars: !!(avatars.standard || avatars.winter || avatars.summer || avatars.formal),
          status: avatars.status,
          faceThumbnails: avatars.faceThumbnails,
          // Include clothing descriptions (lightweight text, needed for story generation)
          clothing: avatars.clothing,
          signatures: avatars.signatures
        } : undefined
      };
    });
    const metadata = Array.isArray(data) ? metadataCharacters : { ...data, characters: metadataCharacters };

    // Save both data and metadata
    await dbQuery(
      'UPDATE characters SET data = $1, metadata = $2 WHERE id = $3',
      [JSON.stringify(updatedData), JSON.stringify(metadata), rowId]
    );

    console.log(`[Characters] PUT /roles - Updated ${updatedCount} character roles for user ${req.user.id}`);
    res.json({ success: true, updatedCount });
  } catch (err) {
    console.error('Error updating character roles:', err);
    res.status(500).json({ error: 'Failed to update character roles' });
  }
});

// GET /api/characters/:characterId/avatars - Get full avatars for a specific character
// Used for on-demand loading when editing a character (avoids loading all avatars upfront)
router.get('/:characterId/avatars', authenticateToken, async (req, res) => {
  try {
    const { characterId } = req.params;

    if (!isDatabaseMode()) {
      return res.status(501).json({ error: 'File storage mode not supported' });
    }

    const rowId = `characters_${req.user.id}`;

    // Extract only the avatars for the specific character
    const query = `
      SELECT c->'avatars' as avatars
      FROM characters, jsonb_array_elements(data->'characters') c
      WHERE id = $1 AND (c->>'id')::bigint = $2
    `;

    const result = await dbQuery(query, [rowId, characterId]);

    if (result.length === 0) {
      // Try legacy format
      const legacyQuery = `
        SELECT c->'avatars' as avatars
        FROM characters, jsonb_array_elements(data->'characters') c
        WHERE user_id = $1 AND (c->>'id')::bigint = $2
        ORDER BY created_at DESC
        LIMIT 1
      `;
      const legacyResult = await dbQuery(legacyQuery, [req.user.id, characterId]);

      if (legacyResult.length === 0) {
        return res.status(404).json({ error: 'Character not found' });
      }

      return res.json({ avatars: legacyResult[0].avatars || {} });
    }

    console.log(`[Characters] GET /${characterId}/avatars - Loaded full avatars`);
    res.json({ avatars: result[0].avatars || {} });
  } catch (err) {
    console.error('Error fetching character avatars:', err);
    res.status(500).json({ error: 'Failed to fetch character avatars' });
  }
});

// GET /api/characters/:characterId/full - Get ALL data for a specific character (for editing)
// This loads the heavy fields: avatars, body_no_bg_url, body_photo_url, photo_url, clothing_avatars
router.get('/:characterId/full', authenticateToken, async (req, res) => {
  try {
    const { characterId } = req.params;

    if (!isDatabaseMode()) {
      return res.status(501).json({ error: 'File storage mode not supported' });
    }

    const rowId = `characters_${req.user.id}`;

    // Extract the full character data (all fields)
    const query = `
      SELECT c as character
      FROM characters, jsonb_array_elements(data->'characters') c
      WHERE id = $1 AND (c->>'id')::bigint = $2
    `;

    const result = await dbQuery(query, [rowId, characterId]);

    if (result.length === 0) {
      // Try legacy format
      const legacyQuery = `
        SELECT c as character
        FROM characters, jsonb_array_elements(data->'characters') c
        WHERE user_id = $1 AND (c->>'id')::bigint = $2
        ORDER BY created_at DESC
        LIMIT 1
      `;
      const legacyResult = await dbQuery(legacyQuery, [req.user.id, characterId]);

      if (legacyResult.length === 0) {
        return res.status(404).json({ error: 'Character not found' });
      }

      return res.json({ character: legacyResult[0].character });
    }

    const char = result[0].character;
    const hasAvatars = char?.avatars && Object.keys(char.avatars).length > 0;
    const hasPhotos = char?.photos && Object.keys(char.photos).length > 0;
    const hasPhotoUrl = !!char?.photo_url;
    console.log(`[Characters] GET /${characterId}/full - Loaded: avatars=${hasAvatars}, photos=${hasPhotos}, photo_url=${hasPhotoUrl}, avatarKeys=[${hasAvatars ? Object.keys(char.avatars).join(',') : ''}]`);
    res.json({ character: char });
  } catch (err) {
    console.error('Error fetching full character data:', err);
    res.status(500).json({ error: 'Failed to fetch character data' });
  }
});

// POST /api/characters - Save user's characters
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { characters, relationships, relationshipTexts, customRelationships, customStrengths, customWeaknesses, customFears } = req.body;

    console.log(`[Characters] POST - Saving ${characters?.length || 0} characters for user.id: ${req.user.id}`);

    // IMPORTANT: Strip avatar data from frontend input - avatars are backend-only
    // This prevents the frontend from accidentally overwriting avatar data
    const charactersWithoutAvatars = (characters || []).map(char => {
      const { avatars, ...charWithoutAvatars } = char;
      if (avatars) {
        console.log(`[Characters] POST - Stripping frontend avatars for ${char.name}`);
      }
      return charWithoutAvatars;
    });

    if (isDatabaseMode()) {
      // Use UPSERT to atomically update or insert character data
      // We use a stable ID per user to ensure only one record exists
      const characterId = `characters_${req.user.id}`;
      console.log(`[Characters] POST - Using characterId: ${characterId}`);

      // Use transaction with row lock to prevent race conditions with avatar job
      await dbQuery('BEGIN');

      // Lock the row and read FULL data in one query (DB-first approach)
      // This ensures we always start with the latest DB state including full avatars
      const lockAndReadQuery = `SELECT data FROM characters WHERE id = $1 FOR UPDATE`;
      const dbResult = await dbQuery(lockAndReadQuery, [characterId]);
      const currentDbData = dbResult[0]?.data || { characters: [] };
      const dbCharacters = currentDbData.characters || [];

      // Debug: show what avatars we found in DB (from full data column, not JSONB extraction)
      for (const dbChar of dbCharacters) {
        const avatarKeys = dbChar.avatars ? Object.keys(dbChar.avatars) : [];
        const hasStandard = dbChar.avatars?.standard ? dbChar.avatars.standard.length : 0;
        console.log(`[Characters] POST - DB-first found id=${dbChar.id} name=${dbChar.name}: avatarKeys=[${avatarKeys.join(',')}], standardLen=${hasStandard}`);
      }
      console.log(`[Characters] POST - DB has ${dbCharacters.length} characters, frontend sending ${charactersWithoutAvatars.length}`)

      // Merge server-side data from existing characters into new characters
      // This preserves avatar data AND character fields that may not be sent by the frontend
      // NOTE: We use charactersWithoutAvatars - frontend avatars have been stripped
      let preservedCount = 0;
      const mergedCharacters = (charactersWithoutAvatars || []).map(newChar => {
        // Compare IDs as strings to handle type mismatch (SQL returns string, frontend sends number)
        const newCharIdStr = String(newChar.id);
        const existingChar = dbCharacters.find(c => String(c.id) === newCharIdStr || c.name === newChar.name);
        if (!existingChar) {
          console.log(`[Characters] POST - No existing DB data found for ${newChar.name} (id: ${newChar.id})`);
          return newChar;
        }

        let hasChanges = false;
        let mergedChar = { ...newChar };

        // Preserve character-level fields that may be missing from frontend
        // These are fields that get lost if frontend doesn't explicitly send them

        const preservedFields = [];

        // Preserve height from physical traits if not in new data
        if (existingChar.height && !newChar.height) {
          mergedChar.height = existingChar.height;
          preservedFields.push('height');
          hasChanges = true;
        }

        // Preserve apparent_age if not in new data
        if (existingChar.apparent_age && !newChar.apparent_age) {
          mergedChar.apparent_age = existingChar.apparent_age;
          preservedFields.push('apparent_age');
          hasChanges = true;
        }

        // Preserve physical traits that may be missing
        if (existingChar.build && !newChar.build) {
          mergedChar.build = existingChar.build;
          preservedFields.push('build');
          hasChanges = true;
        }

        // Preserve eye_color if not in new data
        if (existingChar.eye_color && !newChar.eye_color) {
          mergedChar.eye_color = existingChar.eye_color;
          preservedFields.push('eye_color');
          hasChanges = true;
        }

        // Preserve hair_color if not in new data
        if (existingChar.hair_color && !newChar.hair_color) {
          mergedChar.hair_color = existingChar.hair_color;
          preservedFields.push('hair_color');
          hasChanges = true;
        }

        // Preserve hair_style if not in new data
        if (existingChar.hair_style && !newChar.hair_style) {
          mergedChar.hair_style = existingChar.hair_style;
          preservedFields.push('hair_style');
          hasChanges = true;
        }

        // Preserve other_features if not in new data
        if (existingChar.other_features && !newChar.other_features) {
          mergedChar.other_features = existingChar.other_features;
          preservedFields.push('other_features');
          hasChanges = true;
        }

        // Preserve 'other' field (glasses, etc.) if not in new data
        if (existingChar.other && !newChar.other) {
          mergedChar.other = existingChar.other;
          preservedFields.push('other');
          hasChanges = true;
        }

        // Preserve hair_length (extracted from photo analysis)
        if (existingChar.hair_length && !newChar.hair_length) {
          mergedChar.hair_length = existingChar.hair_length;
          preservedFields.push('hair_length');
          hasChanges = true;
        }

        // Preserve skin_tone (extracted from photo analysis)
        if (existingChar.skin_tone && !newChar.skin_tone) {
          mergedChar.skin_tone = existingChar.skin_tone;
          preservedFields.push('skin_tone');
          hasChanges = true;
        }

        // Preserve skin_tone_hex (extracted from photo analysis)
        if (existingChar.skin_tone_hex && !newChar.skin_tone_hex) {
          mergedChar.skin_tone_hex = existingChar.skin_tone_hex;
          preservedFields.push('skin_tone_hex');
          hasChanges = true;
        }

        // Preserve facial_hair (extracted from photo analysis)
        if (existingChar.facial_hair && !newChar.facial_hair) {
          mergedChar.facial_hair = existingChar.facial_hair;
          preservedFields.push('facial_hair');
          hasChanges = true;
        }

        // Preserve detailed_hair_analysis (extracted from photo analysis)
        if (existingChar.detailed_hair_analysis && !newChar.detailed_hair_analysis) {
          mergedChar.detailed_hair_analysis = existingChar.detailed_hair_analysis;
          preservedFields.push('detailed_hair_analysis');
          hasChanges = true;
        }

        // Preserve clothing data (legacy text field)
        if (existingChar.clothing && !newChar.clothing) {
          mergedChar.clothing = existingChar.clothing;
          preservedFields.push('clothing');
          hasChanges = true;
        }

        // Preserve structured_clothing (new structured format with upperBody, lowerBody, shoes, fullBody)
        const existingClothing = existingChar.structured_clothing;
        const newClothing = newChar.structured_clothing;
        const newClothingEmpty = !newClothing || (typeof newClothing === 'object' && Object.keys(newClothing).length === 0);

        if (existingClothing && newClothingEmpty) {
          // Frontend sent empty/no clothing - preserve from DB
          mergedChar.structured_clothing = existingClothing;
          preservedFields.push('structured_clothing');
          hasChanges = true;
        } else if (existingClothing && !newClothingEmpty) {
          // Frontend sent clothing - check if it has actual values or just nulls
          const hasRealValues = newClothing.upperBody || newClothing.lowerBody || newClothing.fullBody || newClothing.shoes;
          if (!hasRealValues) {
            // Frontend sent structured_clothing but all fields are empty - preserve from DB
            mergedChar.structured_clothing = existingClothing;
            preservedFields.push('structured_clothing');
            hasChanges = true;
            console.log(`[Characters] POST - Frontend sent empty structured_clothing for ${newChar.name}, preserving from DB`);
          } else {
            // Frontend sent real values - use those
            mergedChar.structured_clothing = newClothing;
            console.log(`[Characters] POST - Using frontend structured_clothing for ${newChar.name}`);
          }
        }

        // Preserve physical traits object (contains height, skinTone, eyeColor, hairColor, etc.)
        const existingPhysical = existingChar.physical || {};
        const newPhysical = newChar.physical || {};
        const newPhysicalEmpty = Object.keys(newPhysical).length === 0 ||
          !Object.values(newPhysical).some(v => v !== null && v !== undefined && v !== '');

        if (Object.keys(existingPhysical).length > 0 && newPhysicalEmpty) {
          // Frontend sent empty physical - preserve from DB
          mergedChar.physical = existingPhysical;
          preservedFields.push('physical');
          hasChanges = true;
        } else if (Object.keys(existingPhysical).length > 0) {
          // Merge physical traits - keep existing values for any missing/empty fields in new
          const merged = { ...existingPhysical };
          for (const [key, value] of Object.entries(newPhysical)) {
            // Only use new value if it's truthy (not null, undefined, or empty string)
            if (value !== null && value !== undefined && value !== '') {
              merged[key] = value;
            }
          }
          mergedChar.physical = merged;
        }

        // Preserve photos object (contains face, original, bodyNoBg URLs)
        if (existingChar.photos && !newChar.photos) {
          mergedChar.photos = existingChar.photos;
          preservedFields.push('photos');
          hasChanges = true;
        } else if (existingChar.photos && newChar.photos) {
          // Merge photos - keep existing values, only overwrite with non-null new values
          // This prevents failed photo analysis from wiping out existing photos
          const mergedPhotos = { ...existingChar.photos };
          for (const [key, value] of Object.entries(newChar.photos)) {
            if (value !== null && value !== undefined) {
              mergedPhotos[key] = value;
            }
          }
          mergedChar.photos = mergedPhotos;
        }

        // Preserve photo data if not sent (reduces payload by 10-15MB)
        // Photos are large base64 data URLs that don't need to be re-uploaded every save
        if (existingChar.photo_url && !newChar.photo_url) {
          mergedChar.photo_url = existingChar.photo_url;
          preservedFields.push('photo_url');
          hasChanges = true;
        }
        if (existingChar.thumbnail_url && !newChar.thumbnail_url) {
          mergedChar.thumbnail_url = existingChar.thumbnail_url;
          preservedFields.push('thumbnail_url');
          hasChanges = true;
        }
        if (existingChar.body_photo_url && !newChar.body_photo_url) {
          mergedChar.body_photo_url = existingChar.body_photo_url;
          preservedFields.push('body_photo_url');
          hasChanges = true;
        }
        if (existingChar.body_no_bg_url && !newChar.body_no_bg_url) {
          mergedChar.body_no_bg_url = existingChar.body_no_bg_url;
          preservedFields.push('body_no_bg_url');
          hasChanges = true;
        }

        // Preserve storyRole if not in new data (set via PUT /roles endpoint)
        if (existingChar.storyRole && !newChar.storyRole) {
          mergedChar.storyRole = existingChar.storyRole;
          preservedFields.push('storyRole');
          hasChanges = true;
        }

        if (preservedFields.length > 0) {
          console.log(`[Characters] POST - Preserving fields for ${newChar.name}: ${preservedFields.join(', ')}`);
        }

        // Avatar data is managed ONLY by backend (avatar generation saves directly to DB)
        // Frontend avatars are IGNORED - DB is the single source of truth
        if (!existingChar.avatars) {
          // No DB avatars yet - that's fine, character may not have generated avatars
          if (hasChanges) preservedCount++;
          return mergedChar;
        }

        // Use ONLY DB avatars - never use frontend avatars
        const avatarKeys = Object.keys(existingChar.avatars);
        const hasStandard = !!existingChar.avatars.standard;
        const standardLen = existingChar.avatars.standard ? existingChar.avatars.standard.length : 0;
        console.log(`[Characters] POST - DB avatars for ${newChar.name}: keys=[${avatarKeys.join(',')}], hasStandard=${hasStandard}, len=${standardLen}`);
        preservedCount++;
        return {
          ...mergedChar,
          avatars: existingChar.avatars
        };
      });
      if (preservedCount > 0) {
        console.log(`[Characters] POST - Preserved data for ${preservedCount} characters`);
      }

      // Store character data as an object with all related information
      const characterData = {
        characters: mergedCharacters,
        relationships: relationships || {},
        relationshipTexts: relationshipTexts || {},
        customRelationships: customRelationships || [],
        customStrengths: customStrengths || [],
        customWeaknesses: customWeaknesses || [],
        customFears: customFears || []
      };

      // Generate lightweight metadata for fast list queries
      // Strip ALL heavy fields - list view only needs basic info + one thumbnail for display
      const lightCharacters = mergedCharacters.map(char => {
        // Strip heavy base64 fields (including photos object which contains face, original, bodyNoBg)
        const { body_no_bg_url, body_photo_url, photo_url, thumbnail_url, clothing_avatars, photos, ...lightChar } = char;
        // Keep avatar metadata + only 'standard' faceThumbnail for list display
        if (lightChar.avatars) {
          const standardThumb = lightChar.avatars.faceThumbnails?.standard;
          lightChar.avatars = {
            status: lightChar.avatars.status,
            stale: lightChar.avatars.stale,
            generatedAt: lightChar.avatars.generatedAt,
            hasFullAvatars: !!(lightChar.avatars.winter || lightChar.avatars.standard || lightChar.avatars.summer || lightChar.avatars.formal),
            // Keep only standard thumbnail for list view (~70KB per char instead of 273KB)
            faceThumbnails: standardThumb ? { standard: standardThumb } : undefined,
            // Keep clothing descriptions (small text, needed for display and preservation)
            clothing: lightChar.avatars.clothing
          };
        }
        return lightChar;
      });

      const metadataObj = {
        characters: lightCharacters,
        relationships: relationships || {},
        relationshipTexts: relationshipTexts || {},
        customRelationships: customRelationships || [],
        customStrengths: customStrengths || [],
        customWeaknesses: customWeaknesses || [],
        customFears: customFears || []
      };

      // Debug: check if avatars and photos are in characterData
      for (const char of characterData.characters) {
        const avatarKeys = char.avatars ? Object.keys(char.avatars) : [];
        const hasPhotos = char.photos && Object.keys(char.photos).length > 0;
        const hasPhotoUrl = !!char.photo_url;
        console.log(`[Characters] POST - Final ${char.name}: avatarKeys=[${avatarKeys.join(',')}], photos=${hasPhotos}, photo_url=${hasPhotoUrl}`);
      }

      const jsonData = JSON.stringify(characterData);
      const metadataJson = JSON.stringify(metadataObj);
      const jsonSizeMB = (jsonData.length / 1024 / 1024).toFixed(2);
      const metaSizeKB = (metadataJson.length / 1024).toFixed(0);
      console.log(`[Characters] POST - Full data: ${jsonSizeMB} MB, Metadata: ${metaSizeKB} KB`);

      // Debug: verify data vs metadata column content before save
      for (const char of characterData.characters) {
        const dataAvatarKeys = char.avatars ? Object.keys(char.avatars) : [];
        const dataStandardLen = char.avatars?.standard ? char.avatars.standard.length : 0;
        console.log(`[Characters] POST - data column ${char.name}: avatarKeys=[${dataAvatarKeys.join(',')}], standardLen=${dataStandardLen}`);
      }
      for (const char of metadataObj.characters) {
        const metaAvatarKeys = char.avatars ? Object.keys(char.avatars) : [];
        console.log(`[Characters] POST - metadata column ${char.name}: avatarKeys=[${metaAvatarKeys.join(',')}]`);
      }

      const upsertQuery = `
        INSERT INTO characters (id, user_id, data, metadata, created_at)
        VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
        ON CONFLICT (id) DO UPDATE SET
          data = EXCLUDED.data,
          metadata = EXCLUDED.metadata,
          created_at = CURRENT_TIMESTAMP
      `;

      try {
        await dbQuery(upsertQuery, [characterId, req.user.id, jsonData, metadataJson]);
        console.log(`[Characters] POST - Database upsert successful`);

        // Commit the transaction (releases the row lock)
        await dbQuery('COMMIT');
        console.log(`[Characters] POST - Transaction committed`);
      } catch (dbErr) {
        // Rollback on any error
        await dbQuery('ROLLBACK');
        console.error(`[Characters] POST - Database upsert FAILED, rolled back:`, dbErr.message);
        throw dbErr;
      }

      // Clean up orphaned rows from photo uploads (numeric IDs from Date.now())
      // Only delete rows with numeric IDs or old format IDs - preserve the main characters_X row
      const cleanupQuery = `
        DELETE FROM characters
        WHERE user_id = $1
          AND id != $2
          AND (id ~ '^[0-9]+$' OR id LIKE 'characters_%_%')
      `;
      const cleanupResult = await dbQuery(cleanupQuery, [req.user.id, characterId]);
      if (cleanupResult.rowCount > 0) {
        console.log(`[Characters] POST - Cleaned up ${cleanupResult.rowCount} orphaned/legacy rows for user ${req.user.id}`);
      }
    } else {
      return res.status(501).json({ error: 'File storage mode not supported' });
    }

    await logActivity(req.user.id, req.user.username, 'CHARACTERS_SAVED', { count: charactersWithoutAvatars.length });
    res.json({ message: 'Characters saved successfully', count: charactersWithoutAvatars.length });
  } catch (err) {
    // Attempt ROLLBACK in case transaction was started but not committed
    try {
      await dbQuery('ROLLBACK');
    } catch (rollbackErr) {
      // Ignore rollback errors - transaction may not have been started
    }
    console.error('Error saving characters:', err);
    res.status(500).json({ error: 'Failed to save characters' });
  }
});

// DELETE /api/characters/avatars/styled - Clear styled/costumed avatar data (admin only)
// Keeps base clothing avatars (winter, standard, summer, formal)
// Only removes styledAvatars and costumed which are the bulk of the data
// NOTE: Must be defined BEFORE /:characterId to avoid route conflict
router.delete('/avatars/styled', authenticateToken, async (req, res) => {
  try {
    // Admin only
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    console.log(`[Characters] DELETE /avatars/styled - Admin ${req.user.id} clearing styled/costumed avatars`);

    if (!isDatabaseMode()) {
      return res.status(501).json({ error: 'File storage mode not supported' });
    }

    // Fetch current character data
    const rowId = `characters_${req.user.id}`;
    const rows = await dbQuery('SELECT data FROM characters WHERE id = $1', [rowId]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'No character data found' });
    }

    const data = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;
    const characters = data.characters || [];

    let clearedCount = 0;
    let totalSizeCleared = 0;
    let styledCount = 0;
    let costumedCount = 0;

    for (const char of characters) {
      if (char.avatars) {
        let charCleared = false;

        // Clear styledAvatars (art-style converted avatars like Pixar, watercolor)
        if (char.avatars.styledAvatars) {
          const styledJson = JSON.stringify(char.avatars.styledAvatars);
          totalSizeCleared += styledJson.length;
          styledCount += Object.keys(char.avatars.styledAvatars).length;
          console.log(`  Clearing styledAvatars for ${char.name}: ${Object.keys(char.avatars.styledAvatars).join(', ')}`);
          delete char.avatars.styledAvatars;
          charCleared = true;
        }

        // Clear costumed avatars (Cowboy, Pirate, etc.)
        if (char.avatars.costumed) {
          const costumedJson = JSON.stringify(char.avatars.costumed);
          totalSizeCleared += costumedJson.length;
          costumedCount += Object.keys(char.avatars.costumed).length;
          console.log(`  Clearing costumed for ${char.name}: ${Object.keys(char.avatars.costumed).join(', ')}`);
          delete char.avatars.costumed;
          charCleared = true;
        }

        if (charCleared) clearedCount++;
      }
    }

    // Save updated data
    await dbQuery('UPDATE characters SET data = $1 WHERE id = $2', [JSON.stringify(data), rowId]);

    const sizeMB = (totalSizeCleared / 1024 / 1024).toFixed(2);
    console.log(`[Characters] DELETE /avatars/styled - Cleared ${styledCount} styled + ${costumedCount} costumed avatars from ${clearedCount} characters, ${sizeMB}MB`);

    res.json({
      success: true,
      message: `Cleared ${styledCount} styled + ${costumedCount} costumed avatars from ${clearedCount} characters`,
      clearedSizeMB: parseFloat(sizeMB),
      styledCount,
      costumedCount
    });
  } catch (err) {
    console.error('Error clearing styled avatars:', err);
    res.status(500).json({ error: 'Failed to clear styled avatars' });
  }
});

// DELETE /api/characters/:characterId - Delete a single character
// Uses PostgreSQL JSONB functions to avoid loading entire data blob into Node.js
router.delete('/:characterId', authenticateToken, async (req, res) => {
  try {
    const characterIdToDelete = parseInt(req.params.characterId, 10);
    if (isNaN(characterIdToDelete)) {
      return res.status(400).json({ error: 'Invalid character ID' });
    }

    console.log(`[Characters] DELETE - User ${req.user.id} deleting character ${characterIdToDelete}`);

    if (!isDatabaseMode()) {
      return res.status(501).json({ error: 'File storage mode not supported' });
    }

    const rowId = `characters_${req.user.id}`;

    // First, get ONLY the character name (not the full data blob)
    const nameResult = await dbQuery(`
      SELECT c.elem->>'name' as name
      FROM characters,
           jsonb_array_elements(data->'characters') WITH ORDINALITY AS c(elem, idx)
      WHERE id = $1
        AND (c.elem->>'id')::bigint = $2
    `, [rowId, characterIdToDelete]);

    if (nameResult.length === 0) {
      return res.status(404).json({ error: 'Character not found' });
    }

    const deletedCharName = nameResult[0].name;

    // Use PostgreSQL to filter out the character and clean relationships IN-PLACE
    // Update both data AND metadata columns
    const updateResult = await dbQuery(`
      UPDATE characters
      SET data = jsonb_build_object(
        'characters', COALESCE(
          (SELECT jsonb_agg(c)
           FROM jsonb_array_elements(data->'characters') c
           WHERE (c->>'id')::bigint != $2),
          '[]'::jsonb
        ),
        'relationships', COALESCE(
          (SELECT jsonb_object_agg(key, value)
           FROM jsonb_each(data->'relationships')
           WHERE key NOT LIKE '%' || $2::text || '-%'
             AND key NOT LIKE '%-' || $2::text),
          '{}'::jsonb
        ),
        'relationshipTexts', COALESCE(
          (SELECT jsonb_object_agg(key, value)
           FROM jsonb_each(data->'relationshipTexts')
           WHERE key NOT LIKE '%' || $2::text || '-%'
             AND key NOT LIKE '%-' || $2::text),
          '{}'::jsonb
        ),
        'customRelationships', COALESCE(data->'customRelationships', '[]'::jsonb),
        'customStrengths', COALESCE(data->'customStrengths', '[]'::jsonb),
        'customWeaknesses', COALESCE(data->'customWeaknesses', '[]'::jsonb),
        'customFears', COALESCE(data->'customFears', '[]'::jsonb)
      ),
      metadata = jsonb_build_object(
        'characters', COALESCE(
          (SELECT jsonb_agg(c)
           FROM jsonb_array_elements(metadata->'characters') c
           WHERE (c->>'id')::bigint != $2),
          '[]'::jsonb
        ),
        'relationships', COALESCE(
          (SELECT jsonb_object_agg(key, value)
           FROM jsonb_each(metadata->'relationships')
           WHERE key NOT LIKE '%' || $2::text || '-%'
             AND key NOT LIKE '%-' || $2::text),
          '{}'::jsonb
        ),
        'relationshipTexts', COALESCE(
          (SELECT jsonb_object_agg(key, value)
           FROM jsonb_each(metadata->'relationshipTexts')
           WHERE key NOT LIKE '%' || $2::text || '-%'
             AND key NOT LIKE '%-' || $2::text),
          '{}'::jsonb
        ),
        'customRelationships', COALESCE(metadata->'customRelationships', '[]'::jsonb),
        'customStrengths', COALESCE(metadata->'customStrengths', '[]'::jsonb),
        'customWeaknesses', COALESCE(metadata->'customWeaknesses', '[]'::jsonb),
        'customFears', COALESCE(metadata->'customFears', '[]'::jsonb)
      )
      WHERE id = $1
      RETURNING jsonb_array_length(data->'characters') as remaining_count
    `, [rowId, characterIdToDelete]);

    const remainingCount = updateResult[0]?.remaining_count || 0;

    await logActivity(req.user.id, req.user.username, 'CHARACTER_DELETED', {
      characterId: characterIdToDelete,
      characterName: deletedCharName,
      remainingCount
    });

    console.log(`[Characters] DELETE - Successfully deleted character ${characterIdToDelete} (${deletedCharName}) - ${remainingCount} remaining`);
    res.json({
      success: true,
      message: `Character "${deletedCharName}" deleted`,
      remainingCount
    });
  } catch (err) {
    console.error('Error deleting character:', err);
    res.status(500).json({ error: 'Failed to delete character' });
  }
});

module.exports = router;
