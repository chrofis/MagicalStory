#!/usr/bin/env node
/**
 * Add iconic Swiss landmarks to landmark_index by direct Wikipedia title.
 *
 * The existing indexer uses Wikipedia geosearch (radius-based, filtered by
 * relevance score). It systematically misses several well-known landmarks
 * — Grossmünster, Bahnhofstrasse Zürich, Jet d'Eau, Cathédrale Saint-Pierre,
 * Zytglogge, Bundeshaus, etc. — because they don't always pass the radius
 * + score thresholds, even though they're the FIRST thing people search for.
 *
 * This script bypasses the geosearch and looks up each landmark by exact
 * Wikipedia page title (preferring the city's native language). It then
 * extracts the main photo from Wikimedia and UPSERTs into landmark_index.
 *
 * Usage:
 *   node scripts/admin/add-iconic-landmarks.js              # dry-run
 *   node scripts/admin/add-iconic-landmarks.js --push       # write to DB
 *
 * Decision context: docs/decisions.md → "landmark_index iconic-fill" (to add).
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { Pool } = require('pg');

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)=(.*)$/);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), 'true'];
}));
const PUSH = args.push === 'true';

// Landmarks to fetch — Wikipedia title + nearest_city + lang.
// Iconic = the FIRST landmark a parent in that city would name when asked
// "name a famous spot in your town." Sourced by hand, not geosearched.
const ICONS = [
  // ─── Zürich ──────────────────────────────────────────────────────────
  { title: 'Grossmünster',                              city: 'Zürich',    lang: 'de' },
  { title: 'Fraumünster',                               city: 'Zürich',    lang: 'de' },
  { title: 'Bahnhofstrasse (Zürich)',                   city: 'Zürich',    lang: 'de' },
  { title: 'Zürichsee',                                 city: 'Zürich',    lang: 'de' },
  { title: 'Zürich Hauptbahnhof',                       city: 'Zürich',    lang: 'de' },
  { title: 'St. Peter (Zürich)',                        city: 'Zürich',    lang: 'de' },
  // ─── Bern ────────────────────────────────────────────────────────────
  { title: 'Zytglogge',                                 city: 'Bern',      lang: 'de' },
  { title: 'Bundeshaus (Bern)',                         city: 'Bern',      lang: 'de' },
  { title: 'Bärenpark Bern',                            city: 'Bern',      lang: 'de' },
  { title: 'Berner Münster',                            city: 'Bern',      lang: 'de' },
  { title: 'Bundesplatz (Bern)',                        city: 'Bern',      lang: 'de' },
  { title: 'Käfigturm',                                 city: 'Bern',      lang: 'de' },
  // ─── Basel ───────────────────────────────────────────────────────────
  { title: 'Basler Münster',                            city: 'Basel',     lang: 'de' },
  { title: 'Spalentor',                                 city: 'Basel',     lang: 'de' },
  { title: 'Rathaus (Basel)',                           city: 'Basel',     lang: 'de' },
  { title: 'Mittlere Brücke',                           city: 'Basel',     lang: 'de' }, // already in DB, this UPDATE fills any missing photo
  { title: 'Pfalz (Basel)',                             city: 'Basel',     lang: 'de' },
  // ─── Genève ──────────────────────────────────────────────────────────
  { title: "Jet d'eau de Genève",                       city: 'Genève',    lang: 'fr' },
  { title: 'Cathédrale Saint-Pierre de Genève',         city: 'Genève',    lang: 'fr' },
  { title: 'Monument international de la Réformation',  city: 'Genève',    lang: 'fr' },
  { title: 'Parc des Bastions',                         city: 'Genève',    lang: 'fr' },
  { title: 'Pont du Mont-Blanc',                        city: 'Genève',    lang: 'fr' },
  // ─── Lausanne ────────────────────────────────────────────────────────
  { title: 'Cathédrale de Lausanne',                    city: 'Lausanne',  lang: 'fr' },
  { title: "Château d'Ouchy",                           city: 'Lausanne',  lang: 'fr' },
  { title: 'Esplanade de Montbenon',                    city: 'Lausanne',  lang: 'fr' },
];

/**
 * Fetch a single Wikipedia page by title. Returns:
 *   { pageid, wikidata, title, photoUrl, photoDescription, lat, lon, extract }
 * or null if no usable photo / page missing.
 */
