/**
 * Compare all 12 faces from 3 runs to each other
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
        image: base64
      });
    }
  }
  return faces;
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
  console.log('Loading 12 faces from 3 runs...\n');
  const faces = await loadFaces();
  console.log(`Loaded ${faces.length} faces\n`);

  // Test if ArcFace works
  console.log('Testing ArcFace...');
  const testResult = await compareIdentity(faces[0].image, faces[1].image);
  if (testResult === null) {
    console.log('❌ ArcFace not working. Cannot compare faces.\n');
    return;
  }
  console.log(`✅ ArcFace working! Test similarity: ${(testResult * 100).toFixed(1)}%\n`);

  // Compare all pairs
  const withinRun = [];  // Comparisons within same run
  const betweenRun = []; // Comparisons between different runs

  const total = (faces.length * (faces.length - 1)) / 2;
  let count = 0;

  console.log(`Comparing ${total} pairs...\n`);

  for (let i = 0; i < faces.length; i++) {
    for (let j = i + 1; j < faces.length; j++) {
      count++;
      process.stdout.write(`\r  Progress: ${count}/${total}`);

      const similarity = await compareIdentity(faces[i].image, faces[j].image);
      if (similarity === null) continue;

      const pair = {
        pair: `${faces[i].id} vs ${faces[j].id}`,
        similarity,
        sameRun: faces[i].run === faces[j].run
      };

      if (faces[i].run === faces[j].run) {
        withinRun.push(pair);
      } else {
        betweenRun.push(pair);
      }
    }
  }

  console.log('\n\n');

  // Calculate stats
  const withinAvg = withinRun.reduce((a, b) => a + b.similarity, 0) / withinRun.length;
  const betweenAvg = betweenRun.reduce((a, b) => a + b.similarity, 0) / betweenRun.length;

  const withinMin = Math.min(...withinRun.map(p => p.similarity));
  const withinMax = Math.max(...withinRun.map(p => p.similarity));
  const betweenMin = Math.min(...betweenRun.map(p => p.similarity));
  const betweenMax = Math.max(...betweenRun.map(p => p.similarity));

  console.log('=== RESULTS ===\n');

  console.log('WITHIN SAME RUN (4 faces compared to each other):');
  console.log(`  Count: ${withinRun.length} pairs`);
  console.log(`  Average: ${(withinAvg * 100).toFixed(1)}%`);
  console.log(`  Range: ${(withinMin * 100).toFixed(1)}% - ${(withinMax * 100).toFixed(1)}%`);

  console.log('\nBETWEEN DIFFERENT RUNS:');
  console.log(`  Count: ${betweenRun.length} pairs`);
  console.log(`  Average: ${(betweenAvg * 100).toFixed(1)}%`);
  console.log(`  Range: ${(betweenMin * 100).toFixed(1)}% - ${(betweenMax * 100).toFixed(1)}%`);

  console.log('\n=== CONCLUSION ===');
  if (withinAvg > betweenAvg) {
    console.log(`Faces WITHIN same run are MORE similar (${(withinAvg * 100).toFixed(1)}% vs ${(betweenAvg * 100).toFixed(1)}%)`);
    console.log('→ More variation BETWEEN runs than within a single run');
  } else {
    console.log(`Faces BETWEEN runs are MORE similar (${(betweenAvg * 100).toFixed(1)}% vs ${(withinAvg * 100).toFixed(1)}%)`);
    console.log('→ More variation WITHIN a single run than between runs');
  }

  // Show some example pairs
  console.log('\n=== SAMPLE PAIRS ===\n');
  console.log('Within Run 1:');
  withinRun.filter(p => p.pair.startsWith('R1')).slice(0, 3).forEach(p => {
    console.log(`  ${p.pair}: ${(p.similarity * 100).toFixed(1)}%`);
  });

  console.log('\nBetween Run 1 and Run 2:');
  betweenRun.filter(p => p.pair.includes('R1') && p.pair.includes('R2')).slice(0, 3).forEach(p => {
    console.log(`  ${p.pair}: ${(p.similarity * 100).toFixed(1)}%`);
  });
}

main().catch(console.error);
