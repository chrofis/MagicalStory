#!/usr/bin/env node
/**
 * Migration Script: Normalize Character Photo Fields
 *
 * This script migrates all character data from legacy flat fields to the
 * canonical photos.* structure:
 *
 * Legacy fields:
 *   - photo_url, photoUrl, photo -> photos.original
 *   - thumbnail_url -> photos.face
 *   - body_photo_url -> photos.body
 *   - body_no_bg_url -> photos.bodyNoBg
 *   - face_box, faceBox -> photos.faceBox
 *   - body_box, bodyBox -> photos.bodyBox
 *
 * Canonical structure:
 *   character.photos = {
 *     original: string,   // Full uploaded photo (data URI)
 *     face: string,       // Cropped face
 *     body: string,       // Cropped body
 *     bodyNoBg: string,   // Body with background removed
 *     faceBox?: BoundingBox,
 *     bodyBox?: BoundingBox
 *   }
 *
 * Usage:
 *   node scripts/admin/migrate-photo-fields.js [--dry-run] [--user-id=X]
 *
 * Options:
 *   --dry-run     Preview changes without modifying database
 *   --user-id=X   Only migrate characters for a specific user
 */

require('dotenv').config();
const { Pool } = require('pg');

// Parse command line arguments
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const userIdArg = args.find(a => a.startsWith('--user-id='));
const specificUserId = userIdArg ? userIdArg.split('=')[1] : null;

// Database connection
const dbPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

/**
 * Normalize legacy photo fields to photos.* structure
 * @param {Object} character - Character object to normalize
 * @returns {boolean} True if any changes were made
 */
function normalizePhotos(character) {
  if (!character) return false;

  // Check if there are legacy fields to migrate
  const hasLegacyFields = character.photo_url || character.photoUrl || character.photo ||
                          character.thumbnail_url || character.body_photo_url || character.body_no_bg_url;

  if (!hasLegacyFields) {
    return false;
  }

  // Initialize photos object if needed
  if (!character.photos) {
    character.photos = {};
  }

  let changed = false;

  // Migrate original photo
  const originalPhoto = character.photo_url || character.photoUrl || character.photo;
  if (originalPhoto && !character.photos.original) {
    character.photos.original = originalPhoto;
    changed = true;
  }

  // Migrate face/thumbnail
  if (character.thumbnail_url && !character.photos.face) {
    character.photos.face = character.thumbnail_url;
    changed = true;
  }

  // Migrate body photo
  if (character.body_photo_url && !character.photos.body) {
    character.photos.body = character.body_photo_url;
    changed = true;
  }

  // Migrate body without background
  if (character.body_no_bg_url && !character.photos.bodyNoBg) {
    character.photos.bodyNoBg = character.body_no_bg_url;
    changed = true;
  }

  // Migrate bounding boxes
  const faceBox = character.face_box || character.faceBox;
  if (faceBox && !character.photos.faceBox) {
    character.photos.faceBox = faceBox;
    changed = true;
  }

  const bodyBox = character.body_box || character.bodyBox;
  if (bodyBox && !character.photos.bodyBox) {
    character.photos.bodyBox = bodyBox;
    changed = true;
  }

  return changed;
}

/**
 * Strip legacy photo fields after migration
 * @param {Object} character - Character object to clean up
 */
function stripLegacyFields(character) {
  delete character.photo_url;
  delete character.photoUrl;
  delete character.photo;
  delete character.thumbnail_url;
  delete character.body_photo_url;
  delete character.body_no_bg_url;
  delete character.face_box;
  delete character.faceBox;
  delete character.body_box;
  delete character.bodyBox;
  delete character.bodyPhotoUrl;
  delete character.bodyNoBgUrl;
}

async function migrate() {
  console.log('='.repeat(60));
  console.log('Character Photo Fields Migration');
  console.log('='.repeat(60));
  console.log(`Mode: ${dryRun ? 'DRY RUN (no changes will be saved)' : 'LIVE (changes will be saved)'}`);
  if (specificUserId) {
    console.log(`Filtering: user_id = ${specificUserId}`);
  }
  console.log('');

  try {
    // Query all character rows (or filtered by user)
    let query = 'SELECT id, user_id, data FROM characters';
    let params = [];
    if (specificUserId) {
      query += ' WHERE user_id = $1';
      params = [specificUserId];
    }

    const result = await dbPool.query(query, params);
    console.log(`Found ${result.rows.length} character row(s) to process\n`);

    let totalRows = 0;
    let modifiedRows = 0;
    let totalCharacters = 0;
    let migratedCharacters = 0;
    let strippedFields = 0;

    for (const row of result.rows) {
      totalRows++;
      const charSetId = row.id;
      const userId = row.user_id;

      // Parse data
      let data;
      try {
        data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
      } catch (parseErr) {
        console.log(`  [SKIP] Row ${charSetId}: Invalid JSON data`);
        continue;
      }

      if (!data || !Array.isArray(data.characters)) {
        console.log(`  [SKIP] Row ${charSetId}: No characters array`);
        continue;
      }

      let rowModified = false;
      const charNames = [];

      for (const character of data.characters) {
        totalCharacters++;

        // Check for legacy fields before migration
        const legacyFieldsBefore = [];
        if (character.photo_url) legacyFieldsBefore.push('photo_url');
        if (character.photoUrl) legacyFieldsBefore.push('photoUrl');
        if (character.photo) legacyFieldsBefore.push('photo');
        if (character.thumbnail_url) legacyFieldsBefore.push('thumbnail_url');
        if (character.body_photo_url) legacyFieldsBefore.push('body_photo_url');
        if (character.body_no_bg_url) legacyFieldsBefore.push('body_no_bg_url');

        // Normalize and strip
        const normalized = normalizePhotos(character);
        if (normalized || legacyFieldsBefore.length > 0) {
          stripLegacyFields(character);
          strippedFields += legacyFieldsBefore.length;
          migratedCharacters++;
          rowModified = true;
          charNames.push(`${character.name || character.id} (${legacyFieldsBefore.join(', ')})`);
        }
      }

      if (rowModified) {
        modifiedRows++;
        console.log(`  [${charSetId}] user=${userId}: Migrated ${charNames.length} character(s):`);
        for (const name of charNames) {
          console.log(`    - ${name}`);
        }

        // Save changes (unless dry run)
        if (!dryRun) {
          await dbPool.query(
            'UPDATE characters SET data = $1 WHERE id = $2',
            [JSON.stringify(data), charSetId]
          );
        }
      }
    }

    console.log('\n' + '='.repeat(60));
    console.log('Migration Summary');
    console.log('='.repeat(60));
    console.log(`Total character rows: ${totalRows}`);
    console.log(`Rows modified: ${modifiedRows}`);
    console.log(`Total characters: ${totalCharacters}`);
    console.log(`Characters migrated: ${migratedCharacters}`);
    console.log(`Legacy fields stripped: ${strippedFields}`);
    console.log('');

    if (dryRun) {
      console.log('DRY RUN complete. No changes were saved.');
      console.log('Run without --dry-run to apply changes.');
    } else {
      console.log('Migration complete. Changes have been saved.');
    }

  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    await dbPool.end();
  }
}

// Run migration
migrate().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
