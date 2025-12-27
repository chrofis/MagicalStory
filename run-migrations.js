#!/usr/bin/env node
/**
 * Database Migration Runner
 * Automatically runs pending migrations on server startup
 *
 * Note: Migration files are kept in database/migrations/ for reference.
 * Once executed, they are tracked in the schema_migrations table.
 * This runner is silent when all migrations are already applied.
 */

const fs = require('fs').promises;
const path = require('path');

async function runMigrations(dbPool, dbType) {
  // Helper to execute queries (handle both PostgreSQL and MySQL)
  const executeQuery = async (query, params = []) => {
    if (dbType === 'postgresql') {
      const result = await dbPool.query(query, params);
      return result.rows || [];
    } else {
      const [rows] = await dbPool.execute(query, params);
      return rows || [];
    }
  };

  try {
    // Create migrations table if it doesn't exist
    const createMigrationsTable = dbType === 'postgresql'
      ? `CREATE TABLE IF NOT EXISTS schema_migrations (
          id SERIAL PRIMARY KEY,
          migration_name VARCHAR(255) NOT NULL UNIQUE,
          executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`
      : `CREATE TABLE IF NOT EXISTS schema_migrations (
          id INT AUTO_INCREMENT PRIMARY KEY,
          migration_name VARCHAR(255) NOT NULL UNIQUE,
          executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`;

    await executeQuery(createMigrationsTable);

    // Read all migration files
    const migrationsDir = path.join(__dirname, 'database', 'migrations');
    const allFiles = await fs.readdir(migrationsDir);

    // Filter migration files based on database type
    const migrationFiles = allFiles.filter(file => {
      if (dbType === 'postgresql') {
        return file.endsWith('_postgresql.sql') || (!file.includes('_postgresql') && !file.includes('add_default') && file.endsWith('.sql'));
      } else {
        return !file.endsWith('_postgresql.sql') && file.endsWith('.sql');
      }
    }).sort(); // Sort to ensure consistent order

    // Find pending migrations
    const pendingMigrations = [];
    for (const migrationFile of migrationFiles) {
      const checkQuery = dbType === 'postgresql'
        ? 'SELECT migration_name FROM schema_migrations WHERE migration_name = $1'
        : 'SELECT migration_name FROM schema_migrations WHERE migration_name = ?';

      const rows = await executeQuery(checkQuery, [migrationFile]);
      if (rows.length === 0) {
        pendingMigrations.push(migrationFile);
      }
    }

    // If no pending migrations, stay silent
    if (pendingMigrations.length === 0) {
      return;
    }

    // Only log when there's work to do
    console.log(`🔄 Running ${pendingMigrations.length} pending migration(s)...`);

    // Execute pending migrations
    for (const migrationFile of pendingMigrations) {
      const migrationPath = path.join(migrationsDir, migrationFile);

      console.log(`📝 Running: ${migrationFile}`);
      const migrationSQL = await fs.readFile(migrationPath, 'utf-8');

      // Split by semicolon and execute each statement
      const statements = migrationSQL
        .split(';')
        .map(s => s.trim())
        .filter(s => s.length > 0 && !s.startsWith('--'));

      for (const statement of statements) {
        try {
          await executeQuery(statement);
        } catch (err) {
          // Ignore "already exists" errors
          if (!err.message.includes('already exists') &&
              !err.message.includes('duplicate column') &&
              !err.message.includes('Duplicate column')) {
            console.error('Statement error:', err.message);
            console.error('Statement:', statement.substring(0, 100));
          }
        }
      }

      // Record migration as executed
      const insertQuery = dbType === 'postgresql'
        ? 'INSERT INTO schema_migrations (migration_name) VALUES ($1)'
        : 'INSERT INTO schema_migrations (migration_name) VALUES (?)';

      await executeQuery(insertQuery, [migrationFile]);

      console.log(`✅ ${migrationFile} completed`);
    }

    console.log('✅ All migrations completed');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    throw err;
  }
}

module.exports = { runMigrations };
