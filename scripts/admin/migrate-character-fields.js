#!/usr/bin/env node
/**
 * Migrate Character Fields to Canonical Structure
 *
 * This script migrates legacy character data fields to the normalized structure:
 * - Flat snake_case physical fields → character.physical.*
 * - Flat trait fields → character.traits.*
 * - Legacy photo fields → character.photos.*
 *
 * Migrates both:
 * 1. characters table - user's character definitions
 * 2. stories table - embedded characters in story data
 *
 * Usage:
 *   node scripts/admin/migrate-character-fields.js [--dry-run] [--user-id=X]
 *
 * Options:
 *   --dry-run    Preview changes without saving
 *   --user-id=X  Migrate only a specific user's data
 */

require('dotenv').config();
const { Pool } = require('pg');
const { normalizePhotos, stripLegacyPhotoFields } = require('../../server/lib/characterPhotos');
const { normalizePhysical, stripLegacyPhysicalFields, LEGACY_FIELDS: LEGACY_PHYSICAL_FIELDS } = require('../../server/lib/characterPhysical');
const { normalizeTraits, stripLegacyTraitFields, LEGACY_FIELDS: LEGACY_TRAIT_FIELDS } = require('../../server/lib/characterTraits');

// Parse arguments
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const userIdArg = args.find(a => a.startsWith('--user-id='));
const TARGET_USER_ID = userIdArg ? parseInt(userIdArg.split('=')[1], 10) : null;

// Connect to database
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false
});

// Stats tracking
const stats = {
  charactersTable: {
    rowsProcessed: 0,
    charactersProcessed: 0,
    physicalMigrated: 0,
    traitsMigrated: 0,
    photosMigrated: 0
  },
  storiesTable: {
    rowsProcessed: 0,
    charactersProcessed: 0,
    physicalMigrated: 0,
    traitsMigrated: 0,
    photosMigrated: 0
  }
};

/**
 * Check if character has any legacy fields that need migration
 */
function needsMigration(char) {
  if (!char) return false;

  // Check legacy physical fields
  for (const field of LEGACY_PHYSICAL_FIELDS) {
    if (char[field]) return true;
  }

  // Check legacy trait fields
  for (const field of LEGACY_TRAIT_FIELDS) {
    if (char[field]) return true;
  }

  // Check legacy photo fields
  if (char.photo_url || char.photoUrl || char.photo ||
      char.thumbnail_url || char.body_photo_url || char.body_no_bg_url) {
    return true;
  }

  return false;
}

/**
 * Migrate a single character, returning what was changed
 */
function migrateCharacter(char) {
  const changes = {
    physical: false,
    traits: false,
    photos: false
  };

  if (!char) return changes;

  // Check what needs migration before normalizing
  const hadLegacyPhysical = LEGACY_PHYSICAL_FIELDS.some(f => char[f]);
  const hadLegacyTraits = LEGACY_TRAIT_FIELDS.some(f => char[f]);
  const hadLegacyPhotos = char.photo_url || char.photoUrl || char.photo ||
                          char.thumbnail_url || char.body_photo_url || char.body_no_bg_url;

  // Normalize physical fields
  if (hadLegacyPhysical) {
    normalizePhysical(char);
    stripLegacyPhysicalFields(char);
    changes.physical = true;
  }

  // Normalize trait fields
  if (hadLegacyTraits) {
    normalizeTraits(char);
    stripLegacyTraitFields(char);
    changes.traits = true;
  }

  // Normalize photo fields
  if (hadLegacyPhotos) {
    normalizePhotos(char);
    stripLegacyPhotoFields(char);
    changes.photos = true;
  }

  return changes;
}

/**
 * Migrate characters table
 */
