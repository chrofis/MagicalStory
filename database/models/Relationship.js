// Character Relationship Model
const db = require('../config');

class Relationship {
  /**
   * Create a new relationship between characters
   */
  static async create(userId, relationshipData) {
    const { character1Id, character2Id, relationshipType, relationshipText } = relationshipData;

    const sql = `
      INSERT INTO character_relationships (
        user_id, character1_id, character2_id, relationship_type, relationship_text
      ) VALUES (?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        relationship_type = VALUES(relationship_type),
        relationship_text = VALUES(relationship_text),
        updated_at = CURRENT_TIMESTAMP
    `;

    await db.query(sql, [
      userId,
      character1Id,
      character2Id,
      relationshipType,
      relationshipText || null
    ]);

    return await Relationship.findByCharacters(character1Id, character2Id);
  }

  /**
   * Find relationship between two characters
   */
  static async findByCharacters(character1Id, character2Id) {
    const sql = `
      SELECT * FROM character_relationships
      WHERE (character1_id = ? AND character2_id = ?)
         OR (character1_id = ? AND character2_id = ?)
      LIMIT 1
    `;
    const results = await db.query(sql, [character1Id, character2Id, character2Id, character1Id]);

    if (results.length === 0) return null;

    return Relationship._formatRelationship(results[0]);
  }

  /**
   * Find all relationships for a user
   */
  static async findByUserId(userId) {
    const sql = `
      SELECT * FROM character_relationships
      WHERE user_id = ?
      ORDER BY created_at DESC
    `;
    const results = await db.query(sql, [userId]);

    return results.map(rel => Relationship._formatRelationship(rel));
  }

  /**
   * Find all relationships for a specific character
   */
  static async findByCharacterId(characterId) {
    const sql = `
      SELECT * FROM character_relationships
      WHERE character1_id = ? OR character2_id = ?
      ORDER BY created_at DESC
    `;
    const results = await db.query(sql, [characterId, characterId]);

    return results.map(rel => Relationship._formatRelationship(rel));
  }

  /**
   * Update relationship
   */
  static async update(id, relationshipData) {
    const { relationshipType, relationshipText } = relationshipData;

    const sql = `
      UPDATE character_relationships
      SET relationship_type = ?, relationship_text = ?
      WHERE id = ?
    `;

    await db.query(sql, [relationshipType, relationshipText || null, id]);

    return await Relationship.findById(id);
  }

  /**
   * Find relationship by ID
   */
  static async findById(id) {
    const sql = 'SELECT * FROM character_relationships WHERE id = ?';
    const results = await db.query(sql, [id]);

    if (results.length === 0) return null;

    return Relationship._formatRelationship(results[0]);
  }

  /**
   * Delete relationship
   */
  static async delete(id) {
    const sql = 'DELETE FROM character_relationships WHERE id = ?';
    const result = await db.query(sql, [id]);
    return result.affectedRows > 0;
  }

  /**
   * Delete relationship by characters
   */
  static async deleteByCharacters(character1Id, character2Id) {
    const sql = `
      DELETE FROM character_relationships
      WHERE (character1_id = ? AND character2_id = ?)
         OR (character1_id = ? AND character2_id = ?)
    `;
    const result = await db.query(sql, [character1Id, character2Id, character2Id, character1Id]);
    return result.affectedRows > 0;
  }

  /**
   * Delete all relationships for a user
   */
  static async deleteByUserId(userId) {
    const sql = 'DELETE FROM character_relationships WHERE user_id = ?';
    const result = await db.query(sql, [userId]);
    return result.affectedRows;
  }

  /**
   * Format relationship data
   */
  static _formatRelationship(rel) {
    return {
      id: rel.id,
      userId: rel.user_id,
      character1Id: rel.character1_id,
      character2Id: rel.character2_id,
      relationshipType: rel.relationship_type,
      relationshipText: rel.relationship_text,
      createdAt: rel.created_at,
      updatedAt: rel.updated_at
    };
  }
}

module.exports = Relationship;
