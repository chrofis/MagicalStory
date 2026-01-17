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
        filename,
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

// First extract face embedding from original (with face detection)
async function getEmbedding(imageBase64, extractFace = true) {
  try {
    const response = await fetch(`${PHOTO_ANALYZER_URL}/face-embedding`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image: imageBase64,
        extract_face: extractFace
      })
    });
    const result = await response.json();
    if (result.success) {
      return result.embedding;
    }
    console.error('Embedding error:', result.error);
    return null;
  } catch (err) {
    console.error('Fetch error:', err.message);
    return null;
  }
}

// Compare two embeddings
async function compareEmbeddings(emb1, emb2) {
  try {
    const response = await fetch(`${PHOTO_ANALYZER_URL}/compare-identity`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embedding1: emb1, embedding2: emb2 })
    });
    const result = await response.json();
    return result.success ? result.similarity : null;
  } catch (err) {
    return null;
  }
}

async function main() {
  console.log('=== Comparing 12 generated faces to original photo ===\n');

  const original = loadOriginal();
  const faces = await loadFaces();

  console.log(`Original: ${originalPath}`);
  console.log(`Generated faces: ${faces.length}\n`);

  // Step 1: Get embedding from original (with face extraction)
  console.log('Step 1: Extracting face embedding from original photo...');
  const originalEmbedding = await getEmbedding(original, true);

  if (!originalEmbedding) {
    console.log('ERROR: Could not extract face from original photo!');
    return;
  }
  console.log(`  Got ${originalEmbedding.length}-dimensional embedding\n`);

  // Step 2: Get embeddings from all variations (they are already face crops)
  console.log('Step 2: Getting embeddings from all 12 variations...\n');

  const results = [];
  for (let i = 0; i < faces.length; i++) {
    process.stdout.write(`\r  Progress: ${i+1}/${faces.length}`);

    // Variations are already face crops, no need for face extraction
    const varEmbedding = await getEmbedding(faces[i].image, false);

    if (varEmbedding) {
      const similarity = await compareEmbeddings(originalEmbedding, varEmbedding);
      if (similarity !== null) {
        results.push({
          ...faces[i],
          similarity,
          image: undefined
        });
      }
    }
  }

  console.log('\n\n');

  // Sort by similarity (highest first)
  results.sort((a, b) => b.similarity - a.similarity);

  console.log('=== ALL RESULTS (sorted by similarity to original) ===\n');

  results.forEach((r, idx) => {
    const marker = idx === 0 ? ' <-- BEST MATCH' : '';
    console.log(`${idx + 1}. ${r.id} (Run ${r.run}, ${r.position}): ${(r.similarity * 100).toFixed(1)}%${marker}`);
    console.log(`      File: ${r.filename}`);
  });

  console.log('\n=== SUMMARY BY RUN ===\n');

  for (let run = 1; run <= 3; run++) {
    const runResults = results.filter(r => r.run === run);
    const avg = runResults.reduce((a, b) => a + b.similarity, 0) / runResults.length;
    const best = runResults.sort((a, b) => b.similarity - a.similarity)[0];
    console.log(`Run ${run}: Avg ${(avg * 100).toFixed(1)}%, Best: ${best.id} (${best.position}) at ${(best.similarity * 100).toFixed(1)}%`);
  }

  console.log('\n=== BEST MATCH ===\n');
  const best = results[0];
  console.log(`Winner: ${best.id}`);
  console.log(`  Run: ${best.run}`);
  console.log(`  Position: ${best.position}`);
  console.log(`  Similarity: ${(best.similarity * 100).toFixed(1)}%`);
  console.log(`  Full path: ${best.filepath}`);
}

main().catch(console.error);
