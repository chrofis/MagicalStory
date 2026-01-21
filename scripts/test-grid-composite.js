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
const MAX_COLS = 5;
const PADDING = 10;
const LABEL_HEIGHT = 30;

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

    // Add page number label (as simple text overlay)
    const labelSvg = Buffer.from(`
      <svg width="${CELL_SIZE - PADDING * 2}" height="${LABEL_HEIGHT}">
        <rect width="100%" height="100%" fill="white"/>
        <text x="50%" y="70%" text-anchor="middle" font-size="16" font-family="Arial" fill="black">
          Page ${face.pageNumber}
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
        ${characterName} - Face Consistency Grid
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

  const prompt = `You are analyzing a grid of ${faceCount} face images from different pages of a children's storybook.
All faces should be the SAME character.

Each cell is labeled with its page number. Analyze EACH face carefully for these specific features:

1. HAIR COLOR - Is it consistent across all pages? Note any that are lighter/darker/different shade.
2. HAIR STYLE - Is the cut, length, and styling consistent? Note any differences in parting, volume, or shape.
3. FACE SHAPE - Is the face shape (round, oval, etc.) consistent? Note any that look different.
4. EYES - Are eye color, size, and shape consistent? Note any differences.

Compare each face against the majority. Identify ALL pages that don't match.

Respond in JSON format:
{
  "totalFaces": ${faceCount},
  "overallConsistency": 85,
  "majorityFeatures": {
    "hairColor": "medium brown",
    "hairStyle": "short, parted to the side",
    "faceShape": "round",
    "eyes": "blue, medium size"
  },
  "inconsistentPages": [
    {
      "pageNumber": 3,
      "issues": ["hair color is blonde instead of brown", "face shape is more oval"],
      "severity": "high"
    }
  ],
  "summary": "Brief overall assessment"
}

Be thorough - check EVERY page against the majority features.`;

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

    // Create grid image
    const facePaths = appearances.map(a => path.join(storyDir, a.faceThumbnailPath));
    const pageNumbers = appearances.map(a => a.pageNumber);

    console.log(`      Creating grid image...`);
    const grid = await createFaceGrid(facePaths, pageNumbers, charName);

    if (!grid) {
      console.log(`      ❌ Could not create grid`);
      analysis.characters[charName] = {
        appearances: appearances.length,
        error: 'Could not create grid image',
      };
      continue;
    }

    // Save grid image
    const gridPath = path.join(storyDir, `grid-${charName.replace(/\s+/g, '_')}.jpg`);
    fs.writeFileSync(gridPath, grid.buffer);
    console.log(`      Saved grid: ${path.basename(gridPath)}`);

    // Analyze with Gemini
    console.log(`      Calling Gemini API (1 call for all faces)...`);
    const result = await analyzeGridImage(grid.buffer, charName, grid.faces.length);
    totalCalls++;

    if (result.error) {
      console.log(`      ❌ Error: ${result.error}`);
      analysis.characters[charName] = {
        appearances: appearances.length,
        gridPath: path.basename(gridPath),
        error: result.error,
      };
      continue;
    }

    console.log(`      Overall consistency: ${result.overallConsistency}%`);
    if (result.inconsistentPages?.length > 0) {
      console.log(`      Issues found: ${result.inconsistentPages.length}`);
      for (const issue of result.inconsistentPages) {
        console.log(`         - Page ${issue.pageNumber}: ${issue.issues.join(', ')}`);
      }
    }

    // Map results
    const mappedIssues = (result.inconsistentPages || []).map(issue => {
      const appearance = appearances.find(a => a.pageNumber === issue.pageNumber);
      return {
        pageNumber: issue.pageNumber,
        faceId: appearance?.faceId,
        issues: issue.issues,
        severity: issue.severity,
      };
    });

    analysis.characters[charName] = {
      appearances: appearances.length,
      pageNumbers,
      gridPath: path.basename(gridPath),
      overallConsistency: result.overallConsistency / 100,
      consistentFeatures: result.consistentFeatures,
      inconsistentPages: mappedIssues,
      summary: result.summary,
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
