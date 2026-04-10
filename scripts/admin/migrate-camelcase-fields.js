#!/usr/bin/env node
/**
 * Migrate Snake_Case JSONB Keys to camelCase
 *
 * Renames top-level character fields stored with snake_case keys in JSONB
 * to their canonical camelCase equivalents:
 *
 *   physical_traits_source → physicalTraitsSource
 *   generated_outfits      → generatedOutfits
 *   structured_clothing    → structuredClothing
 *   age_category           → ageCategory
 *   reference_outfit       → referenceOutfit
 *
 * Migrates both:
 * 1. characters table - user's character definitions (data + metadata columns)
 * 2. stories table - embedded characters in visualBible
 *
 * Usage:
 *   node scripts/admin/migrate-camelcase-fields.js [--dry-run] [--user-id=X]
 *
 * Options:
 *   --dry-run    Preview changes without saving
 *   --user-id=X  Migrate only a specific user's data
 */

require('dotenv').config();
const { Pool } = require('pg');

// Parse arguments
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const userIdArg = args.find(a => a.startsWith('--user-id='));
const TARGET_USER_ID = userIdArg ? parseInt(userIdArg.split('=')[1], 10) : null;

// Fields to rename: { oldKey: newKey }
const RENAMES = {
  physical_traits_source: 'physicalTraitsSource',
  generated_outfits: 'generatedOutfits',
  structured_clothing: 'structuredClothing',
  age_category: 'ageCategory',
  reference_outfit: 'referenceOutfit',
};

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false,
});

const stats = {
  characters: { rows: 0, chars: 0, renames: 0 },
  stories: { rows: 0, chars: 0, renames: 0 },
};

/**
 * Rename snake_case keys to camelCase on a single character object (mutates in place).
 * Returns the number of fields renamed.
 */
function renameFields(char) {
  if (!char || typeof char !== 'object') return 0;
  let count = 0;
  for (const [oldKey, newKey] of Object.entries(RENAMES)) {
    if (oldKey in char) {
      // Only rename if the new key doesn't already exist (avoid clobbering)
      if (!(newKey in char) || char[newKey] == null) {
        char[newKey] = char[oldKey];
      }
      delete char[oldKey];
      count++;
    }
  }
  return count;
}

/**
 * Migrate characters table (data + metadata columns)
 */
async function migrateCharactersTable() {
  console.log('\n=== Migrating characters table ===');

  let query = 'SELECT id, user_id, data, metadata FROM characters';
  const params = [];
  if (TARGET_USER_ID) {
    query += ' WHERE user_id = $1';
    params.push(TARGET_USER_ID);
  }

  const result = await pool.query(query, params);
  console.log(`Found ${result.rows.length} rows`);

  for (const row of result.rows) {
    stats.characters.rows++;
    const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
    const metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {});

    if (!data?.characters || !Array.isArray(data.characters)) continue;

    let rowRenames = 0;

    // Rename in data.characters
    for (const char of data.characters) {
      stats.characters.chars++;
      const n = renameFields(char);
      if (n > 0) {
        rowRenames += n;
        console.log(`  [data] ${char.name || char.id}: renamed ${n} field(s)`);
      }
    }

    // Rename in metadata.characters
    if (metadata?.characters && Array.isArray(metadata.characters)) {
      for (const char of metadata.characters) {
        const n = renameFields(char);
        if (n > 0) {
          console.log(`  [meta] ${char.name || char.id}: renamed ${n} field(s)`);
        }
      }
    }

    if (rowRenames > 0) {
      stats.characters.renames += rowRenames;
      if (!DRY_RUN) {
        await pool.query(
          'UPDATE characters SET data = $1, metadata = $2 WHERE id = $3',
          [JSON.stringify(data), JSON.stringify(metadata), row.id]
        );
        console.log(`  Saved row ${row.id} (user ${row.user_id})`);
      }
    }
  }
}

/**
 * Migrate stories table — visualBible.mainCharacters
 */
async function migrateStoriesTable() {
  console.log('\n=== Migrating stories table (visualBible) ===');

  // Story data (including visualBible) is stored in the data JSONB column
  let query = "SELECT id, user_id, data FROM stories WHERE data->'visualBible' IS NOT NULL";
  const params = [];
  if (TARGET_USER_ID) {
    query += ' AND user_id = $1';
    params.push(TARGET_USER_ID);
  }

  const result = await pool.query(query, params);
  console.log(`Found ${result.rows.length} stories to check`);

  for (const row of result.rows) {
    stats.stories.rows++;
    const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
    const vb = data?.visualBible;
    if (!vb?.mainCharacters || !Array.isArray(vb.mainCharacters)) continue;

    let rowRenames = 0;
    const storyTitle = data.title || row.id;

    for (const char of vb.mainCharacters) {
      stats.stories.chars++;
      const n = renameFields(char);
      if (n > 0) {
        rowRenames += n;
        console.log(`  [story "${storyTitle}"] ${char.name || char.id}: renamed ${n} field(s)`);
      }
    }

    if (rowRenames > 0) {
      stats.stories.renames += rowRenames;
      if (!DRY_RUN) {
        await pool.query(
          'UPDATE stories SET data = $1 WHERE id = $2',
          [JSON.stringify(data), row.id]
        );
        console.log(`  Saved story ${row.id} ("${storyTitle}")`);
      }
    }
  }
}

async function main() {
  console.log('=== Migrate snake_case JSONB keys to camelCase ===');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE'}`);
  if (TARGET_USER_ID) console.log(`Target user: ${TARGET_USER_ID}`);
  console.log(`Fields to rename: ${Object.entries(RENAMES).map(([k, v]) => `${k} → ${v}`).join(', ')}`);

  try {
    await migrateCharactersTable();
    await migrateStoriesTable();

    console.log('\n=== Summary ===');
    console.log(`Characters table: ${stats.characters.rows} rows, ${stats.characters.chars} characters, ${stats.characters.renames} renames`);
    console.log(`Stories table: ${stats.stories.rows} rows, ${stats.stories.chars} characters, ${stats.stories.renames} renames`);
    if (DRY_RUN) console.log('\n(Dry run — no changes written. Remove --dry-run to apply.)');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
