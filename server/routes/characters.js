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
      console.log(`[Characters] GET - Looking for characterId: ${characterId}, user.id: ${req.user.id}`);
      const selectQuery = 'SELECT data FROM characters WHERE id = $1';
      const rows = await dbQuery(selectQuery, [characterId]);
      console.log(`[Characters] GET - Found ${rows.length} rows`);

      if (rows.length > 0) {
        const data = JSON.parse(rows[0].data);
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

    // Store character data as an object with all related information
    const characterData = {
      characters: characters || [],
      relationships: relationships || {},
      relationshipTexts: relationshipTexts || {},
      customRelationships: customRelationships || [],
      customStrengths: customStrengths || [],
      customWeaknesses: customWeaknesses || [],
      customFears: customFears || []
    };

    console.log(`[Characters] POST - Saving ${characters?.length || 0} characters for user.id: ${req.user.id}`);

    if (isDatabaseMode()) {
      // Use UPSERT to atomically update or insert character data
      // We use a stable ID per user to ensure only one record exists
      const characterId = `characters_${req.user.id}`;
      console.log(`[Characters] POST - Using characterId: ${characterId}`);
      const jsonData = JSON.stringify(characterData);

      const upsertQuery = `
        INSERT INTO characters (id, user_id, data, created_at)
        VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
        ON CONFLICT (id) DO UPDATE SET
          data = EXCLUDED.data,
          created_at = CURRENT_TIMESTAMP
      `;
      await dbQuery(upsertQuery, [characterId, req.user.id, jsonData]);
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
