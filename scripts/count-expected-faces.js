require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const storyId = process.argv[2];
  if (!storyId) {
    console.log('Usage: node scripts/count-expected-faces.js <storyId>');
    process.exit(1);
  }

  const result = await pool.query('SELECT data FROM stories WHERE id = $1', [storyId]);
  const story = result.rows[0].data;

  console.log('Expected faces per page:\n');
  let totalExpected = 0;
  const expectedByPage = {};

  for (const scene of story.sceneImages || []) {
    const chars = (scene.referencePhotos || []).map(p => p.name).filter(Boolean);
    totalExpected += chars.length;
    expectedByPage[scene.pageNumber] = chars;
    console.log('Page ' + scene.pageNumber + ': ' + chars.length + ' chars - ' + chars.join(', '));
  }

  console.log('\n========================================');
  console.log('TOTAL EXPECTED: ' + totalExpected + ' faces');

  // Compare with extracted
  const manifestPath = path.join('output', `story-${storyId}`, 'faces-manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.log('\nNo manifest found. Run extract-faces.js first.');
    await pool.end();
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath));
  console.log('TOTAL EXTRACTED: ' + manifest.totalFaces + ' faces');
  console.log('MISSING: ' + (totalExpected - manifest.totalFaces) + ' faces');

  // Breakdown by page
  console.log('\n========================================');
  console.log('Comparison by page:\n');

  const extractedByPage = {};
  for (const f of manifest.faces) {
    extractedByPage[f.page] = extractedByPage[f.page] || [];
    extractedByPage[f.page].push(f.character);
  }

  for (let p = 1; p <= 15; p++) {
    const expected = expectedByPage[p] || [];
    const extracted = extractedByPage[p] || [];
    const missing = expected.filter(c => !extracted.includes(c));
    const extra = extracted.filter(c => !expected.includes(c) && c !== 'unknown');
    const wrong = extracted.filter(c => c === 'unknown');

    let status = '✓';
    if (missing.length > 0 || extra.length > 0 || wrong.length > 0) status = '⚠️';
    if (extracted.length === 0 && expected.length > 0) status = '❌';

    console.log(status + ' Page ' + p + ':');
    console.log('   Expected: ' + expected.join(', '));
    console.log('   Extracted: ' + extracted.join(', '));
    if (missing.length) console.log('   MISSING: ' + missing.join(', '));
    if (wrong.length) console.log('   UNKNOWN: ' + wrong.length + ' unidentified');
  }

  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
