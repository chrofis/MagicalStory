/**
 * Landmark descriptions must not carry abbreviations into a children's book.
 *
 * A production story opened with "Die zwei Brüder laufen zusammen zur
 * SZU-Station" — an unexplained acronym on page 1. It was not the model's
 * invention: buildAvailableLandmarksSection hands the writer each landmark's
 * wikipedia_extract verbatim as DESCRIPTION, and the extract for Bahnhofplatz
 * (Zürich) ends "…des Tiefbahnhofs der Sihltal-Zürich-Uetliberg-Bahn (SZU)".
 *
 * Two guards exist and both are pinned here:
 *   1. stripLandmarkAbbreviations runs on the way INTO landmark_index, so a
 *      newly discovered landmark cannot reintroduce what the one-off cleanup
 *      removed.
 *   2. the landmark prompt block forbids carrying an abbreviation out of a
 *      DESCRIPTION at all — the durable half, since the long tail of
 *      encyclopedia jargon cannot be enumerated.
 *
 * Run: node tests/manual/landmarkAbbreviations.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
const eq = (a, b, msg) => { assert.strictEqual(a, b, `${msg}\n    got:  ${a}\n    want: ${b}`); console.log(`  ✓ ${msg}`); passed++; };
const ok = (c, msg) => { assert.ok(c, msg); console.log(`  ✓ ${msg}`); passed++; };

// landmarkPhotos.js pulls the world in on require, so slice the function out.
const SRC = fs.readFileSync(path.join(__dirname, '../../server/lib/landmarkPhotos.js'), 'utf8').replace(/\r\n/g, '\n');
const from = SRC.indexOf('const _ROMAN_NUMERAL');
const to = SRC.indexOf('\n}', SRC.indexOf('function stripLandmarkAbbreviations')) + 2;
assert.ok(from !== -1 && to > from, 'could not slice stripLandmarkAbbreviations');
const strip = new Function(`${SRC.slice(from, to)}\nreturn stripLandmarkAbbreviations;`)();

console.log('\nthe production case');
{
  const real = 'Auf dem Platz befindet sich eine Tramhaltestelle, darunter ein Teil der '
    + 'Einkaufspassage Shopville und des Tiefbahnhofs der Sihltal-Zürich-Uetliberg-Bahn (SZU).';
  const out = strip(real);
  ok(!/SZU/.test(out), 'the acronym that reached page 1 of a book is gone');
  ok(/Sihltal-Zürich-Uetliberg-Bahn\./.test(out), 'the full name survives — a story can still use it');
  ok(out.endsWith('der Sihltal-Zürich-Uetliberg-Bahn.'), 'no stray space before the full stop');
}

console.log('\nabbreviations are stripped, names are not');
{
  eq(strip('Der Zürcher Verkehrsverbund (ZVV) betreibt die Linie.'),
     'Der Zürcher Verkehrsverbund betreibt die Linie.', 'a transit acronym goes');
  eq(strip('Die Schweizerischen Bundesbahnen (SBB) fahren hier.'),
     'Die Schweizerischen Bundesbahnen fahren hier.', 'another one goes');
  // Roman numerals are part of a name, not an abbreviation.
  eq(strip('Kloster Fischingen unter Abt Johannes (II) wurde erweitert.'),
     'Kloster Fischingen unter Abt Johannes (II) wurde erweitert.', 'a Roman numeral stays');
  eq(strip('Die Kirche stammt aus dem XIX. Jahrhundert.'),
     'Die Kirche stammt aus dem XIX. Jahrhundert.', 'a bare Roman numeral is untouched');
  // Mixed case is a word, not an acronym.
  eq(strip('HSBC Private Bank (Suisse) SA ist eine Bank.'),
     'HSBC Private Bank (Suisse) SA ist eine Bank.', 'a mixed-case parenthetical stays');
}

console.log('\nedge cases');
{
  eq(strip(null), null, 'null passes through');
  eq(strip(''), '', 'empty passes through');
  eq(strip('Ein Platz ohne Abkürzung.'), 'Ein Platz ohne Abkürzung.', 'clean text is unchanged');
  eq(strip('Die Bahn (ABC) und der Bus (DEF) fahren.'), 'Die Bahn und der Bus fahren.',
     'several abbreviations in one sentence');
}

console.log('\nthe guard is wired into the WRITE path, not just the one-off script');
{
  ok(/normalize\(stripLandmarkAbbreviations\(landmark\.wikipediaExtract/.test(SRC),
     'saveLandmarkToIndex strips on the way in — a new landmark cannot reintroduce one');
  ok(/^\s*stripLandmarkAbbreviations,/m.test(SRC),
     'exported, so the cleanup script and this test share ONE definition');
}

console.log('\nthe prompt forbids copying wording out of a DESCRIPTION');
{
  const pb = fs.readFileSync(path.join(__dirname, '../../server/lib/promptBuilders.js'), 'utf8');
  ok(/DESCRIPTION is reference for you, not wording for the page/.test(pb),
     'the landmark block states the description is reference, not wording');
  ok(/Never carry an abbreviation, acronym or technical term from it into the story/.test(pb),
     'and forbids carrying an abbreviation into the story');
}

console.log(`\n✅ ALL ${passed} assertions passed (landmark abbreviations)\n`);
