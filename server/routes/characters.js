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
      const selectQuery = 'SELECT data FROM characters WHERE user_id = $1 ORDER BY id DESC LIMIT 1';
      const rows = await dbQuery(selectQuery, [req.user.id]);

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

    if (isDatabaseMode()) {
      // Delete old characters and insert new ones
      const deleteQuery = 'DELETE FROM characters WHERE user_id = $1';
      await dbQuery(deleteQuery, [req.user.id]);

      // Insert character data as a single record with all information
      const characterId = `characters_${req.user.id}_${Date.now()}`;
      const insertQuery = 'INSERT INTO characters (id, user_id, data) VALUES ($1, $2, $3)';
      await dbQuery(insertQuery, [characterId, req.user.id, JSON.stringify(characterData)]);
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
