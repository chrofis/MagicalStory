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
const GEMINI_MODEL = 'gemini-2.5-flash';  // Better spatial reasoning than 2.0

// Rate limiting - Gemini 2.0 flash-exp has 10 requests/min limit
const DELAY_BETWEEN_CALLS_MS = 7000;  // 7 seconds = ~8.5 requests/min (safe margin)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

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
// FACE DETECTION (Hybrid: Anime Cascade + Gemini)
// ============================================================================

function computeIoU(box1, box2) {
  // Compute Intersection over Union between two boxes
  const x1 = Math.max(box1.x, box2.x);
  const y1 = Math.max(box1.y, box2.y);
  const x2 = Math.min(box1.x + box1.width, box2.x + box2.width);
  const y2 = Math.min(box1.y + box1.height, box2.y + box2.height);

  if (x2 <= x1 || y2 <= y1) return 0;

  const intersection = (x2 - x1) * (y2 - y1);
  const area1 = box1.width * box1.height;
  const area2 = box2.width * box2.height;
  const union = area1 + area2 - intersection;

  return union > 0 ? intersection / union : 0;
}

function isContained(inner, outer) {
  // Check if inner box is mostly contained within outer box (>70% overlap)
  const x1 = Math.max(inner.x, outer.x);
  const y1 = Math.max(inner.y, outer.y);
  const x2 = Math.min(inner.x + inner.width, outer.x + outer.width);
  const y2 = Math.min(inner.y + inner.height, outer.y + outer.height);

  if (x2 <= x1 || y2 <= y1) return false;

  const intersection = (x2 - x1) * (y2 - y1);
  const innerArea = inner.width * inner.height;

  return intersection / innerArea > 0.5;  // 50% of smaller box is inside larger
}

function nonMaximumSuppression(faces, iouThreshold = 0.2) {
  // Remove overlapping detections, keeping larger boxes
  if (faces.length <= 1) return faces;

  // Sort by area (larger first)
  const sorted = [...faces].sort((a, b) => {
    const areaA = a.box.width * a.box.height;
    const areaB = b.box.width * b.box.height;
    return areaB - areaA;
  });

  const keep = [];
  for (const face of sorted) {
    // Check if this face overlaps with OR is contained in any kept face
    const dominated = keep.some(kept =>
      computeIoU(face.box, kept.box) > iouThreshold || isContained(face.box, kept.box)
    );
    if (!dominated) keep.push(face);
  }

  return keep;
}

