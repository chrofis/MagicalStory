#!/usr/bin/env node
/**
 * Fix Corrupted Avatar Data
 *
 * The PUT /roles endpoint (commit 56ee71cc, Jan 21) corrupted `avatars.standard`
 * in BOTH `data` AND `metadata` columns by treating a string as an array:
 *   "data:image..."[0] → "d" → stored as "d" or ["d"]
 *
 * This caused Page 15 of "Die Superhelden von Baden" to generate with zero
 * character references because all `standard` avatars were just "d".
 *
 * This script:
 * 1. Queries all rows in `characters` table
 * 2. Checks if `data` column has corrupted avatar values (standard, winter, etc.)
 * 3. For corrupted variants, copies from a valid variant as fallback
 * 4. Marks avatars as stale so they regenerate on next use
 * 5. Updates BOTH `data` and `metadata` columns
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

/**
 * Check if avatar value is valid (base64 image data)
 */
function isValidAvatar(value) {
  if (!value) return false;
  if (typeof value !== 'string') return false;
  // Valid avatars are base64 strings starting with data:image or at least 100+ chars
  return value.length > 100 && (value.startsWith('data:image') || value.startsWith('/9j') || value.startsWith('iVBOR'));
}

/**
 * Find a valid avatar variant to use as fallback
 */
function findValidVariant(avatars) {
  const variants = ['standard', 'winter', 'summer', 'formal'];
  for (const variant of variants) {
    if (isValidAvatar(avatars[variant])) {
      return { variant, value: avatars[variant] };
    }
  }
  // Also check costumed avatars
  if (avatars.costumed) {
    for (const [costume, value] of Object.entries(avatars.costumed)) {
      if (isValidAvatar(value)) {
        return { variant: `costumed:${costume}`, value };
      }
    }
  }
  // Check styledAvatars
  if (avatars.styledAvatars) {
    for (const [style, value] of Object.entries(avatars.styledAvatars)) {
      if (isValidAvatar(value)) {
        return { variant: `styled:${style}`, value };
      }
    }
  }
  return null;
}

/**
 * Fix corrupted avatars in a character by copying from valid variants
 * Returns true if any fixes were applied
 */
function fixCharacterAvatars(char) {
  if (!char.avatars) return false;

  let fixed = false;
  const variants = ['standard', 'winter', 'summer', 'formal'];

  // Find a valid variant to use as fallback
  const fallback = findValidVariant(char.avatars);

  for (const variant of variants) {
    if (isCorruptedAvatar(char.avatars[variant])) {
      if (fallback) {
        console.log(`    Copying ${fallback.variant} → ${variant}`);
        char.avatars[variant] = fallback.value;
        fixed = true;
      } else {
        // No valid variant found - clear the corrupted value
        console.log(`    Clearing corrupted ${variant} (no valid fallback)`);
        delete char.avatars[variant];
        fixed = true;
      }
    }
  }

  // Also fix costumed avatars
  if (char.avatars.costumed) {
    for (const [costume, value] of Object.entries(char.avatars.costumed)) {
      if (isCorruptedAvatar(value)) {
        if (fallback) {
          console.log(`    Copying ${fallback.variant} → costumed:${costume}`);
          char.avatars.costumed[costume] = fallback.value;
          fixed = true;
        } else {
          console.log(`    Clearing corrupted costumed:${costume} (no valid fallback)`);
          delete char.avatars.costumed[costume];
          fixed = true;
        }
      }
    }
  }

  // Also fix styledAvatars
  if (char.avatars.styledAvatars) {
    for (const [style, value] of Object.entries(char.avatars.styledAvatars)) {
      if (isCorruptedAvatar(value)) {
        if (fallback) {
          console.log(`    Copying ${fallback.variant} → styled:${style}`);
          char.avatars.styledAvatars[style] = fallback.value;
          fixed = true;
        } else {
          console.log(`    Clearing corrupted styled:${style} (no valid fallback)`);
          delete char.avatars.styledAvatars[style];
          fixed = true;
        }
      }
    }
  }

  // Mark as stale if we made any fixes so it regenerates on next use
  if (fixed) {
    char.avatars.stale = true;
  }

  return fixed;
}

