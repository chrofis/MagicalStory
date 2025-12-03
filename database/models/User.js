// User Model
const db = require('../config');
const bcrypt = require('bcryptjs');

class User {
  /**
   * Create a new user
   */
  static async create({ username, email, password }) {
    const passwordHash = await bcrypt.hash(password, 10);

    const sql = `
      INSERT INTO users (username, email, password_hash)
      VALUES (?, ?, ?)
    `;

    const result = await db.query(sql, [username, email, passwordHash]);
    return {
      id: result.insertId,
      username,
      email
    };
  }

  /**
   * Find user by username
   */
  static async findByUsername(username) {
    const sql = 'SELECT * FROM users WHERE username = ?';
    const results = await db.query(sql, [username]);
    return results[0] || null;
  }

  /**
   * Find user by email
   */
  static async findByEmail(email) {
    const sql = 'SELECT * FROM users WHERE email = ?';
    const results = await db.query(sql, [email]);
    return results[0] || null;
  }

  /**
   * Find user by ID
   */
  static async findById(id) {
    const sql = 'SELECT id, username, email, created_at FROM users WHERE id = ?';
    const results = await db.query(sql, [id]);
    return results[0] || null;
  }

  /**
   * Verify user password
   */
  static async verifyPassword(user, password) {
    return await bcrypt.compare(password, user.password_hash);
  }

  /**
   * Update user
   */
  static async update(id, data) {
    const allowedFields = ['email'];
    const updates = [];
    const values = [];

    for (const field of allowedFields) {
      if (data[field] !== undefined) {
        updates.push(`${field} = ?`);
        values.push(data[field]);
      }
    }

    if (updates.length === 0) {
      return null;
    }

    values.push(id);
    const sql = `UPDATE users SET ${updates.join(', ')} WHERE id = ?`;
    await db.query(sql, values);

    return await User.findById(id);
  }

  /**
   * Delete user
   */
  static async delete(id) {
    const sql = 'DELETE FROM users WHERE id = ?';
    const result = await db.query(sql, [id]);
    return result.affectedRows > 0;
  }
}

module.exports = User;
