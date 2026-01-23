#!/usr/bin/env node
/**
 * Migration: Convert avatar objects to strings
 *
 * Some legacy data has avatars stored as {imageData, clothing} objects
 * instead of just the imageData string. This script converts them to the
 * correct format.
 *
 * Checks:
 * - styledAvatars[artStyle][category]
 * - styledAvatars[artStyle].costumed[type]
 * - avatars.standard, avatars.winter, avatars.summer, avatars.formal
 * - avatars.costumed[type]
 *
 * Usage:
 *   node scripts/migrate-styled-avatars.js          # Dry run (preview changes)
 *   node scripts/migrate-styled-avatars.js --apply  # Apply changes
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false
});

const DRY_RUN = !process.argv.includes('--apply');

async function migrateStyledAvatars() {
  console.log(`\n🔄 Avatar Migration ${DRY_RUN ? '(DRY RUN)' : '(APPLYING CHANGES)'}\n`);

  try {
    // Get all character records
    const result = await pool.query('SELECT id, data FROM characters');
    console.log(`Found ${result.rows.length} character records\n`);

    let totalFixed = 0;
    let totalCharacters = 0;

    for (const row of result.rows) {
      const charData = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
      const characters = charData.characters || [];

      let recordModified = false;

      for (const char of characters) {
        if (!char.avatars) continue;

        let charFixed = 0;

        // Check regular avatar categories (standard, winter, summer, formal)
        const regularCategories = ['standard', 'winter', 'summer', 'formal'];
        for (const cat of regularCategories) {
          const value = char.avatars[cat];
          if (typeof value === 'object' && value.imageData) {
            console.log(`  📦 ${char.name} > avatars.${cat}: object → string`);
            char.avatars[cat] = value.imageData;
            charFixed++;
            recordModified = true;
          }
        }

        // Check costumed avatars (avatars.costumed[type])
        if (char.avatars.costumed && typeof char.avatars.costumed === 'object') {
          for (const [type, value] of Object.entries(char.avatars.costumed)) {
            if (typeof value === 'object' && value.imageData) {
              console.log(`  📦 ${char.name} > avatars.costumed.${type}: object → string`);
              char.avatars.costumed[type] = value.imageData;
              charFixed++;
              recordModified = true;
            }
          }
        }

        // Check styledAvatars
        const styledAvatars = char.avatars.styledAvatars;
        if (!styledAvatars) {
          if (charFixed > 0) {
            totalCharacters++;
            totalFixed += charFixed;
          }
          continue;
        }

        for (const artStyle of Object.keys(styledAvatars)) {
          const styleData = styledAvatars[artStyle];
          if (!styleData || typeof styleData !== 'object') continue;

          // Check regular categories (standard, winter, summer, formal)
          for (const category of Object.keys(styleData)) {
            if (category === 'costumed') {
              // Handle nested costumed object
              const costumed = styleData.costumed;
              if (costumed && typeof costumed === 'object') {
                for (const costumeType of Object.keys(costumed)) {
                  const value = costumed[costumeType];
                  if (typeof value === 'object' && value.imageData) {
                    console.log(`  📦 ${char.name} > styledAvatars.${artStyle}.costumed.${costumeType}: object → string`);
                    costumed[costumeType] = value.imageData;
                    charFixed++;
                    recordModified = true;
                  }
                }
              }
            } else {
              // Regular category
              const value = styleData[category];
              if (typeof value === 'object' && value.imageData) {
                console.log(`  📦 ${char.name} > styledAvatars.${artStyle}.${category}: object → string`);
                styleData[category] = value.imageData;
                charFixed++;
                recordModified = true;
              }
            }
          }
        }

        if (charFixed > 0) {
          totalCharacters++;
          totalFixed += charFixed;
        }
      }

      // Save if modified
      if (recordModified && !DRY_RUN) {
        await pool.query(
          'UPDATE characters SET data = $1 WHERE id = $2',
          [JSON.stringify(charData), row.id]
        );
        console.log(`  ✅ Saved changes for ${row.id}\n`);
      }
    }

    console.log(`\n${'='.repeat(50)}`);
    console.log(`Summary:`);
    console.log(`  - Characters with issues: ${totalCharacters}`);
    console.log(`  - Total fields fixed: ${totalFixed}`);

    if (DRY_RUN && totalFixed > 0) {
      console.log(`\n⚠️  This was a dry run. Run with --apply to make changes.`);
    } else if (totalFixed > 0) {
      console.log(`\n✅ Migration complete!`);
    } else {
      console.log(`\n✅ No issues found - all avatars are already strings.`);
    }

  } catch (err) {
    console.error('❌ Migration error:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrateStyledAvatars();
