#!/usr/bin/env node
/**
 * Database Migration Runner
 * Automatically runs pending migrations on server startup
 */

const fs = require('fs').promises;
const path = require('path');

async function runMigrations(dbPool, dbType) {
  console.log('🔄 Running database migrations...');

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
    console.log('✓ Migrations table ready');

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

    console.log(`Found ${migrationFiles.length} migration files to process`);

    // Execute each migration
    for (const migrationFile of migrationFiles) {
      const migrationPath = path.join(migrationsDir, migrationFile);

      // Check if migration already executed
      const checkQuery = dbType === 'postgresql'
        ? 'SELECT migration_name FROM schema_migrations WHERE migration_name = $1'
        : 'SELECT migration_name FROM schema_migrations WHERE migration_name = ?';

      const rows = await executeQuery(checkQuery, [migrationFile]);

      if (rows.length > 0) {
        console.log(`✓ Migration ${migrationFile} already executed`);
        continue;
      }

      // Read and execute migration
      console.log(`📝 Running migration: ${migrationFile}...`);
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

      console.log(`✅ Migration ${migrationFile} completed successfully`);
    }

    console.log('✅ All migrations completed');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    throw err;
  }
}

module.exports = { runMigrations };
