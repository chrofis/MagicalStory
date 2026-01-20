#!/usr/bin/env node
/**
 * Character Consistency Analyzer - Main Script
 *
 * Analyzes character consistency across all pages of a story.
 * Extracts face crops, groups by character, and prepares for analysis.
 *
 * Usage:
 *   node scripts/analyze-story-characters.js <storyId>
 *
 * Output:
 *   - output/story-<id>/extractions.json - All extracted faces with metadata
 *   - output/story-<id>/faces/ - Individual face crop images
 *   - output/story-<id>/story-data.json - Story metadata (no images)
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const fetch = require('node-fetch');
const sharp = require('sharp');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ============================================================================
// CONFIG
// ============================================================================

const PHOTO_ANALYZER_URL = process.env.PHOTO_ANALYZER_URL || 'http://localhost:5000';
const OUTPUT_DIR = path.join(__dirname, '..', 'output');

// Gemini setup for face detection
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const GEMINI_MODEL = 'gemini-2.0-flash-exp';

// ============================================================================
// DATABASE
// ============================================================================

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function loadStory(storyId) {
  const result = await pool.query(
    'SELECT data FROM stories WHERE id = $1',
    [storyId]
  );

  if (result.rows.length === 0) {
    throw new Error(`Story not found: ${storyId}`);
  }

  const rawData = result.rows[0].data;
  return typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
}

// ============================================================================
// FACE DETECTION (via photo_analyzer.py)
// ============================================================================

async function detectFacesInImage(imageData) {
  // imageData is base64 with or without data URI prefix
  const base64 = imageData.replace(/^data:image\/\w+;base64,/, '');

  try {
    const response = await fetch(`${PHOTO_ANALYZER_URL}/detect-all-faces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: base64 }),
    });

    if (!response.ok) {
      console.error(`Face detection failed: ${response.status}`);
      return [];
    }

    const result = await response.json();
    return result.faces || [];
  } catch (err) {
    console.error(`Face detection error: ${err.message}`);
    return [];
  }
}

async function compareToReference(faceImage, referenceImage) {
  // Compare a detected face to a reference photo using ArcFace
  try {
    const response = await fetch(`${PHOTO_ANALYZER_URL}/compare-identity`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image1: faceImage.replace(/^data:image\/\w+;base64,/, ''),
        image2: referenceImage.replace(/^data:image\/\w+;base64,/, ''),
      }),
    });

    if (!response.ok) {
      return null;
    }

    return await response.json();
  } catch (err) {
    console.error(`Compare identity error: ${err.message}`);
    return null;
  }
}

// ============================================================================
// HELPERS
// ============================================================================

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function saveImage(base64Data, filePath) {
  const data = base64Data.replace(/^data:image\/\w+;base64,/, '');
  fs.writeFileSync(filePath, Buffer.from(data, 'base64'));
}

async function extractFaceThumbnail(imageBase64, box, padding = 0.3) {
  // Extract face region from image using bounding box
  // box: { x, y, width, height } in pixels
  // padding: extra margin around face (0.3 = 30%)
  try {
    const base64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');
    const imageBuffer = Buffer.from(base64, 'base64');

    // Get image dimensions
    const metadata = await sharp(imageBuffer).metadata();
    const imgWidth = metadata.width;
    const imgHeight = metadata.height;

    // Add padding to bounding box
    const padX = box.width * padding;
    const padY = box.height * padding;

    const left = Math.max(0, Math.round(box.x - padX));
    const top = Math.max(0, Math.round(box.y - padY));
    const width = Math.min(imgWidth - left, Math.round(box.width + padX * 2));
    const height = Math.min(imgHeight - top, Math.round(box.height + padY * 2));

    // Extract face region
    const faceBuffer = await sharp(imageBuffer)
      .extract({ left, top, width, height })
      .jpeg({ quality: 90 })
      .toBuffer();

    return 'data:image/jpeg;base64,' + faceBuffer.toString('base64');
  } catch (err) {
    console.error(`Failed to extract face thumbnail: ${err.message}`);
    return null;
  }
}

function getCharacterReference(character) {
  // Get the best reference photo for a character
  // Priority: face photo > styled avatar > original photo
  const photos = character.photos || {};
  const avatars = character.avatars || {};

  if (photos.face) return photos.face;
  if (avatars.standard) return avatars.standard;
  if (photos.original) return photos.original;

  return null;
}

// ============================================================================
// MAIN ANALYSIS
// ============================================================================

async function analyzeStory(storyId) {
  console.log(`\n📖 Loading story: ${storyId}`);

  // Load story from database
  const story = await loadStory(storyId);
  console.log(`   Title: ${story.title}`);
  console.log(`   Pages: ${story.sceneImages?.length || 0}`);
  console.log(`   Characters: ${story.characters?.length || 0}`);

  // Create output directory
  const storyOutputDir = path.join(OUTPUT_DIR, `story-${storyId}`);
  const facesDir = path.join(storyOutputDir, 'faces');
  ensureDir(facesDir);

  // Build character reference map
  const characterRefs = {};
  for (const char of (story.characters || [])) {
    const ref = getCharacterReference(char);
    if (ref) {
      characterRefs[char.name] = {
        id: char.id,
        name: char.name,
        reference: ref,
      };
      console.log(`   📷 Found reference for: ${char.name}`);
    } else {
      console.log(`   ⚠️  No reference for: ${char.name}`);
    }
  }

  // Process each page
  const extractions = {
    storyId,
    storyTitle: story.title,
    analyzedAt: new Date().toISOString(),
    characters: {},  // Grouped by character name
    pages: [],       // All extractions by page
    existingIssues: story.finalChecksReport?.imageChecks || [],
  };

  const sceneImages = story.sceneImages || [];
  console.log(`\n🔍 Analyzing ${sceneImages.length} scene images...`);

  for (const scene of sceneImages) {
    const pageNum = scene.pageNumber;
    console.log(`\n   Page ${pageNum}:`);

    if (!scene.imageData) {
      console.log(`      ⚠️  No image data, skipping`);
      continue;
    }

    // Get expected characters from referencePhotos
    const expectedChars = (scene.referencePhotos || []).map(p => p.name).filter(Boolean);
    console.log(`      Expected: ${expectedChars.join(', ') || 'none'}`);

    // Detect faces in this image
    const faces = await detectFacesInImage(scene.imageData);
    console.log(`      Detected: ${faces.length} face(s)`);

    const pageExtractions = {
      pageNumber: pageNum,
      expectedCharacters: expectedChars,
      detectedFaces: faces.length,
      extractions: [],
      existingQuality: scene.qualityScore,
      existingFixTargets: scene.fixTargets || [],
    };

    // Get image dimensions for percentage conversion
    const imgBase64 = scene.imageData.replace(/^data:image\/\w+;base64,/, '');
    const imgBuffer = Buffer.from(imgBase64, 'base64');
    const imgMetadata = await sharp(imgBuffer).metadata();
    const imgWidth = imgMetadata.width;
    const imgHeight = imgMetadata.height;

    // Match each detected face to a character
    for (let i = 0; i < faces.length; i++) {
      const face = faces[i];
      const faceId = `page${pageNum}_face${i}`;

      // Extract face thumbnail using bounding box
      // API returns face.box with {x, y, width, height} in pixels
      const box = face.box;
      let faceThumbnail = null;

      if (box && box.width > 0 && box.height > 0) {
        faceThumbnail = await extractFaceThumbnail(scene.imageData, box);
        if (faceThumbnail) {
          const facePath = path.join(facesDir, `${faceId}.jpg`);
          saveImage(faceThumbnail, facePath);
        }
      }

      // Try to match to known characters
      let bestMatch = null;
      let bestScore = 0;

      for (const [charName, charData] of Object.entries(characterRefs)) {
        if (faceThumbnail && charData.reference) {
          const comparison = await compareToReference(
            faceThumbnail,
            charData.reference
          );

          if (comparison && comparison.similarity > bestScore) {
            bestScore = comparison.similarity;
            bestMatch = {
              characterName: charName,
              characterId: charData.id,
              similarity: comparison.similarity,
              confidence: comparison.confidence,
              samePerson: comparison.same_person,
            };
          }
        }
      }

      // Convert bounding box to percentages
      const boundingBox = box ? {
        x: box.x / imgWidth,
        y: box.y / imgHeight,
        width: box.width / imgWidth,
        height: box.height / imgHeight,
      } : null;

      const extraction = {
        faceId,
        pageNumber: pageNum,
        faceIndex: i,
        boundingBox,  // {x, y, width, height} as percentages (0-1)
        confidence: face.confidence,
        match: bestMatch,
        faceThumbnailPath: `faces/${faceId}.jpg`,
      };

      pageExtractions.extractions.push(extraction);

      // Group by character
      // For illustrated stories, the similarity to real photos is low
      // Accept any match above a minimum threshold for grouping
      const MIN_SIMILARITY_THRESHOLD = 0.05;  // Very low for illustrated faces
      const isConfidentMatch = bestMatch && bestMatch.samePerson;
      const isProbableMatch = bestMatch && bestScore > MIN_SIMILARITY_THRESHOLD;

      if (isConfidentMatch || isProbableMatch) {
        const charName = bestMatch.characterName;
        if (!extractions.characters[charName]) {
          extractions.characters[charName] = {
            characterId: bestMatch.characterId,
            appearances: [],
          };
        }
        extractions.characters[charName].appearances.push(extraction);
        const marker = isConfidentMatch ? '✓' : '~';
        console.log(`      ${marker} Face ${i}: ${charName} (${(bestScore * 100).toFixed(1)}%)`);
      } else if (bestMatch) {
        console.log(`      ? Face ${i}: maybe ${bestMatch.characterName} (${(bestScore * 100).toFixed(1)}%)`);
      } else {
        console.log(`      ✗ Face ${i}: no match`);
      }
    }

    extractions.pages.push(pageExtractions);
  }

  // Summary
  console.log(`\n📊 Summary:`);
  for (const [charName, data] of Object.entries(extractions.characters)) {
    const pages = data.appearances.map(a => a.pageNumber);
    console.log(`   ${charName}: ${data.appearances.length} appearances (pages ${pages.join(', ')})`);
  }

  // Save extractions
  const extractionsPath = path.join(storyOutputDir, 'extractions.json');
  fs.writeFileSync(extractionsPath, JSON.stringify(extractions, null, 2));
  console.log(`\n✅ Saved extractions to: ${extractionsPath}`);

  // Save story metadata (without image data)
  const storyMetadata = {
    id: story.id,
    title: story.title,
    pages: story.pages,
    language: story.language,
    artStyle: story.artStyle,
    characters: (story.characters || []).map(c => ({
      id: c.id,
      name: c.name,
      age: c.age,
      gender: c.gender,
    })),
    finalChecksReport: story.finalChecksReport,
    clothingRequirements: story.clothingRequirements,
  };

  const metadataPath = path.join(storyOutputDir, 'story-metadata.json');
  fs.writeFileSync(metadataPath, JSON.stringify(storyMetadata, null, 2));
  console.log(`   Saved metadata to: ${metadataPath}`);

  return extractions;
}

// ============================================================================
// CLI
// ============================================================================

async function main() {
  const storyId = process.argv[2];

  if (!storyId) {
    console.log('Usage: node scripts/analyze-story-characters.js <storyId>');
    console.log('');
    console.log('Example:');
    console.log('  node scripts/analyze-story-characters.js 1737234567890');
    process.exit(1);
  }

  try {
    await analyzeStory(storyId);
  } catch (err) {
    console.error(`\n❌ Error: ${err.message}`);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
