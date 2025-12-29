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

  console.log('[MIGRATIONS] Starting migration check...');

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
    console.log('[MIGRATIONS] Reading from:', migrationsDir);
    const allFiles = await fs.readdir(migrationsDir);
    console.log('[MIGRATIONS] Found files:', allFiles.length);

    // Filter migration files based on database type
    const migrationFiles = allFiles.filter(file => {
      if (dbType === 'postgresql') {
        return file.endsWith('_postgresql.sql') || (!file.includes('_postgresql') && !file.includes('add_default') && file.endsWith('.sql'));
      } else {
        return !file.endsWith('_postgresql.sql') && file.endsWith('.sql');
      }
    }).sort(); // Sort to ensure consistent order
    console.log('[MIGRATIONS] Filtered files for PostgreSQL:', migrationFiles.length, migrationFiles);

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

    console.log('[MIGRATIONS] Pending migrations:', pendingMigrations.length, pendingMigrations);

    // Check for broken migrations (recorded but not actually applied)
    // Specifically check metadata column for migration 015
    if (dbType === 'postgresql') {
      const metadataMigration = '015_add_story_metadata_column.sql';
      const metadataRecorded = await executeQuery(
        'SELECT migration_name FROM schema_migrations WHERE migration_name = $1',
        [metadataMigration]
      );

      if (metadataRecorded.length > 0) {
        // Check if column actually exists
        const columnExists = await executeQuery(`
          SELECT column_name FROM information_schema.columns
          WHERE table_name = 'stories' AND column_name = 'metadata'
        `);

        if (columnExists.length === 0) {
          console.log('[MIGRATIONS] ⚠️  Migration 015 was recorded but metadata column missing - fixing...');

          // Remove the broken record
          await executeQuery('DELETE FROM schema_migrations WHERE migration_name = $1', [metadataMigration]);

          // Add to pending list if not already there
          if (!pendingMigrations.includes(metadataMigration)) {
            pendingMigrations.push(metadataMigration);
            pendingMigrations.sort();
          }

          console.log('[MIGRATIONS] ✓ Removed broken migration record, will re-run');
        }
      }
    }

    // If no pending migrations, stay silent
    if (pendingMigrations.length === 0) {
      console.log('[MIGRATIONS] All migrations already applied');
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
      // First remove all comment lines, then split and filter
      const sqlWithoutComments = migrationSQL
        .split('\n')
        .filter(line => !line.trim().startsWith('--'))
        .join('\n');

      const statements = sqlWithoutComments
        .split(';')
        .map(s => s.trim())
        .filter(s => s.length > 0);

      console.log(`[MIGRATIONS] Found ${statements.length} statements to execute`);

      for (const statement of statements) {
        try {
          console.log(`[MIGRATIONS] Executing: ${statement.substring(0, 60)}...`);
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
