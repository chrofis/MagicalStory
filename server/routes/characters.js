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
    const includeAllAvatars = req.query.includeAllAvatars === 'true' && req.user.role === 'admin';

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
      // Query by user_id and get the row with the most data (handles legacy ID formats)
      // Legacy format: characters_{user_id}_{timestamp}
      // Current format: characters_{user_id}
      const selectQuery = `
        SELECT data FROM characters
        WHERE user_id = $1
        ORDER BY LENGTH(data) DESC
        LIMIT 1
      `;
      const rows = await dbQuery(selectQuery, [req.user.id]);
      console.log(`[Characters] GET - Found ${rows.length} rows for user_id: ${req.user.id}, includeAllAvatars: ${includeAllAvatars}`);

      if (rows.length > 0) {
        const data = JSON.parse(rows[0].data);
        console.log(`[Characters] GET - Parsed data keys: ${Object.keys(data).join(', ')}`);
        console.log(`[Characters] GET - Characters count in data: ${Array.isArray(data) ? data.length : (data.characters?.length || 0)}`);
        // Handle both old format (array) and new format (object)
        if (Array.isArray(data)) {
          characterData.characters = data;
        } else {
          characterData = {
            ...characterData,
            ...data
          };
        }
        console.log(`[Characters] GET - Final characters count: ${characterData.characters.length}`);

        // Strip heavy avatar data for non-dev users to reduce payload
        // Normal users only see 'standard' avatar in the UI
        if (!includeAllAvatars) {
          let strippedSize = 0;
          characterData.characters = characterData.characters.map(char => {
            if (!char.avatars) return char;

            // Calculate stripped size for logging
            const fullAvatarsJson = JSON.stringify(char.avatars);

            // Keep only essential avatar data
            const lightAvatars = {
              standard: char.avatars.standard,
              status: char.avatars.status,
              stale: char.avatars.stale,
              generatedAt: char.avatars.generatedAt
            };

            const lightAvatarsJson = JSON.stringify(lightAvatars);
            strippedSize += fullAvatarsJson.length - lightAvatarsJson.length;

            return {
              ...char,
              avatars: lightAvatars
            };
          });
          if (strippedSize > 0) {
            console.log(`[Characters] GET - Stripped ${(strippedSize / 1024 / 1024).toFixed(2)} MB of avatar data for normal user`);
          }
        } else {
          // Debug: Check for styled avatars (dev mode)
          for (const char of characterData.characters) {
            if (char.avatars?.styledAvatars) {
              const styles = Object.keys(char.avatars.styledAvatars);
              console.log(`[Characters] GET - ${char.name} has styledAvatars for: ${styles.join(', ')}`);
            }
          }
        }
      }
    } else {
      return res.status(501).json({ error: 'File storage mode not supported' });
    }

    await logActivity(req.user.id, req.user.username, 'CHARACTERS_LOADED', { count: characterData.characters.length });
    res.json(characterData);
  } catch (err) {
    console.error('Error fetching characters:', err);
    res.status(500).json({ error: 'Failed to fetch characters' });
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

      // First, fetch existing data to preserve server-side additions (like styledAvatars)
      const existingRows = await dbQuery('SELECT data FROM characters WHERE id = $1', [characterId]);
      let existingCharacters = [];
      if (existingRows.length > 0) {
        const existingData = JSON.parse(existingRows[0].data);
        existingCharacters = existingData.characters || [];
      }

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

        // Preserve clothing data (structured clothing details)
        if (existingChar.clothing && !newChar.clothing) {
          mergedChar.clothing = existingChar.clothing;
          preservedFields.push('clothing');
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

      const jsonData = JSON.stringify(characterData);

      const upsertQuery = `
        INSERT INTO characters (id, user_id, data, created_at)
        VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
        ON CONFLICT (id) DO UPDATE SET
          data = EXCLUDED.data,
          created_at = CURRENT_TIMESTAMP
      `;
      await dbQuery(upsertQuery, [characterId, req.user.id, jsonData]);

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

module.exports = router;
