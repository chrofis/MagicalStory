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

    // Fire and forget - don't block response for logging
    logActivity(req.user.id, req.user.username, 'CHARACTERS_LOADED', { count: characterData.characters.length }).catch(() => {});
    res.json(characterData);
  } catch (err) {
    console.error('Error fetching characters:', err);
    res.status(500).json({ error: 'Failed to fetch characters' });
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

    console.log(`[Characters] GET /${characterId}/full - Loaded full character data`);
    res.json({ character: result[0].character });
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

    if (isDatabaseMode()) {
      // Use UPSERT to atomically update or insert character data
      // We use a stable ID per user to ensure only one record exists
      const characterId = `characters_${req.user.id}`;
      console.log(`[Characters] POST - Using characterId: ${characterId}`);

      // Fetch ONLY the fields that need preserving (avatars, photos) - not entire 30MB blob
      // This query extracts just the preservation-relevant fields per character
      const preserveQuery = `
        SELECT jsonb_agg(
          jsonb_build_object(
            'id', c->>'id',
            'name', c->>'name',
            'avatars', c->'avatars',
            'photo_url', c->>'photo_url',
            'thumbnail_url', c->>'thumbnail_url',
            'body_photo_url', c->>'body_photo_url',
            'body_no_bg_url', c->>'body_no_bg_url',
            'height', c->>'height',
            'apparent_age', c->>'apparent_age',
            'build', c->>'build',
            'eye_color', c->>'eye_color',
            'hair_color', c->>'hair_color',
            'hair_style', c->>'hair_style',
            'other_features', c->>'other_features',
            'other', c->>'other',
            'clothing', c->'clothing'
          )
        ) as preserved
        FROM characters, jsonb_array_elements(data->'characters') c
        WHERE id = $1
      `;
      const preserveResult = await dbQuery(preserveQuery, [characterId]);
      const existingCharacters = preserveResult[0]?.preserved || [];

      // Merge server-side data from existing characters into new characters
      // This preserves avatar data AND character fields that may not be sent by the frontend
      let preservedCount = 0;
      const mergedCharacters = (characters || []).map(newChar => {
        const existingChar = existingCharacters.find(c => c.id === newChar.id || c.name === newChar.name);
        if (!existingChar) return newChar;

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

        // Preserve clothing data (legacy text field)
        if (existingChar.clothing && !newChar.clothing) {
          mergedChar.clothing = existingChar.clothing;
          preservedFields.push('clothing');
          hasChanges = true;
        }

        // Preserve structured_clothing (new structured format with upperBody, lowerBody, shoes, fullBody)
        if (existingChar.structured_clothing && !newChar.structured_clothing) {
          mergedChar.structured_clothing = existingChar.structured_clothing;
          preservedFields.push('structured_clothing');
          hasChanges = true;
        } else if (existingChar.structured_clothing && newChar.structured_clothing) {
          // Merge structured clothing - new values take precedence
          mergedChar.structured_clothing = {
            ...existingChar.structured_clothing,
            ...newChar.structured_clothing
          };
        }

        // Preserve physical traits object (contains height, skinTone, eyeColor, hairColor, etc.)
        if (existingChar.physical && !newChar.physical) {
          mergedChar.physical = existingChar.physical;
          preservedFields.push('physical');
          hasChanges = true;
        } else if (existingChar.physical && newChar.physical) {
          // Merge physical traits - keep existing values for any missing fields
          mergedChar.physical = { ...existingChar.physical, ...newChar.physical };
        }

        // Preserve photos object (contains face, original, bodyNoBg URLs)
        if (existingChar.photos && !newChar.photos) {
          mergedChar.photos = existingChar.photos;
          preservedFields.push('photos');
          hasChanges = true;
        } else if (existingChar.photos && newChar.photos) {
          // Merge photos - keep existing values for any missing fields
          mergedChar.photos = { ...existingChar.photos, ...newChar.photos };
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

        if (preservedFields.length > 0) {
          console.log(`[Characters] POST - Preserving fields for ${newChar.name}: ${preservedFields.join(', ')}`);
        }

        // Preserve clothing_avatars/avatars from existing if not sent
        if (!existingChar.avatars) {
          if (hasChanges) preservedCount++;
          return mergedChar;
        }

        const mergedAvatars = { ...newChar.avatars };

        // Preserve basic avatar variants (standard, winter, summer, formal) from database
        // These get stripped for non-dev users on GET, so we must preserve them on save
        const basicVariants = ['standard', 'winter', 'summer', 'formal'];
        for (const variant of basicVariants) {
          if (existingChar.avatars[variant] && !newChar.avatars?.[variant]) {
            mergedAvatars[variant] = existingChar.avatars[variant];
            hasChanges = true;
          }
        }

        // Preserve avatar metadata (faceMatch, clothing, prompts, rawEvaluation)
        if (existingChar.avatars.faceMatch && !newChar.avatars?.faceMatch) {
          mergedAvatars.faceMatch = existingChar.avatars.faceMatch;
        }
        if (existingChar.avatars.clothing && !newChar.avatars?.clothing) {
          mergedAvatars.clothing = existingChar.avatars.clothing;
        }
        if (existingChar.avatars.prompts && !newChar.avatars?.prompts) {
          mergedAvatars.prompts = existingChar.avatars.prompts;
        }
        if (existingChar.avatars.rawEvaluation && !newChar.avatars?.rawEvaluation) {
          mergedAvatars.rawEvaluation = existingChar.avatars.rawEvaluation;
        }

        // Preserve styledAvatars from database
        if (existingChar.avatars.styledAvatars) {
          const styles = Object.keys(existingChar.avatars.styledAvatars);
          console.log(`[Characters] POST - Preserving styledAvatars for ${newChar.name}: ${styles.join(', ')}`);
          // Deep merge styled avatars (including costumed sub-types)
          mergedAvatars.styledAvatars = {
            ...mergedAvatars.styledAvatars
          };
          for (const [styleKey, styleValue] of Object.entries(existingChar.avatars.styledAvatars)) {
            if (typeof styleValue === 'object' && styleValue !== null) {
              mergedAvatars.styledAvatars[styleKey] = {
                ...mergedAvatars.styledAvatars?.[styleKey],
                ...styleValue
              };
            }
          }
          hasChanges = true;
        }

        // Preserve costumed avatars from database (nested structure: { costumed: { pirate: "...", superhero: "..." } })
        if (existingChar.avatars.costumed) {
          const costumeTypes = Object.keys(existingChar.avatars.costumed);
          console.log(`[Characters] POST - Preserving costumed avatars for ${newChar.name}: ${costumeTypes.join(', ')}`);
          mergedAvatars.costumed = {
            ...mergedAvatars.costumed,
            ...existingChar.avatars.costumed
          };
          hasChanges = true;
        }

        // Preserve clothing descriptions for costumed
        if (existingChar.avatars.clothing?.costumed) {
          if (!mergedAvatars.clothing) mergedAvatars.clothing = {};
          mergedAvatars.clothing.costumed = {
            ...mergedAvatars.clothing?.costumed,
            ...existingChar.avatars.clothing.costumed
          };
          hasChanges = true;
        }

        // Preserve signatures
        if (existingChar.avatars.signatures) {
          mergedAvatars.signatures = {
            ...mergedAvatars.signatures,
            ...existingChar.avatars.signatures
          };
          hasChanges = true;
        }

        // Preserve faceThumbnails (extracted face crops with padding for display)
        if (existingChar.avatars.faceThumbnails && !newChar.avatars?.faceThumbnails) {
          mergedAvatars.faceThumbnails = existingChar.avatars.faceThumbnails;
          hasChanges = true;
        }

        if (hasChanges) {
          preservedCount++;
          return {
            ...mergedChar,
            avatars: mergedAvatars
          };
        }
        return mergedChar;
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
        // Strip heavy base64 fields
        const { body_no_bg_url, body_photo_url, photo_url, clothing_avatars, ...lightChar } = char;
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

      const jsonData = JSON.stringify(characterData);
      const metadataJson = JSON.stringify(metadataObj);
      const jsonSizeMB = (jsonData.length / 1024 / 1024).toFixed(2);
      const metaSizeKB = (metadataJson.length / 1024).toFixed(0);
      console.log(`[Characters] POST - Full data: ${jsonSizeMB} MB, Metadata: ${metaSizeKB} KB`);

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
      } catch (dbErr) {
        console.error(`[Characters] POST - Database upsert FAILED:`, dbErr.message);
        throw dbErr;
      }

      // Clean up legacy rows with old ID format (characters_{user_id}_{timestamp})
      const cleanupQuery = `
        DELETE FROM characters
        WHERE user_id = $1 AND id != $2
      `;
      const cleanupResult = await dbQuery(cleanupQuery, [req.user.id, characterId]);
      if (cleanupResult.rowCount > 0) {
        console.log(`[Characters] POST - Cleaned up ${cleanupResult.rowCount} legacy rows for user ${req.user.id}`);
      }
    } else {
      return res.status(501).json({ error: 'File storage mode not supported' });
    }

    await logActivity(req.user.id, req.user.username, 'CHARACTERS_SAVED', { count: characters.length });
    res.json({ message: 'Characters saved successfully', count: characters.length });
  } catch (err) {
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
