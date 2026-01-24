#!/usr/bin/env node
/**
 * Fix Corrupted Avatar Metadata
 *
 * The PUT /roles endpoint (commit 56ee71cc, Jan 21) corrupted `avatars.standard`
 * in the metadata column by treating a string as an array:
 *   "data:image..."[0] → "d" → stored as "d" or ["d"]
 *
 * This script:
 * 1. Queries all rows in `characters` table
 * 2. Checks if `metadata` has corrupted avatar values
 * 3. Regenerates metadata from the `data` column (which has correct full avatars)
 * 4. Updates the metadata column with the fixed version
 *
 * Usage:
 *   node scripts/admin/fix-corrupted-avatars.js --dry-run   # Preview changes
 *   node scripts/admin/fix-corrupted-avatars.js             # Apply fixes
 */

require('dotenv').config();
const pg = require('pg');

const dbUrl = process.env.DATABASE_URL || process.env.DATABASE_PRIVATE_URL;
if (!dbUrl) {
  console.log('No database URL found. Set DATABASE_URL or DATABASE_PRIVATE_URL.');
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: dbUrl,
  ssl: { rejectUnauthorized: false }
});

const dryRun = process.argv.includes('--dry-run');

/**
 * Check if an avatar value is corrupted (single char or array of single char)
 */
function isCorruptedAvatar(value) {
  if (!value) return false;

  // Single character string like "d"
  if (typeof value === 'string' && value.length <= 2) {
    return true;
  }

  // Array with single character element like ["d"]
  if (Array.isArray(value) && value.length === 1 && typeof value[0] === 'string' && value[0].length <= 2) {
    return true;
  }

  return false;
}

/**
 * Check if a character's avatar data is corrupted
 */