async function fixCorruptedAvatars() {
  const client = await pool.connect();

  try {
    console.log(dryRun ? '🔍 DRY RUN - No changes will be made\n' : '🔧 FIXING corrupted avatar data\n');

    // Get all character rows
    const result = await client.query('SELECT id, user_id, data, metadata FROM characters ORDER BY id');
    console.log(`Found ${result.rows.length} character rows\n`);

    let corruptedCount = 0;
    let fixedCount = 0;
    let noFallbackCount = 0;

    for (const row of result.rows) {
      // Parse FULL DATA (not metadata) - this is where the actual avatars are stored
      let fullData;
      try {
        fullData = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
      } catch (e) {
        console.log(`⚠️  Row ${row.id}: Could not parse data, skipping`);
        continue;
      }

      if (!fullData || !fullData.characters) {
        continue;
      }

      // Check each character for corrupted avatars in the DATA column
      const corruptedChars = [];
      for (const char of fullData.characters) {
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
            // Check costumed
            if (char.avatars.costumed) {
              for (const [costume, value] of Object.entries(char.avatars.costumed)) {
                if (isCorruptedAvatar(value)) {
                  details.push(`costumed:${costume}="${JSON.stringify(value)}"`);
                }
              }
            }
            // Check styledAvatars
            if (char.avatars.styledAvatars) {
              for (const [style, value] of Object.entries(char.avatars.styledAvatars)) {
                if (isCorruptedAvatar(value)) {
                  details.push(`styled:${style}="${JSON.stringify(value)}"`);
                }
              }
            }

            // Find valid fallback
            const fallback = findValidVariant(char.avatars);
            const fallbackInfo = fallback ? `(fallback: ${fallback.variant})` : '(NO FALLBACK!)';

            console.log(`  ❌ ${char.name}: ${details.join(', ')} ${fallbackInfo}`);
          }
        }
      }

      if (corruptedChars.length === 0) {
        continue;
      }

      corruptedCount++;
      console.log(`\n📋 Row ${row.id} (user ${row.user_id}): ${corruptedChars.length} corrupted character(s)`);

      // Fix the corrupted avatars by copying from valid variants
      let rowFixed = false;
      let rowNoFallback = false;

      for (const char of fullData.characters) {
        if (hasCorruptedAvatars(char)) {
          const fallback = findValidVariant(char.avatars);
          if (!fallback) {
            rowNoFallback = true;
            noFallbackCount++;
          }

          if (!dryRun) {
            const wasFixed = fixCharacterAvatars(char);
            if (wasFixed) rowFixed = true;
          } else {
            // Dry run - just report what would happen
            if (fallback) {
              console.log(`    Would copy ${fallback.variant} to corrupted variants and mark stale`);
            } else {
              console.log(`    Would clear corrupted avatars and mark for regeneration`);
            }
          }
        }
      }

      // If no valid fallback for any character, mark avatar status as pending for regeneration
      if (rowNoFallback) {
        for (const char of fullData.characters) {
          if (char.avatars && !findValidVariant(char.avatars)) {
            if (!dryRun) {
              char.avatars.status = 'pending';
              char.avatars.stale = true;
              rowFixed = true;
            }
            console.log(`    Marked ${char.name} for avatar regeneration (status=pending)`);
          }
        }
      }

      if (dryRun) {
        console.log(`  ✓ Would fix corruption for: ${corruptedChars.join(', ')}`);
      } else if (rowFixed) {
        // Generate new metadata from fixed data
        const newMetadata = generateMetadata(fullData);

        // Update BOTH data and metadata columns
        await client.query(
          'UPDATE characters SET data = $1, metadata = $2 WHERE id = $3',
          [JSON.stringify(fullData), JSON.stringify(newMetadata), row.id]
        );
        fixedCount++;
        console.log(`  ✓ Fixed data & metadata for: ${corruptedChars.join(', ')}`);
      }
    }

    console.log('\n' + '='.repeat(60));
    if (dryRun) {
      console.log(`\n📊 Summary (DRY RUN):`);
      console.log(`   Found ${corruptedCount} rows with corrupted avatar data`);
      console.log(`   ${noFallbackCount} characters have no valid fallback (will regenerate)`);
      console.log(`\nRun without --dry-run to apply fixes.`);
    } else {
      console.log(`\n📊 Summary:`);
      console.log(`   Found ${corruptedCount} rows with corrupted avatar data`);
      console.log(`   Fixed ${fixedCount} rows`);
      console.log(`   ${noFallbackCount} characters marked for regeneration (no valid fallback)`);
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