async function fetchLandmark(title, lang) {
  const base = `https://${lang}.wikipedia.org/w/api.php`;
  const params = new URLSearchParams({
    action: 'query',
    titles: title,
    prop: 'pageimages|coordinates|extracts|pageprops',
    piprop: 'original',
    pithumbsize: '1600',
    exintro: 'true',
    explaintext: 'true',
    coprimary: 'primary',
    format: 'json',
    formatversion: '2',
    origin: '*',
  });
  const res = await fetch(`${base}?${params}`, { headers: { 'User-Agent': 'MagicalStory landmark indexer/1.0 (info@magicalstory.ch)' } });
  if (!res.ok) throw new Error(`Wikipedia ${lang} HTTP ${res.status}`);
  const data = await res.json();
  const page = data?.query?.pages?.[0];
  if (!page || page.missing) return null;

  const photoUrl = page.original?.source || null;
  if (!photoUrl) return null;

  const coord = page.coordinates?.[0];
  return {
    pageid: page.pageid,
    wikidata: page.pageprops?.wikibase_item || null,
    title: page.title,
    photoUrl,
    photoDescription: (page.extract || '').slice(0, 600),
    lat: coord?.lat ?? null,
    lon: coord?.lon ?? null,
  };
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  console.log(PUSH ? '⚠️  PUSH MODE — writing to DB' : 'DRY-RUN — no writes');
  console.log(`Processing ${ICONS.length} iconic landmarks…\n`);

  let added = 0, updated = 0, skipped = 0, missing = 0;

  for (const spec of ICONS) {
    process.stdout.write(`  ${spec.title.padEnd(42)} `);
    let landmark;
    try {
      landmark = await fetchLandmark(spec.title, spec.lang);
    } catch (err) {
      console.log('✗ fetch failed:', err.message);
      missing++;
      continue;
    }
    if (!landmark) {
      console.log('✗ no page / no photo on Wikipedia');
      missing++;
      continue;
    }

    // Check if already in landmark_index — either by exact name OR by
    // wikidata_qid (Wikipedia's stable cross-language identifier). The qid
    // check catches the case where the same landmark exists under a different
    // local name (e.g. "Zürich HB" already indexed; we're looking up the
    // alternate "Zürich Hauptbahnhof" which points to the same Wikidata Q).
    const existing = await pool.query(
      `SELECT id, name, photo_url FROM landmark_index
        WHERE name = $1 OR (wikidata_qid IS NOT NULL AND wikidata_qid = $2)
        LIMIT 1`,
      [landmark.title, landmark.wikidata]
    );

    if (PUSH) {
      if (existing.rowCount > 0) {
        const row = existing.rows[0];
        if (row.photo_url) {
          // Existing entry — patch nearest_city + RENAME to the canonical
          // local-language name. The Wikipedia geosearch indexer stored
          // some Swiss landmarks under their French/English Wikipedia
          // titles (e.g. Bundeshaus → "Palais fédéral"). The
          // creative-generation script does ILIKE '%<name>%' lookups, so
          // 'Bundeshaus' wouldn't find 'Palais fédéral'. Rename to the
          // local-language canonical name to make the iconic lookups
          // work consistently.
          if (row.name !== landmark.title) {
            // Verify the target name isn't already taken by a different row
            const clash = await pool.query(
              `SELECT id FROM landmark_index WHERE name = $1 AND id != $2 LIMIT 1`,
              [landmark.title, row.id]
            );
            if (clash.rowCount === 0) {
              await pool.query(
                `UPDATE landmark_index SET name = $1, nearest_city = COALESCE(nearest_city, $2), updated_at = NOW() WHERE id = $3`,
                [landmark.title, spec.city, row.id]
              );
              console.log('↻ renamed "' + row.name + '" → "' + landmark.title + '" (kept photo)');
              updated++;
              continue;
            } else {
              console.log('⚠ canonical name "' + landmark.title + '" already taken by another row — leaving "' + row.name + '" as-is');
            }
          }
          await pool.query(
            `UPDATE landmark_index SET nearest_city = COALESCE(nearest_city, $1), updated_at = NOW() WHERE id = $2`,
            [spec.city, row.id]
          );
          console.log('= already has photo, skipping — name "' + row.name + '"');
          skipped++;
          continue;
        }
        await pool.query(
          `UPDATE landmark_index
             SET photo_url = $1, photo_description = $2, photo_source = 'wikipedia',
                 updated_at = NOW(), nearest_city = COALESCE(nearest_city, $3),
                 latitude = COALESCE(latitude, $4), longitude = COALESCE(longitude, $5),
                 wikipedia_page_id = COALESCE(wikipedia_page_id, $6),
                 wikidata_qid = COALESCE(wikidata_qid, $7),
                 lang = COALESCE(lang, $8)
           WHERE id = $9`,
          [landmark.photoUrl, landmark.photoDescription, spec.city,
           landmark.lat, landmark.lon, landmark.pageid, landmark.wikidata, spec.lang, row.id]
        );
        console.log('✓ updated (added photo to existing entry "' + row.name + '")');
        updated++;
      } else {
        await pool.query(
          `INSERT INTO landmark_index
             (name, wikipedia_page_id, wikidata_qid, lang, latitude, longitude,
              nearest_city, country, photo_url, photo_description, photo_source,
              created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'Switzerland',$8,$9,'wikipedia',NOW(),NOW())`,
          [landmark.title, landmark.pageid, landmark.wikidata, spec.lang,
           landmark.lat, landmark.lon, spec.city,
           landmark.photoUrl, landmark.photoDescription]
        );
        console.log('✓ added');
        added++;
      }
    } else {
      const action = existing.rowCount > 0
        ? (existing.rows[0].photo_url ? '= would skip' : '~ would update photo')
        : '+ would add';
      console.log(`${action} (photo: ${landmark.photoUrl.split('/').pop().slice(0, 50)})`);
    }
  }

  console.log(`\n━━━ SUMMARY ━━━`);
  console.log(`  ${PUSH ? 'Added' : 'Would add'}:    ${added}`);
  console.log(`  ${PUSH ? 'Updated' : 'Would update'}:  ${updated}`);
  console.log(`  ${PUSH ? 'Skipped' : 'Would skip'}:   ${skipped}`);
  console.log(`  Missing/no photo: ${missing}`);
  if (!PUSH) console.log(`\nRe-run with --push to write to DB.`);
  await pool.end();
}

main().catch(err => { console.error('Failed:', err.message); process.exit(1); });