async function migrateCharactersTable() {
  console.log('\n=== Migrating characters table ===');

  let query = 'SELECT id, user_id, data FROM characters';
  const params = [];

  if (TARGET_USER_ID) {
    query += ' WHERE user_id = $1';
    params.push(TARGET_USER_ID);
  }

  const result = await pool.query(query, params);
  console.log(`Found ${result.rows.length} rows to process`);

  for (const row of result.rows) {
    stats.charactersTable.rowsProcessed++;

    const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
    if (!data?.characters || !Array.isArray(data.characters)) {
      continue;
    }

    let rowModified = false;

    for (const char of data.characters) {
      stats.charactersTable.charactersProcessed++;

      if (!needsMigration(char)) {
        continue;
      }

      const changes = migrateCharacter(char);

      if (changes.physical) {
        stats.charactersTable.physicalMigrated++;
        rowModified = true;
        console.log(`  [characters] ${char.name || char.id}: migrated physical fields`);
      }
      if (changes.traits) {
        stats.charactersTable.traitsMigrated++;
        rowModified = true;
        console.log(`  [characters] ${char.name || char.id}: migrated trait fields`);
      }
      if (changes.photos) {
        stats.charactersTable.photosMigrated++;
        rowModified = true;
        console.log(`  [characters] ${char.name || char.id}: migrated photo fields`);
      }
    }

    // Save if modified
    if (rowModified && !DRY_RUN) {
      // Also update metadata column
      const metadataChars = data.characters.map(char => {
        const { photos, avatars, ...lightChar } = char;
        return {
          ...lightChar,
          avatars: avatars ? {
            status: avatars.status,
            hasFullAvatars: !!(avatars.standard || avatars.winter || avatars.summer || avatars.formal),
            faceThumbnails: avatars.faceThumbnails?.standard ? { standard: avatars.faceThumbnails.standard } : undefined,
            clothing: avatars.clothing
          } : undefined
        };
      });
      const metadata = { ...data, characters: metadataChars };

      await pool.query(
        'UPDATE characters SET data = $1, metadata = $2 WHERE id = $3',
        [JSON.stringify(data), JSON.stringify(metadata), row.id]
      );
      console.log(`  [characters] Saved row ${row.id}`);
    }
  }
}

/**
 * Migrate stories table (embedded characters)
 * Uses JSONB extraction to avoid loading full story data (which contains images)
 */
