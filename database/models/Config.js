// Configuration Model (for admin settings)
const db = require('../config');

class Config {
  /**
   * Get configuration value by key
   */
  static async get(key) {
    const sql = 'SELECT config_value FROM config WHERE config_key = ?';
    const results = await db.query(sql, [key]);

    if (results.length === 0) return null;

    return results[0].config_value;
  }

  /**
   * Set configuration value
   */
  static async set(key, value) {
    const sql = `
      INSERT INTO config (config_key, config_value)
      VALUES (?, ?)
      ON DUPLICATE KEY UPDATE
        config_value = VALUES(config_value),
        updated_at = CURRENT_TIMESTAMP
    `;

    await db.query(sql, [key, value]);
    return await Config.get(key);
  }

  /**
   * Get all configuration
   */
  static async getAll() {
    const sql = 'SELECT config_key, config_value FROM config';
    const results = await db.query(sql);

    const config = {};
    for (const row of results) {
      config[row.config_key] = row.config_value;
    }

    return config;
  }

  /**
   * Delete configuration
   */
  static async delete(key) {
    const sql = 'DELETE FROM config WHERE config_key = ?';
    const result = await db.query(sql, [key]);
    return result.affectedRows > 0;
  }
}

module.exports = Config;
