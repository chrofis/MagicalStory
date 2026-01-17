/**
 * Compare all 12 generated faces to the original photo
 * Find the best match using ArcFace
 */

const fs = require('fs');
const path = require('path');

const PHOTO_ANALYZER_URL = 'http://127.0.0.1:5000';

// The 3 run directories
const runs = [
  'face-variations-1768656355768',
  'face-variations-1768656376014',
  'face-variations-1768656392852'
];

// Original photo
const originalPath = path.join(__dirname, 'test image inputs', 'Manuel_body_no_bg.png');

// Load all 12 face images
async function loadFaces() {
  const faces = [];
  for (let r = 0; r < runs.length; r++) {
    const runDir = path.join(__dirname, 'test-output', runs[r]);
    for (let f = 1; f <= 4; f++) {
      const filename = `2-variation-${f}-${['top-left', 'top-right', 'bottom-left', 'bottom-right'][f-1]}.jpg`;
      const filepath = path.join(runDir, filename);
      const buffer = fs.readFileSync(filepath);
      const base64 = `data:image/jpeg;base64,${buffer.toString('base64')}`;
      faces.push({
        id: `R${r+1}F${f}`,
        run: r + 1,
        face: f,
        position: ['Eye Focus', 'Structure Focus', 'Detail Focus', 'Gestalt Focus'][f-1],
        filepath,
        image: base64
      });
    }
  }
  return faces;
}

// Load original photo
function loadOriginal() {
  const buffer = fs.readFileSync(originalPath);
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

// Compare two faces using ArcFace
async function compareIdentity(image1, image2) {
  try {
    const response = await fetch(`${PHOTO_ANALYZER_URL}/compare-identity`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image1, image2 })
    });
    const result = await response.json();
    return result.success ? result.similarity : null;
  } catch (err) {
    return null;
  }
}

async function main() {
  console.log('Loading original photo and 12 generated faces...\n');

  const original = loadOriginal();
  const faces = await loadFaces();

  console.log(`Original: ${originalPath}`);
  console.log(`Comparing ${faces.length} faces to original...\n`);

  const results = [];

  for (let i = 0; i < faces.length; i++) {
    process.stdout.write(`\r  Progress: ${i+1}/${faces.length}`);

    const similarity = await compareIdentity(original, faces[i].image);
    if (similarity !== null) {
      results.push({
        ...faces[i],
        similarity,
        image: undefined // Don't store in results
      });
    }
  }

  console.log('\n\n');

  // Sort by similarity (highest first)
  results.sort((a, b) => b.similarity - a.similarity);

  console.log('=== ALL RESULTS (sorted by similarity to original) ===\n');

  results.forEach((r, idx) => {
    const marker = idx === 0 ? ' <-- BEST MATCH' : '';
    console.log(`${idx + 1}. ${r.id} (Run ${r.run}, ${r.position}): ${(r.similarity * 100).toFixed(1)}%${marker}`);
  });

  console.log('\n=== SUMMARY BY RUN ===\n');

  for (let run = 1; run <= 3; run++) {
    const runResults = results.filter(r => r.run === run);
    const avg = runResults.reduce((a, b) => a + b.similarity, 0) / runResults.length;
    const best = runResults[0];
    console.log(`Run ${run}: Avg ${(avg * 100).toFixed(1)}%, Best: ${best.id} (${best.position}) at ${(best.similarity * 100).toFixed(1)}%`);
  }

  console.log('\n=== BEST MATCH ===\n');
  const best = results[0];
  console.log(`Winner: ${best.id}`);
  console.log(`  Run: ${best.run}`);
  console.log(`  Position: ${best.position}`);
  console.log(`  Similarity: ${(best.similarity * 100).toFixed(1)}%`);
  console.log(`  File: ${best.filepath}`);
}

main().catch(console.error);
