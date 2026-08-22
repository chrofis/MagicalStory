#!/usr/bin/env node
/**
 * Remove abbreviations from `landmark_index.wikipedia_extract`.
 *
 * WHY: the extract is handed to the story writer verbatim, labelled
 * `DESCRIPTION:`, under an instruction to "incorporate it authentically into
 * your story". So anything in it can reach a page a child reads. Bahnhofplatz
 * (Zürich) carries "…des Tiefbahnhofs der Sihltal-Zürich-Uetliberg-Bahn (SZU)",
 * and a production story duly opened with "Die zwei Brüder laufen zusammen zur
 * SZU-Station" — an unexplained acronym in a picture book.
 *
 * These extracts are written for adult encyclopedia readers. Stripping the
 * parenthetical acronym keeps the full name, which is what a story can actually
 * use, and removes the token that leaks.
 *
 *   "Sihltal-Zürich-Uetliberg-Bahn (SZU)"  ->  "Sihltal-Zürich-Uetliberg-Bahn"
 *
 * Roman numerals are NOT abbreviations — "(II)", "(XIX)" belong to the name and
 * are left alone.
 *
 * wikipedia_extract is derived data: it can be re-fetched from Wikipedia, so
 * editing in place loses nothing that is not reproducible.
 *
 * Usage:
 *   node scripts/admin/strip-landmark-abbreviations.js --dry-run
 *   node scripts/admin/strip-landmark-abbreviations.js
 */

require('dotenv').config();
const { Pool } = require('pg');

const dryRun = process.argv.includes('--dry-run');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const ROMAN = /^[IVXLCDM]+$/;

// Acronyms that appear BARE, with no parenthetical to strip — mostly Swiss
// transit operators in station extracts. Expanded rather than deleted: the
// sentence still needs a subject, and the full name is what a story can use.
// Names are left alone; only extract prose is rewritten, so "Basel SBB railway
// station" keeps its title.
const EXPANSIONS = [
  [/\bSZU\b/g, 'Sihltal-Zürich-Uetliberg-Bahn'],
  [/\bZVV\b/g, 'Zürcher Verkehrsverbund'],
  [/\bSBB CFF FFS\b/g, 'Schweizerische Bundesbahnen'],
  [/\bSBB\b/g, 'Schweizerische Bundesbahnen'],
  [/\bVBZ\b/g, 'Verkehrsbetriebe Zürich'],
  [/\bBLS\b/g, 'BLS Lötschbergbahn'],
  [/\bRhB\b/g, 'Rhätische Bahn'],
];

/** Strip " (ABC)" abbreviations, keeping Roman numerals and the full name. */
function stripAbbreviations(text) {
  if (!text) return text;
  let out = text.replace(/\s*\(([A-ZÄÖÜ][A-ZÄÖÜ0-9.\-]{1,7})\)/g, (match, abbr) => {
    if (ROMAN.test(abbr.replace(/[.\-]/g, ''))) return match;   // "(II)" stays
    return '';
  });
  for (const [re, full] of EXPANSIONS) out = out.replace(re, full);
  // Collapse whitespace the removal may have doubled, and tidy a space that
  // ended up before punctuation.
  out = out.replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.;:])/g, '$1');
  return out.trim();
}

async function main() {
  const { rows } = await pool.query(`
    SELECT id, name, wikipedia_extract
    FROM landmark_index
    WHERE wikipedia_extract IS NOT NULL
      AND (wikipedia_extract ~ '\\([A-ZÄÖÜ]{2,6}\\)'
           OR wikipedia_extract ~ '\\y(SZU|ZVV|SBB|VBZ|BLS|RhB)\\y')
    ORDER BY id`);
  console.log(`Extracts with an abbreviation: ${rows.length}${dryRun ? '  (DRY RUN)' : ''}\n`);

  let changed = 0;
  const samples = [];
  for (const r of rows) {
    const cleaned = stripAbbreviations(r.wikipedia_extract);
    if (cleaned === r.wikipedia_extract) continue;
    changed++;
    if (samples.length < 12) {
      const i = r.wikipedia_extract.search(/\([A-ZÄÖÜ]{2,6}\)/);
      samples.push({
        name: r.name,
        before: r.wikipedia_extract.slice(Math.max(0, i - 55), i + 12).replace(/\s+/g, ' '),
      });
    }
    if (!dryRun) {
      await pool.query('UPDATE landmark_index SET wikipedia_extract = $1 WHERE id = $2', [cleaned, r.id]);
    }
  }

  console.log(`Rows ${dryRun ? 'that would change' : 'changed'}: ${changed}\n`);
  console.log('  samples (text around the removed abbreviation):');
  samples.forEach(s => console.log(`    ${s.name.slice(0, 26).padEnd(28)} …${s.before}`));

  if (!dryRun) {
    const { rows: left } = await pool.query(
      `SELECT count(*) n FROM landmark_index WHERE wikipedia_extract ~ '\\([A-ZÄÖÜ]{2,6}\\)'`);
    console.log(`\n  remaining (Roman numerals and the like): ${left[0].n}`);
  }
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