async function detectFacesWithAnimeCascade(imageData) {
  // Use anime cascade for accurate bounding boxes
  const base64 = imageData.replace(/^data:image\/\w+;base64,/, '');

  try {
    const response = await fetch(`${PHOTO_ANALYZER_URL}/detect-anime-faces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image: base64,
        min_size: 25,
        scale_factor: 1.05,
        min_neighbors: 1,  // Sensitive to catch all faces
      }),
    });

    if (!response.ok) {
      console.error(`Anime cascade failed: ${response.status}`);
      return { faces: [], imageSize: null };
    }

    const result = await response.json();
    return {
      faces: result.faces || [],
      imageSize: result.image_size,
    };
  } catch (err) {
    console.error(`Anime cascade error: ${err.message}`);
    return { faces: [], imageSize: null };
  }
}

async function validateFacesWithGemini(imageData, candidateFaces) {
  // Use Gemini ONLY to validate which candidates are real faces
  // Character identification is done separately using evaluation data
  const base64 = imageData.replace(/^data:image\/\w+;base64,/, '');
  const imageBuffer = Buffer.from(base64, 'base64');
  const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });

  // Extract cropped images for each candidate
  const cropImages = [];
  for (let i = 0; i < candidateFaces.length; i++) {
    const f = candidateFaces[i];
    const box = f.box;
    try {
      // Add padding around the detection (60% = doubled from 30%)
      const metadata = await sharp(imageBuffer).metadata();
      const pad = Math.round(box.width * 0.6);
      const left = Math.max(0, box.x - pad);
      const top = Math.max(0, box.y - pad);
      const width = Math.min(metadata.width - left, box.width + pad * 2);
      const height = Math.min(metadata.height - top, box.height + pad * 2);

      const cropBuffer = await sharp(imageBuffer)
        .extract({ left, top, width, height })
        .jpeg({ quality: 80 })
        .toBuffer();

      cropImages.push({
        index: i,
        data: cropBuffer.toString('base64'),
      });
    } catch (err) {
      console.log(`      Failed to crop region ${i}: ${err.message}`);
    }
  }

  if (cropImages.length === 0) {
    return { validations: [] };
  }

  // Build content array with all cropped images
  const contentParts = [
    `I have ${cropImages.length} cropped regions from a children's book illustration.

For EACH region, determine:
1. Is it a CLEAR, USABLE FACE?
2. Does the MAIN face in the image wear GLASSES? (yes/no)

REJECT (isFace: false) if:
- Full body shot where face is cut off or not clearly visible
- Only a tiny partial face (just eyes, just mouth, less than half face visible)
- A framed picture/photo hanging on a wall (not an actual character in the scene)
- Too blurry or small to identify facial features
- Shows body/clothing but face is out of frame

ACCEPT (isFace: true) only if:
- The face is the main subject and clearly visible
- You can see at least eyes AND nose AND mouth
- It's a character in the scene (not a picture within the picture)

IMPORTANT: For "hasGlasses", look at the MAIN/CENTRAL face only, not background faces.

JSON only:
{
  "validations": [
    {"regionIndex": 0, "isFace": true, "hasGlasses": true, "description": "boy with glasses"},
    {"regionIndex": 1, "isFace": true, "hasGlasses": false, "description": "boy without glasses"},
    {"regionIndex": 2, "isFace": false, "reason": "full body shot, face cut off"}
  ]
}`
  ];

  // Add each cropped image
  for (const crop of cropImages) {
    contentParts.push(`\n\nRegion ${crop.index}:`);
    contentParts.push({
      inlineData: {
        mimeType: 'image/jpeg',
        data: crop.data,
      },
    });
  }

  try {
    const result = await model.generateContent(contentParts);
    const response = await result.response;
    const text = response.text();

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }

    return { validations: [] };
  } catch (err) {
    console.error(`Gemini validation error: ${err.message}`);
    return { validations: [] };
  }
}

async function detectFacesHybrid(imageData) {
  // Step 1: Get candidate faces from anime cascade (accurate bounding boxes)
  let { faces: candidates, imageSize } = await detectFacesWithAnimeCascade(imageData);

  if (candidates.length === 0) {
    console.log('      No candidates from anime cascade');
    return [];
  }

  // Step 1b: Remove overlapping detections (same face detected multiple times)
  const beforeNMS = candidates.length;
  candidates = nonMaximumSuppression(candidates, 0.3);
  const removed = beforeNMS - candidates.length;
  console.log(`      Anime cascade: ${beforeNMS} candidates${removed > 0 ? ` (${removed} overlaps removed)` : ''}`);

  // Step 2: Validate with Gemini (filter false positives only - no character identification)
  const validation = await validateFacesWithGemini(imageData, candidates);

  // Step 3: Combine results - keep only validated faces with cascade bounding boxes
  const validFaces = [];
  for (const v of (validation.validations || [])) {
    if (v.isFace && v.regionIndex < candidates.length) {
      const candidate = candidates[v.regionIndex];
      validFaces.push({
        box: candidate.box,  // Pixel coordinates from cascade
        confidence: 0.9,
        description: v.description,
        hasGlasses: v.hasGlasses,  // Key trait for character identification
        index: validFaces.length,
      });
    }
  }

  console.log(`      Validated: ${validFaces.length} real faces`);
  return validFaces;
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
// CHARACTER IDENTIFICATION BY TRAITS
// ============================================================================

function buildCharacterTraits(characters) {
  // Build a map of character traits for identification
  // Returns: { "Noel": { hasGlasses: true, hairColor: "blonde" }, "Luis": { hasGlasses: false, hairColor: "light brown" } }
  const traits = {};
  for (const char of (characters || [])) {
    const physical = char.physical || {};
    traits[char.name] = {
      hasGlasses: (physical.other || '').toLowerCase().includes('glasses') ||
                  (physical.face || '').toLowerCase().includes('glasses'),
      hairColor: physical.hairColor || physical.hair || null,
    };
  }
  return traits;
}

function assignCharactersByTraits(faces, characterTraits, expectedCharacters) {
  // Assign characters based on physical traits (primarily glasses)
  // RULE: Each character can only be assigned ONCE per image
  if (!faces.length || !Object.keys(characterTraits).length) return faces;

  // Find which character has glasses
  const charWithGlasses = Object.entries(characterTraits)
    .filter(([name]) => expectedCharacters.includes(name))
    .find(([, traits]) => traits.hasGlasses)?.[0];
  const charWithoutGlasses = Object.entries(characterTraits)
    .filter(([name]) => expectedCharacters.includes(name))
    .find(([, traits]) => !traits.hasGlasses)?.[0];

  const assignedCharacters = new Set();
  const duplicateIssues = [];

  for (const face of faces) {
    let targetChar = null;

    if (face.hasGlasses === true && charWithGlasses) {
      targetChar = charWithGlasses;
      face.assignmentSource = 'traits-glasses';
    } else if (face.hasGlasses === false && charWithoutGlasses) {
      targetChar = charWithoutGlasses;
      face.assignmentSource = 'traits-no-glasses';
    }

    if (targetChar) {
      if (assignedCharacters.has(targetChar)) {
        // DUPLICATE: This character was already assigned to another face
        face.assignedCharacter = targetChar;
        face.isDuplicate = true;
        face.assignmentIssue = `GENERATOR ERROR: Multiple faces look like ${targetChar}`;
        duplicateIssues.push(`${targetChar} appears multiple times`);
      } else {
        face.assignedCharacter = targetChar;
        assignedCharacters.add(targetChar);
      }
    }
  }

  // Check for missing characters
  for (const expectedChar of expectedCharacters) {
    if (!assignedCharacters.has(expectedChar)) {
      // Character expected but not found in any face
      duplicateIssues.push(`${expectedChar} not detected in any face`);
    }
  }

  return { faces, issues: duplicateIssues };
}

// ============================================================================
// CHARACTER POSITION MATCHING (fallback)
// ============================================================================

function parseEvaluationData(qualityReasoning) {
  // Parse the evaluation's identity_sync to get character bounding boxes and assignments
  // Returns array of: { figure, character, confidence, issues, faceBbox }
  if (!qualityReasoning) return [];

  try {
    const reasoning = typeof qualityReasoning === 'string'
      ? JSON.parse(qualityReasoning)
      : qualityReasoning;

    const identitySync = reasoning.identity_sync || [];
    const figures = [];

    for (const match of identitySync) {
      // Extract character name from "Noel (Reference 2)" format
      const charName = match.matched_reference ? match.matched_reference.split(' (')[0] : null;
      if (!charName) continue;

      // Get face bounding box if available (format: [ymin, xmin, ymax, xmax] normalized 0-1)
      const faceBbox = match.face_bbox || null;

      figures.push({
        figure: match.figure,
        character: charName,
        confidence: match.confidence || 0,
        issues: match.issues || [],
        faceBbox,  // [ymin, xmin, ymax, xmax] or null
      });
    }

    return figures;
  } catch (err) {
    return [];
  }
}

function bboxDistance(faceBox, evalBbox, imgWidth, imgHeight) {
  // Calculate distance between detected face center and evaluation bbox center
  // faceBox: {x, y, width, height} in pixels
  // evalBbox: [ymin, xmin, ymax, xmax] normalized 0-1
  if (!evalBbox) return Infinity;

  // Convert face box to normalized center
  const faceCenterX = (faceBox.x + faceBox.width / 2) / imgWidth;
  const faceCenterY = (faceBox.y + faceBox.height / 2) / imgHeight;

  // Get evaluation bbox center (format: [ymin, xmin, ymax, xmax])
  const evalCenterX = (evalBbox[1] + evalBbox[3]) / 2;
  const evalCenterY = (evalBbox[0] + evalBbox[2]) / 2;

  // Euclidean distance
  return Math.sqrt(Math.pow(faceCenterX - evalCenterX, 2) + Math.pow(faceCenterY - evalCenterY, 2));
}

function assignCharactersFromEvaluation(faces, evaluationFigures, imgWidth, imgHeight) {
  // Match detected faces to evaluation figures using nearest neighbor on face_bbox
  // RULE: Each character can only be assigned once
  if (!faces.length || !evaluationFigures.length) return faces;

  // Filter to only main characters - skip background figures like "Alter Ritter"
  const mainFigures = evaluationFigures.filter(f =>
    f.character && !f.character.includes('Alter') && !f.character.includes('Reference')
  );

  if (mainFigures.length === 0) return faces;

  // Match each face to nearest evaluation bbox (greedy nearest neighbor)
  const usedFigures = new Set();

  for (const face of faces) {
    let closestFigure = null;
    let closestDistance = Infinity;

    for (const figure of mainFigures) {
      if (usedFigures.has(figure.figure)) continue;  // Each character only once

      const distance = bboxDistance(face.box, figure.faceBbox, imgWidth, imgHeight);
      if (distance < closestDistance) {
        closestDistance = distance;
        closestFigure = figure;
      }
    }

    if (closestFigure) {
      face.assignedCharacter = closestFigure.character;
      face.assignmentSource = 'evaluation-bbox';
      face.assignmentConfidence = closestFigure.confidence;
      face.evaluationIssues = closestFigure.issues;
      face.bboxDistance = closestDistance;
      usedFigures.add(closestFigure.figure);
    }
  }

  return faces;
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

async function extractFaceThumbnail(imageBase64, box, padding = 0.6) {
  // Extract face region from image using bounding box
  // box: { x, y, width, height } in pixels
  // padding: extra margin around face (0.6 = 60%)
  try {
    const base64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');
    const imageBuffer = Buffer.from(base64, 'base64');

    // Get image dimensions
    const metadata = await sharp(imageBuffer).metadata();
    const imgWidth = metadata.width;
    const imgHeight = metadata.height;

    // For small face detections, use more aggressive padding
    // Minimum crop should be at least 10% of image dimension
    const minCropRatio = 0.10;
    const minCropWidth = imgWidth * minCropRatio;
    const minCropHeight = imgHeight * minCropRatio;

    // Calculate padding - use more for small faces
    let effectivePadding = padding;
    if (box.width < minCropWidth || box.height < minCropHeight) {
      // Small detection: calculate padding to reach minimum size
      const neededPadX = Math.max(0, (minCropWidth - box.width) / 2);
      const neededPadY = Math.max(0, (minCropHeight - box.height) / 2);
      effectivePadding = Math.max(padding, neededPadX / box.width, neededPadY / box.height);
    }

    const padX = box.width * effectivePadding;
    const padY = box.height * effectivePadding;

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

  // Build character traits for identification (glasses, hair color, etc.)
  const characterTraits = buildCharacterTraits(story.characters);
  for (const [name, traits] of Object.entries(characterTraits)) {
    console.log(`   🔍 Traits for ${name}: glasses=${traits.hasGlasses}, hair=${traits.hairColor}`);
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

    // Get image dimensions for position calculation
    const imgBase64 = scene.imageData.replace(/^data:image\/\w+;base64,/, '');
    const imgBuffer = Buffer.from(imgBase64, 'base64');
    const imgMetadata = await sharp(imgBuffer).metadata();
    const imgWidth = imgMetadata.width;
    const imgHeight = imgMetadata.height;

    // Parse evaluation data (for issues and fallback position matching)
    const evaluationFigures = parseEvaluationData(scene.qualityReasoning);

    // Detect faces using hybrid approach (anime cascade + Gemini validation for face filtering only)
    let faces = await detectFacesHybrid(scene.imageData);

    // PRIMARY: Assign characters using evaluation's face_bbox (nearest neighbor matching)
    // RULE: Each character can only be assigned once per image
    assignCharactersFromEvaluation(faces, evaluationFigures, imgWidth, imgHeight);

    // FALLBACK: For any unassigned faces, use trait-based matching (glasses detection)
    const unassignedFaces = faces.filter(f => !f.assignedCharacter);
    let assignmentIssues = [];
    if (unassignedFaces.length > 0) {
      const traitResult = assignCharactersByTraits(unassignedFaces, characterTraits, expectedChars);
      assignmentIssues = traitResult.issues || [];
    }

    console.log(`      Final: ${faces.length} face(s)`);
    if (assignmentIssues.length > 0) {
      console.log(`      ⚠️  ASSIGNMENT ISSUES: ${assignmentIssues.join('; ')}`);
    }

    // Rate limiting delay for Gemini
    await delay(DELAY_BETWEEN_CALLS_MS);
    for (const face of faces) {
      const charName = face.assignedCharacter || 'unknown';
      const source = face.assignmentSource || 'unknown';
      const duplicate = face.isDuplicate ? ' [DUPLICATE]' : '';
      console.log(`         - ${charName} (${source}): ${face.description || 'no description'}${duplicate}`);
    }

    const pageExtractions = {
      pageNumber: pageNum,
      expectedCharacters: expectedChars,
      detectedFaces: faces.length,
      extractions: [],
      assignmentIssues,  // e.g., "Multiple faces look like Noel", "Luis not detected"
      existingQuality: scene.qualityScore,
      existingFixTargets: scene.fixTargets || [],
    };

    // Process each detected face
    for (let i = 0; i < faces.length; i++) {
      const face = faces[i];
      const faceId = `page${pageNum}_face${i}`;

      // Anime cascade returns box in pixels, use directly
      const box = face.box;
      let faceThumbnail = null;

      // Use character from evaluation data
      const assignedChar = face.assignedCharacter;

      if (box && box.width > 0 && box.height > 0) {
        // Box is already in pixels from anime cascade
        const pixelBox = {
          x: Math.round(box.x),
          y: Math.round(box.y),
          width: Math.round(box.width),
          height: Math.round(box.height),
        };
        faceThumbnail = await extractFaceThumbnail(scene.imageData, pixelBox);
        if (faceThumbnail) {
          // Save to character folder if character is known, otherwise to 'unknown'
          const charFolder = assignedChar ? assignedChar.replace(/\s+/g, '_') : 'unknown';
          const charFacesDir = path.join(facesDir, charFolder);
          ensureDir(charFacesDir);
          const facePath = path.join(charFacesDir, `${faceId}.jpg`);
          saveImage(faceThumbnail, facePath);
        }
      }
      let bestMatch = null;

      if (assignedChar && characterRefs[assignedChar]) {
        bestMatch = {
          characterName: assignedChar,
          characterId: characterRefs[assignedChar].id,
          source: 'evaluation',
          confidence: face.assignmentConfidence,
          issues: face.evaluationIssues,
          description: face.description,
        };
      }

      // Convert bounding box to normalized 0-1 range for storage
      const boundingBox = box ? {
        x: box.x / imgWidth,
        y: box.y / imgHeight,
        width: box.width / imgWidth,
        height: box.height / imgHeight,
      } : null;

      // Build the face thumbnail path with character folder
      const charFolder = assignedChar ? assignedChar.replace(/\s+/g, '_') : 'unknown';
      const faceThumbnailPath = `faces/${charFolder}/${faceId}.jpg`;

      const extraction = {
        faceId,
        pageNumber: pageNum,
        faceIndex: i,
        boundingBox,  // {x, y, width, height} as normalized percentages (0-1)
        confidence: face.confidence,
        description: face.description,
        assignedCharacter: assignedChar,
        assignmentSource: face.assignmentSource || 'unknown',
        assignmentConfidence: face.assignmentConfidence,
        evaluationIssues: face.evaluationIssues || [],
        match: bestMatch,
        faceThumbnailPath,
      };

      pageExtractions.extractions.push(extraction);

      // Group by character
      const hasMatch = bestMatch !== null;
      if (hasMatch) {
        const charName = bestMatch.characterName;
        if (!extractions.characters[charName]) {
          extractions.characters[charName] = {
            characterId: bestMatch.characterId,
            appearances: [],
          };
        }
        extractions.characters[charName].appearances.push(extraction);
        console.log(`      ✓ Face ${i}: ${charName}`);
      } else if (assignedChar) {
        // Character guessed but not in our reference list
        console.log(`      ? Face ${i}: ${assignedChar} (not in character list)`);
      } else {
        console.log(`      ✗ Face ${i}: unidentified`);
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
