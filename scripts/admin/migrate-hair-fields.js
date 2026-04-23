/**
 * One-shot migration: drop the legacy simple hair fields (hairStyle, hairLength,
 * hairDensity) from every character record and every story's embedded characters.
 * detailedHairAnalysis is now the single source of truth for hair shape/length/
 * density/styling. hairColor is kept (no detailed equivalent).
 *
 * Uses in-DB JSONB operations so it doesn't pull multi-MB avatar blobs over the
 * wire. Handles:
 *   characters.data.physical                      — direct jsonb path strip
 *   characters.metadata.physical                  — direct jsonb path strip
 *   stories.data.characters[*].physical           — array iteration via jsonb_agg
 *   stories.metadata.characters[*].physical       — array iteration via jsonb_agg
 *   stories.data.visualBible.mainCharacters[*].physical — array iteration
 *
 * Run: `node scripts/admin/migrate-hair-fields.js` (real modifications).
 * Dry-run preview: `node scripts/admin/migrate-hair-fields.js --dry` (counts rows that WOULD change).
 */

require('dotenv').config();
const { Pool } = require('pg');

const LEGACY_FIELDS = ['hairStyle', 'hairLength', 'hairDensity'];
const DRY = process.argv.includes('--dry');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Remove the three legacy keys from a physical object expression. Uses the
// jsonb #- text[] path-removal operator chained three times; avoids the
// jsonb - text[] many-keys operator which was being mis-parsed in this
// environment (Postgres kept trying to cast the ARRAY literal as JSON).
const stripExpr = (physExpr) =>
  `((${physExpr}) #- '{hairStyle}'::text[] #- '{hairLength}'::text[] #- '{hairDensity}'::text[])`;

async function countOrMigrateCharacters() {
  // characters table stores the character as `data.characters[i]` (a wrapper
  // array), not top-level `data.physical`. Predicate + update iterate the
  // nested array.
  const predicate = `
    (data->'characters' IS NOT NULL AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(data->'characters','[]'::jsonb)) e
      WHERE e->'physical' ?| ARRAY['hairStyle','hairLength','hairDensity']
    ))
    OR (metadata->'characters' IS NOT NULL AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(metadata->'characters','[]'::jsonb)) e
      WHERE e->'physical' ?| ARRAY['hairStyle','hairLength','hairDensity']
    ))
  `;
  if (DRY) {
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM characters WHERE ${predicate}`);
    console.log(`characters: ${rows[0].n} row(s) would be updated`);
    return;
  }
  const sql = `
    UPDATE characters
    SET data = jsonb_set(data, '{characters}'::text[],
                         ${mapCharactersArraySql(`COALESCE(data->'characters','[]'::jsonb)`)},
                         true),
        metadata = CASE
                     WHEN metadata IS NOT NULL
                       THEN jsonb_set(metadata, '{characters}'::text[],
                                      ${mapCharactersArraySql(`COALESCE(metadata->'characters','[]'::jsonb)`)},
                                      true)
                     ELSE metadata
                   END
    WHERE ${predicate}
  `;
  const { rowCount } = await pool.query(sql);
  console.log(`characters: ${rowCount} row(s) updated`);
}

// Map an array of character objects: for each element, strip legacy keys from
// physical. Done server-side via a lateral subquery that keeps array order.
// arrExpr is the jsonb array path expression (e.g. data->'characters').
function mapCharactersArraySql(arrExpr) {
  // jsonb_typeof guard: only strip keys when `physical` is actually an object
  // (not null, not a string, not an array). Some legacy records store odd
  // values that break jsonb-minus-text[] otherwise.
  return `(
    SELECT COALESCE(jsonb_agg(
      CASE
        WHEN jsonb_typeof(c) = 'object' AND jsonb_typeof(c->'physical') = 'object'
          THEN jsonb_set(c, '{physical}'::text[], ${stripExpr(`c->'physical'`)}, true)
        ELSE c
      END
      ORDER BY ord
    ), '[]'::jsonb)
    FROM jsonb_array_elements(${arrExpr}) WITH ORDINALITY AS t(c, ord)
  )`;
}

async function countOrMigrateStories() {
  // Any story whose top-level characters, metadata characters, or VB main
  // characters array contains a physical object with a legacy key.
  const predicate = `
    EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(data->'characters','[]'::jsonb)) e
            WHERE e->'physical' ?| ARRAY['hairStyle','hairLength','hairDensity'])
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(metadata->'characters','[]'::jsonb)) e
               WHERE e->'physical' ?| ARRAY['hairStyle','hairLength','hairDensity'])
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(data->'visualBible'->'mainCharacters','[]'::jsonb)) e
               WHERE e->'physical' ?| ARRAY['hairStyle','hairLength','hairDensity'])
  `;
  if (DRY) {
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM stories WHERE ${predicate}`);
    console.log(`stories: ${rows[0].n} row(s) would be updated`);
    return;
  }
  const { rowCount } = await pool.query(`
    UPDATE stories
    SET data = jsonb_set(
                 CASE
                   WHEN data->'visualBible' IS NOT NULL
                     THEN jsonb_set(data, '{visualBible,mainCharacters}'::text[],
                                    ${mapCharactersArraySql(`COALESCE(data->'visualBible'->'mainCharacters','[]'::jsonb)`)},
                                    true)
                   ELSE data
                 END,
                 '{characters}'::text[],
                 ${mapCharactersArraySql(`COALESCE(data->'characters','[]'::jsonb)`)},
                 true),
        metadata = CASE
                     WHEN metadata IS NOT NULL
                       THEN jsonb_set(metadata, '{characters}'::text[],
                                      ${mapCharactersArraySql(`COALESCE(metadata->'characters','[]'::jsonb)`)},
                                      true)
                     ELSE metadata
                   END
    WHERE ${predicate}
  `);
  console.log(`stories: ${rowCount} row(s) updated`);
}

(async () => {
  console.log(`Mode: ${DRY ? 'DRY-RUN (no writes)' : 'LIVE (writing)'}`);
  console.log(`Dropping legacy fields: ${LEGACY_FIELDS.join(', ')}\n`);
  await countOrMigrateCharacters();
  await countOrMigrateStories();
  await pool.end();
  console.log('\nDone.');
})().catch(e => { console.error(e); pool.end(); process.exit(1); });
