#!/usr/bin/env node
/**
 * ArcFace Consistency Test
 *
 * Tests face consistency using ArcFace embeddings (free, local).
 * Compares all face extractions for each character to find outliers.
 *
 * Usage:
 *   node scripts/test-arcface-consistency.js output/story-<id>/
 *
 * Input:
 *   - extractions.json from analyze-story-characters.js
 *   - faces/ folder with extracted face images
 *
 * Output:
 *   - arcface-analysis.json - Consistency scores and outliers
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

// ============================================================================
// CONFIG
// ============================================================================

const PHOTO_ANALYZER_URL = process.env.PHOTO_ANALYZER_URL || 'http://localhost:5000';

// ArcFace similarity thresholds
const THRESHOLDS = {
  SAME_PERSON_HIGH: 0.60,    // High confidence same person
  SAME_PERSON_MEDIUM: 0.45,  // Medium confidence
  SIMILAR: 0.30,             // Somewhat similar
};

// ============================================================================
// ARCFACE API
// ============================================================================

async function getArcFaceEmbedding(imagePath) {
  const imageData = fs.readFileSync(imagePath);
  const base64 = imageData.toString('base64');

  try {
    const response = await fetch(`${PHOTO_ANALYZER_URL}/arcface-embedding`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: base64 }),
    });

    if (!response.ok) {
      console.error(`ArcFace embedding failed: ${response.status}`);
      return null;
    }

    const result = await response.json();
    return result.embedding;
  } catch (err) {
    console.error(`ArcFace error: ${err.message}`);
    return null;
  }
}

async function compareFaces(image1Path, image2Path) {
  const img1Data = fs.readFileSync(image1Path).toString('base64');
  const img2Data = fs.readFileSync(image2Path).toString('base64');

  try {
    const response = await fetch(`${PHOTO_ANALYZER_URL}/compare-identity`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image1: img1Data,
        image2: img2Data,
      }),
    });

    if (!response.ok) {
      return null;
    }

    return await response.json();
  } catch (err) {
    console.error(`Compare error: ${err.message}`);
    return null;
  }
}

// ============================================================================
// ANALYSIS
// ============================================================================

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

function findOutliers(similarities, threshold) {
  // Find appearances with low average similarity to others
  const avgSimilarities = similarities.map((row, i) => {
    const others = row.filter((_, j) => j !== i);
    return others.length > 0 ? others.reduce((a, b) => a + b, 0) / others.length : 1;
  });

  const outliers = [];
  for (let i = 0; i < avgSimilarities.length; i++) {
    if (avgSimilarities[i] < threshold) {
      outliers.push({
        index: i,
        avgSimilarity: avgSimilarities[i],
      });
    }
  }

  return outliers.sort((a, b) => a.avgSimilarity - b.avgSimilarity);
}

// ============================================================================
// MAIN
// ============================================================================

async function analyzeConsistency(storyDir) {
  const extractionsPath = path.join(storyDir, 'extractions.json');
  const facesDir = path.join(storyDir, 'faces');

  if (!fs.existsSync(extractionsPath)) {
    throw new Error(`Extractions file not found: ${extractionsPath}`);
  }

  const extractions = JSON.parse(fs.readFileSync(extractionsPath, 'utf8'));
  console.log(`\n📊 ArcFace Consistency Analysis`);
  console.log(`   Story: ${extractions.storyTitle}`);
  console.log(`   Characters: ${Object.keys(extractions.characters).length}`);

  const startTime = Date.now();
  const analysis = {
    storyId: extractions.storyId,
    analyzedAt: new Date().toISOString(),
    method: 'arcface',
    characters: {},
    timing: {},
  };

  // Analyze each character
  for (const [charName, charData] of Object.entries(extractions.characters)) {
    const appearances = charData.appearances;

    if (appearances.length < 2) {
      console.log(`\n   ${charName}: Only ${appearances.length} appearance(s), skipping`);
      analysis.characters[charName] = {
        appearances: appearances.length,
        skipped: true,
        reason: 'Not enough appearances for comparison',
      };
      continue;
    }

    console.log(`\n   ${charName}: ${appearances.length} appearances`);

    // Get embeddings for all faces
    const embeddings = [];
    const pageNumbers = [];

    for (const appearance of appearances) {
      const facePath = path.join(storyDir, appearance.faceThumbnailPath);
      if (!fs.existsSync(facePath)) {
        console.log(`      ⚠️  Face not found: ${facePath}`);
        embeddings.push(null);
      } else {
        const embedding = await getArcFaceEmbedding(facePath);
        embeddings.push(embedding);
      }
      pageNumbers.push(appearance.pageNumber);
    }

    // Calculate pairwise similarities
    const similarities = [];
    for (let i = 0; i < embeddings.length; i++) {
      const row = [];
      for (let j = 0; j < embeddings.length; j++) {
        if (i === j) {
          row.push(1.0);
        } else if (embeddings[i] && embeddings[j]) {
          row.push(cosineSimilarity(embeddings[i], embeddings[j]));
        } else {
          row.push(0);
        }
      }
      similarities.push(row);
    }

    // Calculate overall consistency score
    let totalSim = 0;
    let count = 0;
    for (let i = 0; i < similarities.length; i++) {
      for (let j = i + 1; j < similarities.length; j++) {
        totalSim += similarities[i][j];
        count++;
      }
    }
    const overallScore = count > 0 ? totalSim / count : 1;

    // Find outliers
    const outliers = findOutliers(similarities, THRESHOLDS.SAME_PERSON_MEDIUM);

    console.log(`      Overall consistency: ${(overallScore * 100).toFixed(1)}%`);
    if (outliers.length > 0) {
      console.log(`      Outliers: ${outliers.length}`);
      for (const outlier of outliers) {
        const page = pageNumbers[outlier.index];
        console.log(`         - Page ${page}: ${(outlier.avgSimilarity * 100).toFixed(1)}% avg similarity`);
      }
    }

    analysis.characters[charName] = {
      appearances: appearances.length,
      overallConsistency: overallScore,
      pageNumbers,
      outliers: outliers.map(o => ({
        pageNumber: pageNumbers[o.index],
        faceId: appearances[o.index].faceId,
        avgSimilarity: o.avgSimilarity,
        severity: o.avgSimilarity < THRESHOLDS.SIMILAR ? 'high' : 'medium',
      })),
      pairwiseSimilarities: similarities,
    };
  }

  // Timing
  const duration = Date.now() - startTime;
  analysis.timing = {
    totalMs: duration,
    totalSeconds: duration / 1000,
  };
  console.log(`\n⏱️  Analysis completed in ${(duration / 1000).toFixed(1)}s`);

  // Save results
  const outputPath = path.join(storyDir, 'arcface-analysis.json');
  fs.writeFileSync(outputPath, JSON.stringify(analysis, null, 2));
  console.log(`\n✅ Saved analysis to: ${outputPath}`);

  return analysis;
}

// ============================================================================
// CLI
// ============================================================================

async function main() {
  const storyDir = process.argv[2];

  if (!storyDir) {
    console.log('Usage: node scripts/test-arcface-consistency.js <story-output-dir>');
    console.log('');
    console.log('Example:');
    console.log('  node scripts/test-arcface-consistency.js output/story-1737234567890/');
    process.exit(1);
  }

  try {
    await analyzeConsistency(storyDir);
  } catch (err) {
    console.error(`\n❌ Error: ${err.message}`);
    process.exit(1);
  }
}

main();
