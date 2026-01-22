#!/usr/bin/env node
/**
 * Grid Composite Consistency Test
 *
 * Tests face consistency by compositing all faces into one grid image.
 * Sends a single image to the API (cost-saving approach).
 *
 * Usage:
 *   node scripts/test-grid-composite.js output/story-<id>/
 *
 * Input:
 *   - extractions.json from analyze-story-characters.js
 *   - faces/ folder with extracted face images
 *
 * Output:
 *   - grid-<characterName>.jpg - Composite grid image
 *   - grid-analysis.json - Consistency evaluation
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ============================================================================
// CONFIG
// ============================================================================

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const MODEL = 'gemini-2.0-flash-exp';

// Grid settings
const CELL_SIZE = 200;  // Each face cell
const MAX_COLS = 3;     // Smaller grid for better analysis
const PADDING = 10;
const LABEL_HEIGHT = 30;
const MAX_FACES_PER_GRID = 6;  // Split into batches of 6

// ============================================================================
// GRID CREATION
// ============================================================================

async function createFaceGrid(facePaths, pageNumbers, characterName) {
  const validFaces = [];

  // Load and resize all faces
  for (let i = 0; i < facePaths.length; i++) {
    const facePath = facePaths[i];
    if (fs.existsSync(facePath)) {
      try {
        const resized = await sharp(facePath)
          .resize(CELL_SIZE - PADDING * 2, CELL_SIZE - LABEL_HEIGHT - PADDING * 2, {
            fit: 'contain',
            background: { r: 255, g: 255, b: 255, alpha: 1 },
          })
          .toBuffer();

        validFaces.push({
          buffer: resized,
          pageNumber: pageNumbers[i],
          index: i,
        });
      } catch (err) {
        console.log(`   ⚠️  Could not load: ${facePath}`);
      }
    }
  }

  if (validFaces.length === 0) {
    return null;
  }

  // Calculate grid dimensions
  const cols = Math.min(validFaces.length, MAX_COLS);
  const rows = Math.ceil(validFaces.length / cols);
  const gridWidth = cols * CELL_SIZE;
  const gridHeight = rows * CELL_SIZE + 50;  // Extra space for title

  // Create composite
  const composites = [];

  // Add title text would require SVG overlay - simplified for now
  // We'll add page number labels to each cell instead

  for (let i = 0; i < validFaces.length; i++) {
    const face = validFaces[i];
    const col = i % cols;
    const row = Math.floor(i / cols);

    const x = col * CELL_SIZE + PADDING;
    const y = row * CELL_SIZE + PADDING + 50;  // Offset for title

    composites.push({
      input: face.buffer,
      left: x,
      top: y,
    });

    // Add letter label (A, B, C...) - simpler for AI to read
    const letter = String.fromCharCode(65 + i); // A=65 in ASCII
    const labelSvg = Buffer.from(`
      <svg width="${CELL_SIZE - PADDING * 2}" height="${LABEL_HEIGHT}">
        <rect width="100%" height="100%" fill="white"/>
        <text x="50%" y="70%" text-anchor="middle" font-size="20" font-family="Arial" font-weight="bold" fill="black">
          ${letter}
        </text>
      </svg>
    `);

    composites.push({
      input: labelSvg,
      left: x,
      top: y + CELL_SIZE - LABEL_HEIGHT - PADDING * 2,
    });
  }

  // Create title
  const titleSvg = Buffer.from(`
    <svg width="${gridWidth}" height="50">
      <rect width="100%" height="100%" fill="white"/>
      <text x="50%" y="70%" text-anchor="middle" font-size="24" font-family="Arial" fill="black">
        Face Consistency Grid
      </text>
    </svg>
  `);

  composites.unshift({
    input: titleSvg,
    left: 0,
    top: 0,
  });

  // Generate grid image
  const grid = await sharp({
    create: {
      width: gridWidth,
      height: gridHeight,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .composite(composites)
    .jpeg({ quality: 90 })
    .toBuffer();

  return {
    buffer: grid,
    faces: validFaces,
    cols,
    rows,
  };
}

// ============================================================================
// GEMINI ANALYSIS
// ============================================================================

async function analyzeGridImage(gridBuffer, characterName, faceCount) {
  const model = genAI.getGenerativeModel({ model: MODEL });

  const prompt = `You are analyzing a grid of ${faceCount} face images from a children's storybook.
All faces should be the SAME character.

Each cell is labeled with a letter (A, B, C, etc.). Analyze EACH face carefully for these specific features:

1. HAIR COLOR - Is it consistent? Note any that are lighter/darker/different shade.
2. HAIR STYLE - Is the cut and length consistent? Note any differences.
3. HAIR PARTING - Which direction is the hair parted (left, right, center, forward)? Note any that differ from the majority.
4. FACE SHAPE - Is the face shape (round, oval, etc.) consistent?
5. EYES - Are eye color, size, and shape consistent?

Compare each face against the majority. Identify ALL letters that don't match.

Respond in JSON format:
{
  "totalFaces": ${faceCount},
  "overallConsistency": 85,
  "majorityFeatures": {
    "hairColor": "medium brown",
    "hairStyle": "short",
    "hairParting": "parted to the right",
    "faceShape": "round",
    "eyes": "blue, medium size"
  },
  "inconsistentFaces": [
    {
      "letter": "C",
      "issues": ["hair color is blonde instead of brown", "face shape is more oval"],
      "severity": "high"
    }
  ],
  "summary": "Brief overall assessment"
}

Be thorough - check EVERY face (A through ${String.fromCharCode(64 + faceCount)}) against the majority features.`;

  try {
    const result = await model.generateContent([
      prompt,
      {
        inlineData: {
          mimeType: 'image/jpeg',
          data: gridBuffer.toString('base64'),
        },
      },
    ]);

    const response = await result.response;
    const text = response.text();

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }

    return { error: 'Could not parse response', rawText: text };
  } catch (err) {
    console.error(`Gemini error: ${err.message}`);
    return { error: err.message };
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function analyzeConsistency(storyDir) {
  const extractionsPath = path.join(storyDir, 'extractions.json');

  if (!fs.existsSync(extractionsPath)) {
    throw new Error(`Extractions file not found: ${extractionsPath}`);
  }

  const extractions = JSON.parse(fs.readFileSync(extractionsPath, 'utf8'));
  console.log(`\n📐 Grid Composite Consistency Analysis`);
  console.log(`   Story: ${extractions.storyTitle}`);
  console.log(`   Characters: ${Object.keys(extractions.characters).length}`);

  const startTime = Date.now();
  let totalCalls = 0;

  const analysis = {
    storyId: extractions.storyId,
    analyzedAt: new Date().toISOString(),
    method: 'grid-composite',
    model: MODEL,
    characters: {},
    timing: {},
    apiCalls: 0,
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

    const facePaths = appearances.map(a => path.join(storyDir, a.faceThumbnailPath));
    const pageNumbers = appearances.map(a => a.pageNumber);

    // Split into batches for better analysis
    const numBatches = Math.ceil(appearances.length / MAX_FACES_PER_GRID);
    console.log(`      Splitting into ${numBatches} batch(es) of up to ${MAX_FACES_PER_GRID} faces`);

    const allIssues = [];
    const gridPaths = [];
    let totalConsistency = 0;

    for (let batchIdx = 0; batchIdx < numBatches; batchIdx++) {
      const startIdx = batchIdx * MAX_FACES_PER_GRID;
      const endIdx = Math.min(startIdx + MAX_FACES_PER_GRID, appearances.length);
      const batchFacePaths = facePaths.slice(startIdx, endIdx);
      const batchPageNumbers = pageNumbers.slice(startIdx, endIdx);

      console.log(`      Batch ${batchIdx + 1}: faces ${startIdx + 1}-${endIdx} (pages ${batchPageNumbers.join(', ')})`);

      const grid = await createFaceGrid(batchFacePaths, batchPageNumbers, charName);
      if (!grid) {
        console.log(`         ❌ Could not create grid`);
        continue;
      }

      // Save grid image
      const gridPath = path.join(storyDir, `grid-${charName.replace(/\s+/g, '_')}-batch${batchIdx + 1}.jpg`);
      fs.writeFileSync(gridPath, grid.buffer);
      gridPaths.push(path.basename(gridPath));

      // Analyze with Gemini
      const result = await analyzeGridImage(grid.buffer, charName, grid.faces.length);
      totalCalls++;

      if (result.error) {
        console.log(`         ❌ Error: ${result.error}`);
        continue;
      }

      totalConsistency += result.overallConsistency || 0;

      if (result.inconsistentFaces?.length > 0) {
        console.log(`         Issues: ${result.inconsistentFaces.length}`);
        for (const issue of result.inconsistentFaces) {
          // Map letter back to actual index in this batch, then to global page number
          const batchIndex = issue.letter.charCodeAt(0) - 65;
          const globalIndex = startIdx + batchIndex;
          const pageNum = pageNumbers[globalIndex] || '?';
          console.log(`            - ${issue.letter} (Page ${pageNum}): ${issue.issues.join(', ')}`);

          allIssues.push({
            letter: issue.letter,
            batchIndex: batchIdx + 1,
            pageNumber: pageNum,
            faceId: appearances[globalIndex]?.faceId,
            issues: issue.issues,
            severity: issue.severity,
          });
        }
      } else {
        console.log(`         No issues found`);
      }
    }

    const avgConsistency = numBatches > 0 ? totalConsistency / numBatches : 0;
    console.log(`      Overall consistency: ${avgConsistency.toFixed(0)}%`);
    console.log(`      Total issues: ${allIssues.length}`);

    const mappedIssues = allIssues;

    analysis.characters[charName] = {
      appearances: appearances.length,
      pageNumbers,
      gridPaths,
      overallConsistency: avgConsistency / 100,
      inconsistentPages: mappedIssues,
    };
  }

  // Timing and cost
  const duration = Date.now() - startTime;
  analysis.timing = {
    totalMs: duration,
    totalSeconds: duration / 1000,
  };
  analysis.apiCalls = totalCalls;
  console.log(`\n⏱️  Analysis completed in ${(duration / 1000).toFixed(1)}s`);
  console.log(`   API calls: ${totalCalls} (1 per character instead of 1 per image)`);

  // Save results
  const outputPath = path.join(storyDir, 'grid-analysis.json');
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
    console.log('Usage: node scripts/test-grid-composite.js <story-output-dir>');
    console.log('');
    console.log('Example:');
    console.log('  node scripts/test-grid-composite.js output/story-1737234567890/');
    process.exit(1);
  }

  if (!process.env.GEMINI_API_KEY) {
    console.error('Error: GEMINI_API_KEY not set in environment');
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
