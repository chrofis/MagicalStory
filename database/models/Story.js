// Story Model
const db = require('../config');

class Story {
  /**
   * Create a new story
   */
  static async create(userId, storyData) {
    const {
      title,
      storyType,
      artStyle,
      pages,
      languageLevel,
      outline,
      storyText,
      characters,
      sceneDescriptions,
      sceneImages,
      characterManifest
    } = storyData;

    const sql = `
      INSERT INTO stories (
        user_id, title, story_type, art_style, pages, language_level,
        outline, story_text, characters, scene_descriptions, scene_images,
        character_manifest
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const result = await db.query(sql, [
      userId,
      title,
      storyType,
      artStyle,
      pages,
      languageLevel || null,
      outline || null,
      storyText || null,
      JSON.stringify(characters || []),
      JSON.stringify(sceneDescriptions || []),
      JSON.stringify(sceneImages || []),
      JSON.stringify(characterManifest || null)
    ]);

    return await Story.findById(result.insertId);
  }

  /**
   * Find story by ID
   */
  static async findById(id) {
    const sql = 'SELECT * FROM stories WHERE id = ?';
    const results = await db.query(sql, [id]);

    if (results.length === 0) return null;

    return Story._formatStory(results[0]);
  }

  /**
   * Find all stories for a user
   */
  static async findByUserId(userId, limit = 100, offset = 0) {
    const sql = `
      SELECT * FROM stories
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `;
    const results = await db.query(sql, [userId, limit, offset]);

    return results.map(story => Story._formatStory(story));
  }

  /**
   * Update story
   */
  static async update(id, storyData) {
    const allowedFields = {
      title: 'title',
      storyType: 'story_type',
      artStyle: 'art_style',
      pages: 'pages',
      languageLevel: 'language_level',
      outline: 'outline',
      storyText: 'story_text',
      characters: 'characters',
      sceneDescriptions: 'scene_descriptions',
      sceneImages: 'scene_images',
      characterManifest: 'character_manifest'
    };

    const updates = [];
    const values = [];

    for (const [jsField, dbField] of Object.entries(allowedFields)) {
      if (storyData[jsField] !== undefined) {
        updates.push(`${dbField} = ?`);

        // JSON fields need to be stringified
        if (['characters', 'sceneDescriptions', 'sceneImages', 'characterManifest'].includes(jsField)) {
          values.push(JSON.stringify(storyData[jsField]));
        } else {
          values.push(storyData[jsField]);
        }
      }
    }

    if (updates.length === 0) return null;

    values.push(id);
    const sql = `UPDATE stories SET ${updates.join(', ')} WHERE id = ?`;
    await db.query(sql, values);

    return await Story.findById(id);
  }

  /**
   * Delete story
   */
  static async delete(id) {
    const sql = 'DELETE FROM stories WHERE id = ?';
    const result = await db.query(sql, [id]);
    return result.affectedRows > 0;
  }

  /**
   * Delete all stories for a user
   */
  static async deleteByUserId(userId) {
    const sql = 'DELETE FROM stories WHERE user_id = ?';
    const result = await db.query(sql, [userId]);
    return result.affectedRows;
  }

  /**
   * Count stories for a user
   */
  static async countByUserId(userId) {
    const sql = 'SELECT COUNT(*) as count FROM stories WHERE user_id = ?';
    const results = await db.query(sql, [userId]);
    return results[0].count;
  }

  /**
   * Format story data (parse JSON fields)
   */
  static _formatStory(story) {
    return {
      id: story.id,
      title: story.title,
      storyType: story.story_type,
      artStyle: story.art_style,
      pages: story.pages,
      languageLevel: story.language_level,
      outline: story.outline,
      story: story.story_text,
      characters: JSON.parse(story.characters || '[]'),
      sceneDescriptions: JSON.parse(story.scene_descriptions || '[]'),
      sceneImages: JSON.parse(story.scene_images || '[]'),
      characterManifest: JSON.parse(story.character_manifest || 'null'),
      createdAt: story.created_at,
      updatedAt: story.updated_at
    };
  }
}

module.exports = Story;
