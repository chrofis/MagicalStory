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
router.get('/', authenticateToken, async (req, res) => {
  try {
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
      // Use the same ID format as the UPSERT to ensure we get the correct record
      const characterId = `characters_${req.user.id}`;
      const selectQuery = 'SELECT data FROM characters WHERE id = $1';
      const rows = await dbQuery(selectQuery, [characterId]);

      if (rows.length > 0) {
        const data = JSON.parse(rows[0].data);
        // DEBUG: Log what's in the database with full details
        console.log(`[LOAD DB] saveId: ${data._saveId || 'unknown'}, savedAt: ${data._savedAt || 'unknown'}`);
        console.log('[LOAD DB] Characters data:', (data.characters || []).map(c => ({
          name: c.name,
          // Physical traits (direct fields)
          eyeColor: c.eye_color,
          hairColor: c.hair_color,
          hairStyle: c.hair_style,
          build: c.build,
          // Avatars with clothing
          hasClothingAvatars: !!c.clothing_avatars,
          hasClothing: !!c.clothing_avatars?.clothing,
          clothingKeys: c.clothing_avatars?.clothing ? Object.keys(c.clothing_avatars.clothing) : [],
          avatarStatus: c.clothing_avatars?.status,
        })));
        // Handle both old format (array) and new format (object)
        if (Array.isArray(data)) {
          characterData.characters = data;
        } else {
          characterData = {
            ...characterData,
            ...data
          };
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

    // Generate unique save ID for tracing
    const saveId = Date.now().toString(36) + Math.random().toString(36).substring(2, 6);

    // DEBUG: Log what's being saved with full physical traits info
    console.log(`[SAVE ${saveId}] Characters data:`, (characters || []).map(c => ({
      name: c.name,
      // Physical traits (direct fields)
      eyeColor: c.eye_color,
      hairColor: c.hair_color,
      hairStyle: c.hair_style,
      build: c.build,
      // Avatars with clothing
      hasClothingAvatars: !!c.clothing_avatars,
      hasClothing: !!c.clothing_avatars?.clothing,
      clothingKeys: c.clothing_avatars?.clothing ? Object.keys(c.clothing_avatars.clothing) : [],
      avatarStatus: c.clothing_avatars?.status,
    })));

    // Store character data as an object with all related information
    const characterData = {
      characters: characters || [],
      relationships: relationships || {},
      relationshipTexts: relationshipTexts || {},
      customRelationships: customRelationships || [],
      customStrengths: customStrengths || [],
      customWeaknesses: customWeaknesses || [],
      customFears: customFears || [],
      _saveId: saveId,  // Track which save this is
      _savedAt: new Date().toISOString()
    };

    if (isDatabaseMode()) {
      // Use UPSERT to atomically update or insert character data
      // We use a stable ID per user to ensure only one record exists
      const characterId = `characters_${req.user.id}`;
      const jsonData = JSON.stringify(characterData);
      console.log(`[SAVE DB ${saveId}] Saving to database, characterId: ${characterId}, data size: ${jsonData.length} bytes`);

      const upsertQuery = `
        INSERT INTO characters (id, user_id, data, created_at)
        VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
        ON CONFLICT (id) DO UPDATE SET
          data = EXCLUDED.data,
          created_at = CURRENT_TIMESTAMP
      `;
      await dbQuery(upsertQuery, [characterId, req.user.id, jsonData]);
      console.log(`[SAVE DB ${saveId}] Database save completed successfully`);

      // VERIFICATION: Read back what we just saved to confirm it persisted
      const verifyQuery = 'SELECT data FROM characters WHERE id = $1';
      const verifyRows = await dbQuery(verifyQuery, [characterId]);
      if (verifyRows.length > 0) {
        const verifyData = JSON.parse(verifyRows[0].data);
        console.log(`[VERIFY ${saveId}] Read-back check:`, {
          savedId: verifyData._saveId,
          matches: verifyData._saveId === saveId,
          characters: (verifyData.characters || []).map(c => ({
            name: c.name,
            eyeColor: c.eye_color,
            hairColor: c.hair_color,
            hasClothing: !!c.clothing_avatars?.clothing,
          }))
        });
        if (verifyData._saveId !== saveId) {
          console.error(`[VERIFY ${saveId}] ⚠️ MISMATCH! Saved ${saveId} but read back ${verifyData._saveId}`);
        }
      } else {
        console.error(`[VERIFY ${saveId}] ⚠️ No data found after save!`);
      }
    } else {
      return res.status(501).json({ error: 'File storage mode not supported' });
    }

    await logActivity(req.user.id, req.user.username, 'CHARACTERS_SAVED', { count: characters.length });
    res.json({ message: 'Characters saved successfully', count: characters.length, saveId });
  } catch (err) {
    console.error('Error saving characters:', err);
    res.status(500).json({ error: 'Failed to save characters' });
  }
});

module.exports = router;
