// Character Model
const db = require('../config');

class Character {
  /**
   * Create a new character
   */
  static async create(userId, characterData) {
    const {
      name,
      gender,
      age,
      photoUrl,
      height,
      build,
      hairColor,
      otherFeatures,
      strengths,
      weaknesses,
      fears,
      specialDetails
    } = characterData;

    const sql = `
      INSERT INTO characters (
        user_id, name, gender, age, photo_url, height, build, hair_color,
        other_features, strengths, weaknesses, fears, special_details
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const result = await db.query(sql, [
      userId,
      name,
      gender,
      age,
      photoUrl || null,
      height || null,
      build || null,
      hairColor || null,
      otherFeatures || null,
      JSON.stringify(strengths || []),
      JSON.stringify(weaknesses || []),
      JSON.stringify(fears || []),
      specialDetails || null
    ]);

    return await Character.findById(result.insertId);
  }

  /**
   * Find character by ID
   */
  static async findById(id) {
    const sql = 'SELECT * FROM characters WHERE id = ?';
    const results = await db.query(sql, [id]);

    if (results.length === 0) return null;

    const char = results[0];
    return Character._formatCharacter(char);
  }

  /**
   * Find all characters for a user
   */
  static async findByUserId(userId) {
    const sql = 'SELECT * FROM characters WHERE user_id = ? ORDER BY created_at DESC';
    const results = await db.query(sql, [userId]);

    return results.map(char => Character._formatCharacter(char));
  }

  /**
   * Update character
   */
  static async update(id, characterData) {
    const allowedFields = {
      name: 'name',
      gender: 'gender',
      age: 'age',
      photoUrl: 'photo_url',
      height: 'height',
      build: 'build',
      hairColor: 'hair_color',
      otherFeatures: 'other_features',
      strengths: 'strengths',
      weaknesses: 'weaknesses',
      fears: 'fears',
      specialDetails: 'special_details'
    };

    const updates = [];
    const values = [];

    for (const [jsField, dbField] of Object.entries(allowedFields)) {
      if (characterData[jsField] !== undefined) {
        updates.push(`${dbField} = ?`);

        // JSON fields need to be stringified
        if (['strengths', 'weaknesses', 'fears'].includes(jsField)) {
          values.push(JSON.stringify(characterData[jsField]));
        } else {
          values.push(characterData[jsField]);
        }
      }
    }

    if (updates.length === 0) return null;

    values.push(id);
    const sql = `UPDATE characters SET ${updates.join(', ')} WHERE id = ?`;
    await db.query(sql, values);

    return await Character.findById(id);
  }

  /**
   * Delete character
   */
  static async delete(id) {
    const sql = 'DELETE FROM characters WHERE id = ?';
    const result = await db.query(sql, [id]);
    return result.affectedRows > 0;
  }

  /**
   * Delete all characters for a user
   */
  static async deleteByUserId(userId) {
    const sql = 'DELETE FROM characters WHERE user_id = ?';
    const result = await db.query(sql, [userId]);
    return result.affectedRows;
  }

  /**
   * Format character data (parse JSON fields)
   */
  static _formatCharacter(char) {
    return {
      id: char.id,
      name: char.name,
      gender: char.gender,
      age: char.age,
      photoUrl: char.photo_url,
      height: char.height,
      build: char.build,
      hairColor: char.hair_color,
      otherFeatures: char.other_features,
      strengths: JSON.parse(char.strengths || '[]'),
      weaknesses: JSON.parse(char.weaknesses || '[]'),
      fears: JSON.parse(char.fears || '[]'),
      specialDetails: char.special_details,
      createdAt: char.created_at,
      updatedAt: char.updated_at
    };
  }
}

module.exports = Character;