function hasCorruptedAvatars(char) {
  if (!char.avatars) return false;

  const avatarStyles = ['standard', 'winter', 'summer', 'formal'];
  for (const style of avatarStyles) {
    if (isCorruptedAvatar(char.avatars[style])) {
      return true;
    }
  }

  // Also check styledAvatars if present
  if (char.avatars.styledAvatars) {
    for (const [style, value] of Object.entries(char.avatars.styledAvatars)) {
      if (isCorruptedAvatar(value)) {
        return true;
      }
    }
  }

  // Check costumed if present
  if (char.avatars.costumed) {
    for (const [costume, value] of Object.entries(char.avatars.costumed)) {
      if (isCorruptedAvatar(value)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Generate metadata from full data (same logic as POST /api/characters)
 */
function generateMetadata(fullData) {
  const characters = fullData.characters || [];

  const lightCharacters = characters.map(char => {
    // Strip heavy base64 fields
    const { body_no_bg_url, body_photo_url, photo_url, thumbnail_url, clothing_avatars, photos, ...lightChar } = char;

    // Keep avatar metadata + only 'standard' faceThumbnail for list display
    if (lightChar.avatars) {
      const standardThumb = lightChar.avatars.faceThumbnails?.standard;
      lightChar.avatars = {
        status: lightChar.avatars.status,
        stale: lightChar.avatars.stale,
        generatedAt: lightChar.avatars.generatedAt,
        hasFullAvatars: !!(lightChar.avatars.winter || lightChar.avatars.standard || lightChar.avatars.summer || lightChar.avatars.formal),
        // Keep only standard thumbnail for list view
        faceThumbnails: standardThumb ? { standard: standardThumb } : undefined,
        // Keep clothing descriptions (small text, needed for display)
        clothing: lightChar.avatars.clothing
      };
    }
    return lightChar;
  });

  return {
    characters: lightCharacters,
    relationships: fullData.relationships || {},
    relationshipTexts: fullData.relationshipTexts || {},
    customRelationships: fullData.customRelationships || [],
    customStrengths: fullData.customStrengths || [],
    customWeaknesses: fullData.customWeaknesses || [],
    customFears: fullData.customFears || []
  };
}

async function fixCorruptedAvatars() {
  const client = await pool.connect();

  try {
    console.log(dryRun ? '🔍 DRY RUN - No changes will be made\n' : '🔧 FIXING corrupted avatar metadata\n');

    // Get all character rows
    const result = await client.query('SELECT id, user_id, data, metadata FROM characters ORDER BY id');
    console.log(`Found ${result.rows.length} character rows\n`);

    let corruptedCount = 0;
    let fixedCount = 0;

    for (const row of result.rows) {
      // Parse metadata to check for corruption
      let metadata;
      try {
        metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
      } catch (e) {
        console.log(`⚠️  Row ${row.id}: Could not parse metadata, skipping`);
        continue;
      }

      if (!metadata || !metadata.characters) {
        continue;
      }

      // Check each character for corrupted avatars
      const corruptedChars = [];
      for (const char of metadata.characters) {
        if (hasCorruptedAvatars(char)) {
          corruptedChars.push(char.name);

          // Log the corruption details
          if (char.avatars) {
            const details = [];
            if (isCorruptedAvatar(char.avatars.standard)) {
              details.push(`standard="${JSON.stringify(char.avatars.standard)}"`);
            }
            if (isCorruptedAvatar(char.avatars.winter)) {
              details.push(`winter="${JSON.stringify(char.avatars.winter)}"`);
            }
            if (isCorruptedAvatar(char.avatars.summer)) {
              details.push(`summer="${JSON.stringify(char.avatars.summer)}"`);
            }
            if (isCorruptedAvatar(char.avatars.formal)) {
              details.push(`formal="${JSON.stringify(char.avatars.formal)}"`);
            }
            console.log(`  ❌ ${char.name}: ${details.join(', ')}`);
          }
        }
      }

      if (corruptedChars.length === 0) {
        continue;
      }

      corruptedCount++;
      console.log(`\n📋 Row ${row.id} (user ${row.user_id}): ${corruptedChars.length} corrupted character(s)`);

      // Parse full data to regenerate metadata
      let fullData;
      try {
        fullData = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
      } catch (e) {
        console.log(`  ⚠️  Could not parse full data, skipping`);
        continue;
      }

      // Check if full data has the correct avatars
      const dataChars = fullData.characters || [];
      let hasGoodAvatars = false;
      for (const char of dataChars) {
        if (char.avatars?.standard && char.avatars.standard.length > 100) {
          hasGoodAvatars = true;
          console.log(`  ✓ Full data has valid avatar for ${char.name} (${char.avatars.standard.length} chars)`);
        }
      }

      if (!hasGoodAvatars) {
        console.log(`  ⚠️  Full data also appears to lack valid avatars, skipping`);
        continue;
      }

      // Generate new metadata from full data
      const newMetadata = generateMetadata(fullData);

      if (dryRun) {
        console.log(`  Would regenerate metadata from full data`);
        // Verify the new metadata doesn't have corruption
        let wouldFix = true;
        for (const char of newMetadata.characters) {
          if (hasCorruptedAvatars(char)) {
            console.log(`  ⚠️  New metadata would still be corrupted for ${char.name}`);
            wouldFix = false;
          }
        }
        if (wouldFix) {
          console.log(`  ✓ Would fix corruption for: ${corruptedChars.join(', ')}`);
        }
      } else {
        // Actually update the metadata
        await client.query(
          'UPDATE characters SET metadata = $1 WHERE id = $2',
          [JSON.stringify(newMetadata), row.id]
        );
        fixedCount++;
        console.log(`  ✓ Fixed metadata for: ${corruptedChars.join(', ')}`);
      }
    }

    console.log('\n' + '='.repeat(60));
    if (dryRun) {
      console.log(`\n📊 Summary (DRY RUN):`);
      console.log(`   Found ${corruptedCount} rows with corrupted metadata`);
      console.log(`\nRun without --dry-run to apply fixes.`);
    } else {
      console.log(`\n📊 Summary:`);
      console.log(`   Found ${corruptedCount} rows with corrupted metadata`);
      console.log(`   Fixed ${fixedCount} rows`);
    }

  } catch (error) {
    console.error('Error:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

fixCorruptedAvatars()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
