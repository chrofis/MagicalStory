#!/usr/bin/env node
/**
 * Extract Faces from Story Images
 *
 * Uses evaluation data (identity_sync) as primary source for character identification.
 * Falls back to cascade detection + Gemini validation if evaluation data unavailable.
 *
 * Usage:
 *   node scripts/extract-faces.js <storyId>
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const fetch = require('node-fetch');
const sharp = require('sharp');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const PHOTO_ANALYZER_URL = process.env.PHOTO_ANALYZER_URL || 'http://localhost:5000';
const OUTPUT_DIR = path.join(__dirname, '..', 'output');
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const GEMINI_MODEL = 'gemini-2.5-flash';
const DELAY_BETWEEN_CALLS_MS = 7000;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// All faces resized to this size
const TARGET_FACE_SIZE = 256;

// Fallback detection params (more aggressive than before)
const DETECTION_PARAMS = {
  min_size: 15,       // Was 25
  scale_factor: 1.03, // Was 1.05
  min_neighbors: 1
};

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ============================================================================
// PRIMARY: Extract faces using evaluation data
// ============================================================================

function extractFromEvaluation(qualityReasoning, imgWidth, imgHeight) {
  if (!qualityReasoning) return [];

  try {
    const reasoning = typeof qualityReasoning === 'string'
      ? JSON.parse(qualityReasoning)
      : qualityReasoning;

    const faces = [];
    for (const match of (reasoning.identity_sync || [])) {
      if (!match.face_bbox || !match.matched_reference) continue;
      // Skip non-matches
      if (match.matched_reference.toLowerCase().includes('no matching')) continue;
      if (match.matched_reference.toLowerCase().includes('extra character')) continue;

      // Convert normalized [ymin, xmin, ymax, xmax] to pixel box
      const [ymin, xmin, ymax, xmax] = match.face_bbox;
      const box = {
        x: Math.round(xmin * imgWidth),
        y: Math.round(ymin * imgHeight),
        width: Math.round((xmax - xmin) * imgWidth),
        height: Math.round((ymax - ymin) * imgHeight)
      };

      // Extract character name (remove "(Reference X)" suffix if present)
      let charName = match.matched_reference;
      if (charName.includes('(')) {
        charName = charName.split('(')[0].trim();
      }

      faces.push({
        box,
        character: charName,
        confidence: match.confidence || 0.8,
        source: 'evaluation'
      });
    }
    return faces;
  } catch (err) {
    console.error(`      Failed to parse evaluation: ${err.message}`);
    return [];
  }
}

// ============================================================================
// FALLBACK: Cascade detection (with lower thresholds)
// ============================================================================

async function detectFacesWithCascade(base64Image) {
  try {
    const response = await fetch(`${PHOTO_ANALYZER_URL}/detect-anime-faces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image: base64Image,
        min_size: DETECTION_PARAMS.min_size,
        scale_factor: DETECTION_PARAMS.scale_factor,
        min_neighbors: DETECTION_PARAMS.min_neighbors,
      }),
    });
    if (!response.ok) return [];
    const result = await response.json();
    return result.faces || [];
  } catch (err) {
    console.error(`      Cascade error: ${err.message}`);
    return [];
  }
}

function nonMaximumSuppression(faces, iouThreshold = 0.3) {
  if (faces.length <= 1) return faces;
  const sorted = [...faces].sort((a, b) => (b.box.width * b.box.height) - (a.box.width * a.box.height));
  const keep = [];
  for (const face of sorted) {
    const dominated = keep.some(kept => {
      const x1 = Math.max(face.box.x, kept.box.x);
      const y1 = Math.max(face.box.y, kept.box.y);
      const x2 = Math.min(face.box.x + face.box.width, kept.box.x + kept.box.width);
      const y2 = Math.min(face.box.y + face.box.height, kept.box.y + kept.box.height);
      if (x2 <= x1 || y2 <= y1) return false;
      const intersection = (x2 - x1) * (y2 - y1);
      const area1 = face.box.width * face.box.height;
      const area2 = kept.box.width * kept.box.height;
      return intersection / (area1 + area2 - intersection) > iouThreshold;
    });
    if (!dominated) keep.push(face);
  }
  return keep;
}

async function validateFacesWithGemini(imageBuffer, candidateFaces, expectedChars) {
  const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
  const cropImages = [];

  for (let i = 0; i < candidateFaces.length; i++) {
    const box = candidateFaces[i].box;
    try {
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

      cropImages.push({ index: i, data: cropBuffer.toString('base64') });
    } catch (err) {
      // Skip failed crops
    }
  }

  if (cropImages.length === 0) return { validations: [] };

  const charList = expectedChars.length > 0
    ? `Expected characters: ${expectedChars.join(', ')}`
    : 'Character names unknown';

  const contentParts = [
    `I have ${cropImages.length} cropped face regions from a children's book illustration.
${charList}

For EACH region:
1. Is it a usable face? (Accept partial faces, side profiles - reject only backs of heads or completely cut off)
2. Does it have glasses?
3. Which character is it most likely? (based on hair color, features)

JSON only:
{
  "validations": [
    {"regionIndex": 0, "isFace": true, "hasGlasses": false, "likelyCharacter": "Lukas"},
    {"regionIndex": 1, "isFace": false, "reason": "back of head"}
  ]
}`
  ];

  for (const crop of cropImages) {
    contentParts.push(`\n\nRegion ${crop.index}:`);
    contentParts.push({ inlineData: { mimeType: 'image/jpeg', data: crop.data } });
  }

  try {
    const result = await model.generateContent(contentParts);
    const text = (await result.response).text();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
    return { validations: [] };
  } catch (err) {
    console.error(`      Gemini error: ${err.message}`);
    return { validations: [] };
  }
}

// ============================================================================
// Face extraction with consistent sizing
// ============================================================================

async function extractFaceThumbnail(imageBuffer, box) {
  try {
    const metadata = await sharp(imageBuffer).metadata();
    const padding = 0.6;

    // Calculate padded region
    const padX = box.width * padding;
    const padY = box.height * padding;
    let left = Math.round(box.x - padX);
    let top = Math.round(box.y - padY);
    let width = Math.round(box.width + padX * 2);
    let height = Math.round(box.height + padY * 2);

    // For very small detections, expand crop region
    const minCropSize = Math.max(TARGET_FACE_SIZE, metadata.width * 0.15);
    if (width < minCropSize || height < minCropSize) {
      const targetSize = Math.max(width, height, minCropSize);
      const centerX = box.x + box.width / 2;
      const centerY = box.y + box.height / 2;
      left = Math.round(centerX - targetSize / 2);
      top = Math.round(centerY - targetSize / 2);
      width = Math.round(targetSize);
      height = Math.round(targetSize);
    }

    // Clamp to image bounds
    left = Math.max(0, left);
    top = Math.max(0, top);
    width = Math.min(metadata.width - left, width);
    height = Math.min(metadata.height - top, height);

    return await sharp(imageBuffer)
      .extract({ left, top, width, height })
      .resize(TARGET_FACE_SIZE, TARGET_FACE_SIZE, { fit: 'cover' })
      .jpeg({ quality: 90 })
      .toBuffer();
  } catch (err) {
    console.error(`      Failed to extract face: ${err.message}`);
    return null;
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function extractFaces(storyId) {
  console.log(`\n📖 Loading story: ${storyId}`);

  // Load story metadata
  const storyResult = await pool.query('SELECT data FROM stories WHERE id = $1', [storyId]);
  if (storyResult.rows.length === 0) throw new Error(`Story not found: ${storyId}`);
  const story = storyResult.rows[0].data;

  console.log(`   Title: ${story.title}`);
  console.log(`   Characters: ${story.characters?.map(c => c.name).join(', ')}`);

  // Build map of page -> scene data (for qualityReasoning and expected chars)
  const sceneDataByPage = {};
  for (const scene of (story.sceneImages || [])) {
    sceneDataByPage[scene.pageNumber] = {
      qualityReasoning: scene.qualityReasoning,
      expectedChars: (scene.referencePhotos || []).map(p => p.name).filter(Boolean)
    };
  }

  // Load images from story_images table
  const imagesResult = await pool.query(`
    SELECT DISTINCT ON (page_number) page_number, image_data
    FROM story_images
    WHERE story_id = $1 AND image_type = 'scene'
    ORDER BY page_number, version_index DESC
  `, [storyId]);

  console.log(`   Scene images: ${imagesResult.rows.length}`);

  // Create output directory
  const outputDir = path.join(OUTPUT_DIR, `story-${storyId}`);
  const facesDir = path.join(outputDir, 'faces');
  ensureDir(facesDir);

  // Clear old faces
  if (fs.existsSync(facesDir)) {
    fs.rmSync(facesDir, { recursive: true });
  }
  ensureDir(facesDir);

  // Process each page
  const allFaces = [];
  let evalFaces = 0, fallbackFaces = 0;
  console.log(`\n🔍 Processing pages...`);

  for (const row of imagesResult.rows) {
    const pageNum = row.page_number;
    const imageData = row.image_data;
    const sceneData = sceneDataByPage[pageNum] || {};
    const expectedChars = sceneData.expectedChars || [];

    console.log(`\n   Page ${pageNum}: expecting ${expectedChars.join(', ') || 'unknown'}`);

    // Convert base64 to buffer
    const base64 = imageData.replace(/^data:image\/\w+;base64,/, '');
    const imageBuffer = Buffer.from(base64, 'base64');
    const metadata = await sharp(imageBuffer).metadata();
    const imgWidth = metadata.width;
    const imgHeight = metadata.height;

    // PRIMARY: Try evaluation data first
    let faces = extractFromEvaluation(sceneData.qualityReasoning, imgWidth, imgHeight);

    if (faces.length > 0) {
      console.log(`      Evaluation: ${faces.length} faces`);
      evalFaces += faces.length;
    } else {
      // FALLBACK: Use cascade detection
      console.log(`      No evaluation data, using cascade fallback...`);
      let candidates = await detectFacesWithCascade(base64);
      candidates = nonMaximumSuppression(candidates.map(f => ({ box: f.box })));
      console.log(`      Cascade: ${candidates.length} candidates`);

      if (candidates.length > 0) {
        const validation = await validateFacesWithGemini(imageBuffer, candidates, expectedChars);
        await delay(DELAY_BETWEEN_CALLS_MS);

        for (const v of (validation.validations || [])) {
          if (v.isFace && v.regionIndex < candidates.length) {
            faces.push({
              box: candidates[v.regionIndex].box,
              character: v.likelyCharacter || 'unknown',
              confidence: 0.7,
              source: 'fallback'
            });
          }
        }
        fallbackFaces += faces.length;
      }
    }

    console.log(`      Extracting ${faces.length} face(s)...`);

    // Extract and save each face
    for (const face of faces) {
      const faceBuffer = await extractFaceThumbnail(imageBuffer, face.box);
      if (faceBuffer) {
        const charFolder = path.join(facesDir, face.character.replace(/\s+/g, '_'));
        ensureDir(charFolder);
        const filename = `${face.character.replace(/\s+/g, '_')}_page${pageNum}.jpg`;
        const facePath = path.join(charFolder, filename);
        fs.writeFileSync(facePath, faceBuffer);
        console.log(`      ✓ ${face.character} -> ${filename} (${face.source})`);

        allFaces.push({
          character: face.character,
          page: pageNum,
          file: `faces/${face.character.replace(/\s+/g, '_')}/${filename}`,
          confidence: face.confidence,
          source: face.source
        });
      }
    }
  }

  // Summary
  console.log(`\n📊 Summary:`);
  console.log(`   From evaluation: ${evalFaces} faces`);
  console.log(`   From fallback: ${fallbackFaces} faces`);

  const byChar = {};
  for (const f of allFaces) {
    byChar[f.character] = byChar[f.character] || [];
    byChar[f.character].push(f.page);
  }
  for (const [char, pages] of Object.entries(byChar)) {
    console.log(`   ${char}: ${pages.length} faces (pages ${pages.join(', ')})`);
  }

  // Save manifest
  const manifest = {
    storyId,
    storyTitle: story.title,
    extractedAt: new Date().toISOString(),
    totalFaces: allFaces.length,
    fromEvaluation: evalFaces,
    fromFallback: fallbackFaces,
    faces: allFaces,
  };
  const manifestPath = path.join(outputDir, 'faces-manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`\n✅ Saved manifest: ${manifestPath}`);

  return manifest;
}

async function main() {
  const storyId = process.argv[2];
  if (!storyId) {
    console.log('Usage: node scripts/extract-faces.js <storyId>');
    process.exit(1);
  }

  try {
    await extractFaces(storyId);
  } catch (err) {
    console.error(`\n❌ Error: ${err.message}`);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