async function migrateStoriesTable() {
  console.log('\n=== Migrating stories table ===');

  // First, get story IDs that have characters with legacy fields
  // This avoids loading the full data blob which contains images
  let countQuery = `
    SELECT COUNT(*) as total FROM stories
    WHERE data->'characters' IS NOT NULL
    AND jsonb_array_length(data->'characters') > 0
  `;
  const countParams = [];

  if (TARGET_USER_ID) {
    countQuery += ' AND user_id = $1';
    countParams.push(TARGET_USER_ID);
  }

  const countResult = await pool.query(countQuery, countParams);
  const totalStories = parseInt(countResult.rows[0].total, 10);
  console.log(`Found ${totalStories} stories with characters to check`);

  if (totalStories === 0) {
    return;
  }

  // Process in batches to avoid memory issues
  const BATCH_SIZE = 50;
  let offset = 0;

  while (offset < totalStories) {
    let query = `
      SELECT id, user_id, data->'characters' as characters
      FROM stories
      WHERE data->'characters' IS NOT NULL
      AND jsonb_array_length(data->'characters') > 0
    `;
    const params = [];
    let paramIndex = 1;

    if (TARGET_USER_ID) {
      query += ` AND user_id = $${paramIndex}`;
      params.push(TARGET_USER_ID);
      paramIndex++;
    }

    query += ` ORDER BY id LIMIT ${BATCH_SIZE} OFFSET ${offset}`;

    const result = await pool.query(query, params);

    for (const row of result.rows) {
      stats.storiesTable.rowsProcessed++;

      // Parse just the characters array (not full data)
      const characters = typeof row.characters === 'string' ? JSON.parse(row.characters) : row.characters;
      if (!characters || !Array.isArray(characters)) {
        continue;
      }

      let rowNeedsMigration = false;

      // First pass: check if any characters need migration
      for (const char of characters) {
        stats.storiesTable.charactersProcessed++;

        if (needsMigration(char)) {
          rowNeedsMigration = true;
          // Log what would be migrated
          const hadLegacyPhysical = LEGACY_PHYSICAL_FIELDS.some(f => char[f]);
          const hadLegacyTraits = LEGACY_TRAIT_FIELDS.some(f => char[f]);
          const hadLegacyPhotos = char.photo_url || char.photoUrl || char.photo ||
                                  char.thumbnail_url || char.body_photo_url || char.body_no_bg_url;

          if (hadLegacyPhysical) {
            stats.storiesTable.physicalMigrated++;
            console.log(`  [story ${row.id}] ${char.name || char.id}: migrated physical fields`);
          }
          if (hadLegacyTraits) {
            stats.storiesTable.traitsMigrated++;
            console.log(`  [story ${row.id}] ${char.name || char.id}: migrated trait fields`);
          }
          if (hadLegacyPhotos) {
            stats.storiesTable.photosMigrated++;
            console.log(`  [story ${row.id}] ${char.name || char.id}: migrated photo fields`);
          }
        }
      }

      // If migration needed and not dry run, load full data and update
      if (rowNeedsMigration && !DRY_RUN) {
        // Load full story data
        const fullResult = await pool.query('SELECT data FROM stories WHERE id = $1', [row.id]);
        if (fullResult.rows.length === 0) continue;

        const fullData = typeof fullResult.rows[0].data === 'string'
          ? JSON.parse(fullResult.rows[0].data)
          : fullResult.rows[0].data;

        // Migrate characters in the full data
        for (const char of fullData.characters || []) {
          migrateCharacter(char);
        }

        // Save
        await pool.query(
          'UPDATE stories SET data = $1 WHERE id = $2',
          [JSON.stringify(fullData), row.id]
        );
        console.log(`  [stories] Saved story ${row.id}`);
      }
    }

    offset += BATCH_SIZE;
  }
}

/**
 * Main
 */
async function main() {
  console.log('=== Character Fields Migration ===');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no changes will be saved)' : 'LIVE'}`);
  if (TARGET_USER_ID) {
    console.log(`Target user: ${TARGET_USER_ID}`);
  }

  try {
    await migrateCharactersTable();
    await migrateStoriesTable();

    // Print summary
    console.log('\n=== Migration Summary ===');
    console.log('\nCharacters table:');
    console.log(`  Rows processed: ${stats.charactersTable.rowsProcessed}`);
    console.log(`  Characters processed: ${stats.charactersTable.charactersProcessed}`);
    console.log(`  Physical fields migrated: ${stats.charactersTable.physicalMigrated}`);
    console.log(`  Trait fields migrated: ${stats.charactersTable.traitsMigrated}`);
    console.log(`  Photo fields migrated: ${stats.charactersTable.photosMigrated}`);

    console.log('\nStories table:');
    console.log(`  Rows processed: ${stats.storiesTable.rowsProcessed}`);
    console.log(`  Characters processed: ${stats.storiesTable.charactersProcessed}`);
    console.log(`  Physical fields migrated: ${stats.storiesTable.physicalMigrated}`);
    console.log(`  Trait fields migrated: ${stats.storiesTable.traitsMigrated}`);
    console.log(`  Photo fields migrated: ${stats.storiesTable.photosMigrated}`);

    const totalMigrated = stats.charactersTable.physicalMigrated + stats.charactersTable.traitsMigrated +
                          stats.charactersTable.photosMigrated + stats.storiesTable.physicalMigrated +
                          stats.storiesTable.traitsMigrated + stats.storiesTable.photosMigrated;

    if (DRY_RUN && totalMigrated > 0) {
      console.log('\n⚠️  DRY RUN - No changes were saved. Run without --dry-run to apply changes.');
    } else if (totalMigrated === 0) {
      console.log('\n✅ No legacy fields found - data is already normalized!');
    } else {
      console.log('\n✅ Migration complete!');
    }

  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
